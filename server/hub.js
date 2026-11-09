import { existsSync, lstatSync, statSync } from 'fs';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import path from 'path';

import { ValidationError } from '@vanilla-bean/components/app';

import { detectGame } from './detect';
import { readDocs } from './docs';
import { readLook } from './look';
import { gameUnit, tunnelUnit } from './units';

// Ports handed to games that don't come with one of their own (the scaffold's games). Kept clear of paude's arcade
// shelf (3100-3999), so a game the arcade is still building and one served here never fight over a port.
const ASSIGNED_PORTS = [4100, 4199];
const GIT_CACHE_MS = 30_000;
// A fetch or rev-parse that takes longer is a network or disk that's stuck, and the round moves on
const GIT_TIMEOUT_MS = 2 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 1500;
const OPERATION_LINES = 400;
// What leaves a game freshly started, and so worth a new picture of
const FRESH_STARTS = ['turn on', 'restart', 'update', 'reset', 'host'];
// How soon the night's round looks again at a game still waiting on its players
const RETRY_WAITING_MS = 60 * 60 * 1000;
// How often the bun-server@ units are looked through for games the hub hasn't met
const DISCOVER_MS = 30_000;
// How long a started game is given to answer before its picture is given up on
const START_WAIT_MS = 30_000;
// The live picture's path among a game's pictures, for choosing it as the cover
export const LIVE = 'live';
// What web-game-framework's Server answers with its status (its STATUS_PATH)
const STATUS_PATH = '/.well-known/web-game';

class BusyError extends Error {
	status = 409;
}

class NotFoundError extends Error {
	status = 404;
}

class GoneError extends Error {
	status = 410;
}

// What the hub does to games: keeps the list, starts and stops them, updates, resets and exposes them, and says how
// each one is doing. Everything it touches outside its database goes through units (systemd), run (commands) and
// probe (HTTP), so tests hand it fakes.
export const createHub = ({
	db,
	units,
	run,
	probe,
	shots = null,
	projectsRoot,
	selfId = null,
	lanUrl = () => null,
	// The port the LAN's name `<name>.home` is given to, if it's given to anything
	lanNamePort = () => null,
	// The hub's own port, which is never a game's to open to the internet
	selfPort = null,
	// Where this machine keeps its LAN names, and what makes them names (both optional)
	lanNames = {},
	hubDir,
	resetsDir,
	exposure,
	now = () => new Date(),
	startWaitMs = START_WAIT_MS,
	// The hub's own: under bun-server@, PATH doesn't know ~/.bun/bin
	bun = process.execPath,
}) => {
	const games = () => db.data.games;
	// Games forgotten here, which looking through the units mustn't bring back
	const ignored = () => (db.data.ignored ||= []);
	// Games paude hosted that were forgotten here: paude is refused them until it hosts one again on purpose
	const forgottenHosted = () => (db.data.forgottenHosted ||= []);
	// The operation under way on a game, to its end
	const finishing = new Map();
	const waitFor = id => finishing.get(id);
	const operations = new Map();
	// Why a game meant to update itself hasn't yet, while that's so: someone's playing it
	const updateWaiting = new Map();
	const gitCache = new Map();

	const game = id => {
		const record = games()[id];

		if (!record) throw new NotFoundError(`No game "${id}"`);

		return record;
	};

	const freePort = () => {
		const taken = new Set(Object.values(games()).map(record => record.port));

		for (let port = ASSIGNED_PORTS[0]; port <= ASSIGNED_PORTS[1]; port++) if (!taken.has(port)) return port;

		throw new ValidationError('Every port the hub hands out is taken');
	};

	const checkPort = (port, id) => {
		if (!Number.isInteger(port) || port < 1024 || port > 65535)
			throw new ValidationError('A port is a whole number from 1024 to 65535');

		if (port === selfPort) throw new ValidationError(`Port ${port} is the hub's own`);

		const holder = Object.values(games()).find(record => record.port === port && record.id !== id);

		if (holder) throw new ValidationError(`${holder.name} already uses port ${port}`);
	};

	const tunnelPorts = slot => ({
		public: exposure.publicPortBase + slot,
		remote: exposure.tunnelPortBase + slot,
	});

	const publicUrl = record =>
		record.exposeSlot && exposure.publicHost
			? `https://${exposure.publicHost}:${tunnelPorts(record.exposeSlot).public}`
			: null;

	// One operation at a time per game: a second press while an update runs would race it over the same checkout. It
	// throws at once for a game that isn't there or is busy, and otherwise runs on after returning, the page following
	// along through the game's status; done settles when it ends, failed or not.
	const operate = (id, kind, work) => {
		const record = game(id);

		if (operations.get(id)?.running) throw new BusyError(`${record.name} is busy: ${operations.get(id).kind}`);

		const operation = { kind, running: true, startedAt: now().toISOString(), lines: [] };
		const log = line => {
			operation.lines.push(line);
			if (operation.lines.length > OPERATION_LINES) operation.lines.shift();
		};

		operations.set(id, operation);

		const done = (async () => {
			try {
				await work(record, log);
				operation.ok = true;
				if (FRESH_STARTS.includes(kind)) photograph(record);
			} catch (error) {
				operation.ok = false;
				operation.error = error.message;
				log(`✗ ${error.message}`);
			} finally {
				operation.running = false;
				operation.endedAt = now().toISOString();
				gitCache.delete(id);
			}

			return operation;
		})();

		finishing.set(id, done);

		return { operation, done };
	};

	const step = async (log, argv, cwd) => {
		log(`$ ${argv.join(' ')}`);

		// Steps run the game's own scripts (install, build) and the names refresh: none of them gets the hub's secrets
		const { code } = await run(argv, { cwd, onLine: log, plain: true });

		if (code !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} failed (exit ${code})`);
	};

	const gitInfo = async record => {
		const cached = gitCache.get(record.id);

		if (cached && now() - cached.at < GIT_CACHE_MS) return cached.info;

		const git = async (...argv) => {
			const { code, output } = await run(['git', '-C', record.dir, ...argv]);

			return code === 0 ? output.trim() : null;
		};

		const [branch, last, status, behind] = await Promise.all([
			git('rev-parse', '--abbrev-ref', 'HEAD'),
			git('log', '-1', '--format=%h%x09%cr%x09%s'),
			// Edits to what the repo tracks, which is what stands in a pull's way; builds and installs leave the rest
			git('status', '--porcelain', '--untracked-files=no'),
			git('rev-list', '--count', 'HEAD..@{u}'),
		]);

		const [commit, age, subject] = last?.split('\t') ?? [];
		const info = branch
			? { branch, commit, age, subject, dirty: !!status, behind: behind === null ? null : Number(behind) }
			: null;

		gitCache.set(record.id, { at: now(), info });

		return info;
	};

	const photographing = new Set();

	// A picture of the game as it is now, once it answers; a game that never does, or no Chrome, means no picture
	const photograph = async record => {
		if (!shots?.available || photographing.has(record.id)) return false;

		photographing.add(record.id);

		try {
			const url = `http://127.0.0.1:${record.port}/`;
			const until = Date.now() + startWaitMs;

			while (!(await probe(url, HEALTH_TIMEOUT_MS)).ok) {
				if (Date.now() > until || !(await units.state(gameUnit(record.id))).active) return false;
				await Bun.sleep(1000);
			}

			return await shots.take(record.id, url);
		} finally {
			photographing.delete(record.id);
		}
	};

	const livePicture = record => {
		const file = shots?.file(record.id);

		if (!file) return null;

		const taken = statSync(file).mtime;

		return {
			file,
			path: LIVE,
			url: `/api/games/${encodeURIComponent(record.id)}/shot?v=${taken.getTime()}`,
			alt: `As it was when it last started, ${taken.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`,
		};
	};

	// The README's pictures, then the live one
	const pictures = (record, docs) => [...docs.media, livePicture(record)].filter(Boolean);

	const status = async record => {
		const [unit, tunnel, answer, git, look, docs] = await Promise.all([
			units.state(gameUnit(record.id)),
			record.exposeSlot ? units.state(tunnelUnit(record.id)) : null,
			// Any answer at all means it's up; a game on the framework answers with how it's doing besides
			probe(`http://127.0.0.1:${record.port}${STATUS_PATH}`, HEALTH_TIMEOUT_MS),
			gitInfo(record),
			readLook(record),
			readDocs(record),
		]);
		const operation = operations.get(record.id);

		return {
			...record,
			// The game's own name, from its manifest, follows it as it changes, until it's renamed here
			name: record.renamed ? record.name : (look.title ?? record.name),
			unit,
			tunnel,
			health: { ok: answer.ok },
			report: unit.active ? answer.report : null,
			git,
			about: {
				blurb: docs.blurb,
				cover: coverOf(pictures(record, docs), record.cover),
				pictures: pictures(record, docs).length,
				hasReadme: !!docs.markdown,
			},
			look: {
				...look,
				icon: look.icon ? `/api/games/${encodeURIComponent(record.id)}/icon?v=${look.iconVersion}` : null,
			},
			// Its name on the LAN (dotfiles' lan-names), else its port on this machine's
			lanUrl: lanUrl(record.port),
			publicUrl: record.exposed ? publicUrl(record) : null,
			autoUpdate: !!record.autoUpdate,
			updateWaiting: updateWaiting.get(record.id) ?? null,
			operation: operation && { ...operation, lines: operation.lines.slice(-60) },
		};
	};

	const startGame = (record, log) =>
		units.startGame(
			record.id,
			{ port: record.port, portVia: record.portVia, defaultPort: record.defaultPort ?? null },
			log,
		);

	const startTunnel = async (record, log) => {
		const ports = tunnelPorts(record.exposeSlot);

		await units.startTunnel(
			tunnelUnit(record.id),
			{
				description: `${record.name} exposed on the VPS at :${ports.public} (web-game-mother-hub)`,
				cwd: hubDir,
				entry: 'server/tunnel.js',
				args: [
					'--host',
					exposure.sshHost,
					'--remote',
					String(ports.remote),
					'--local',
					String(record.port),
					...(exposure.identity ? ['--identity', exposure.identity] : []),
				],
			},
			log,
		);
	};

	const add = async (dir, overrides = {}) => {
		const detected = await detectGame(dir);
		const { title } = await readLook(detected);
		const record = {
			...detected,
			// The name the game gives itself, in its manifest or page title, over one made from its folder
			name: title ?? detected.name,
			// A house game's own port, which it runs on with no drop-in
			defaultPort: detected.portVia === 'flag' ? detected.port : null,
			...pick(overrides, ['name', 'port', 'databases']),
			exposed: false,
			exposeSlot: null,
		};

		// bun-server@<folder> runs ~/Projects/<folder>, so that's where a game the hub runs lives
		if (path.dirname(record.dir) !== projectsRoot)
			throw new ValidationError(`The hub runs games from folders in ${projectsRoot}, as bun-server@ does`);
		if (games()[record.id]) throw new ValidationError(`${games()[record.id].name} is already here`);

		// A port given it already is kept: one asked for here, else shelf-game's drop-in, else the one it's running on
		// now, else the one its package names; only a game with none of those is handed one
		const dropIn = await units.portOf(gameUnit(record.id));
		const listening = await units.listeningPort(gameUnit(record.id));

		// A house game running on its own with no drop-in is running on its own default
		if (record.portVia === 'flag' && record.defaultPort == null && !dropIn) record.defaultPort = listening;

		record.port = overrides.port ?? dropIn ?? listening ?? detected.port ?? freePort();
		checkPort(record.port, record.id);

		db.data.ignored = ignored().filter(id => id !== record.id);
		games()[record.id] = record;
		await db.write();

		return status(record);
	};

	// The bun-server@ units systemd knows, the games dotfiles' game-servers runs and the arcade's shelf-game puts there,
	// each listed here as soon as it's seen, unless it was forgotten here
	let discoveredAt = 0;

	const discover = async () => {
		if (Date.now() - discoveredAt < DISCOVER_MS) return;

		discoveredAt = Date.now();

		for (const id of await units.instances()) {
			if (games()[id] || ignored().includes(id) || id === selfId) continue;

			const dir = path.join(projectsRoot, id);

			if (!existsSync(path.join(dir, 'package.json'))) continue;

			await add(dir).catch(error => console.warn(`Not listing bun-server@${id}: ${error.message}`));
		}
	};

	// Pulls, installs and builds. Any step failing stops it there, and the running game is left alone: still the code
	// it was started with, since it's only restarted once everything before it worked.
	// Frozen, as dotfiles installs them: a plain install rewrites bun.lock when the framework drifts ahead of it, and the
	// dirty file stops every pull after
	const build = async (record, log) => {
		const locked = ['bun.lock', 'bun.lockb'].some(file => existsSync(path.join(record.dir, file)));

		await step(log, [bun, 'install', ...(locked ? ['--frozen-lockfile'] : [])], record.dir);
		if (record.hasBuild) await step(log, [bun, 'run', 'build'], record.dir);
	};

	const update = id =>
		operate(id, 'update', async (record, log) => {
			// A game hosted from paude's arcade has nothing to pull from (paude sends it); what's there is built
			const { code: tracking } = await run(['git', '-C', record.dir, 'rev-parse', '--abbrev-ref', '@{u}']);

			const before = (await gitOut(record, 'rev-parse', 'HEAD')) ?? null;

			if (tracking === 0) await step(log, ['git', 'pull', '--ff-only'], record.dir);
			else log('No upstream to pull from; building what is here');

			try {
				await build(record, log);
			} catch (error) {
				// A pull whose install or build failed is taken back, so the next restart doesn't run new code on old
				// dependencies and the card still says the update is waiting. --keep won't touch local edits.
				if (tracking === 0 && before) {
					log(`Taking the pull back to ${before.slice(0, 7)}`);
					await run(['git', '-C', record.dir, 'reset', '--keep', before]);
				}

				throw error;
			}

			if ((await units.state(gameUnit(id))).active) {
				log('Restarting');
				await units.restart(gameUnit(id));
			}

			log('✓ Up to date');
		});

	// A game's name on the LAN, where the machine has one to give (dotfiles' lan-names on the htpc): a `name=port` file
	// in the names folder, and the command that makes them names
	// Rewriting the names restarts the house's DNS, so it's done only when this game's name or port is new
	const nameOnLan = async (record, log) => {
		if (!lanNames.dir) return;

		const file = path.join(lanNames.dir, `${record.id}.conf`);
		const line = `${record.id}=${record.port}\n`;

		if ((await readFile(file, 'utf8').catch(() => null)) === line) return;

		await mkdir(lanNames.dir, { recursive: true });
		await writeFile(file, line);

		if (lanNames.refresh) await step(log, ['sh', '-c', lanNames.refresh], hubDir);
	};

	const dropLanName = async (record, log) => {
		if (!lanNames.dir || !existsSync(path.join(lanNames.dir, `${record.id}.conf`))) return;

		await rm(path.join(lanNames.dir, `${record.id}.conf`), { force: true });

		if (lanNames.refresh) await step(log, ['sh', '-c', lanNames.refresh], hubDir);
	};

	// Built, started (or restarted), and named: what hosting does with a game's folder once it's here
	const hostHere = async (record, log) => {
		await build(record, log);

		if ((await units.state(gameUnit(record.id))).active) {
			log('Restarting');
			await units.restart(gameUnit(record.id));
		} else await startGame(record, log);

		await nameOnLan(record, log);
		log('✓ Hosted');
	};

	// Whether anyone's on a game: what it says of itself (a framework game's status), or else the connections open to
	// its port, so a game that doesn't report (game-night) isn't taken for empty
	const playing = async record => {
		if (!(await units.state(gameUnit(record.id))).active) return false;

		const { report } = await probe(`http://127.0.0.1:${record.port}${STATUS_PATH}`, HEALTH_TIMEOUT_MS);

		return report ? report.connections > 0 : (await units.connectionsTo(record.port)) > 0;
	};

	// Hosting runs on after the answer, which says it began (or, asked to wait for an idle game that has players, that
	// it's waiting: the new code is in, the rebuild and restart wait for them to go or the night's round). The caller
	// follows the game's operation to see it end.
	const hostFolder = async (id, target, { whenIdle = false } = {}) => {
		const record = games()[id] ?? (await add(target).then(() => games()[id]));
		const answer = { id, name: record.name, port: record.port, url: lanUrl(record.port) };

		record.hosted = 'paude';

		if (whenIdle && (await playing(record))) {
			record.pendingHost = true;
			updateWaiting.set(id, 'players');
			await db.write();

			return { ...answer, deferred: true };
		}

		record.pendingHost = false;
		await db.write();

		const { operation } = operate(id, 'host', (current, log) => hostHere(current, log));

		return { ...answer, operation: { kind: operation.kind, startedAt: operation.startedAt } };
	};

	// What hosting refuses: a name the house already gives something else (hub.home, arcade.home), and a game that
	// was forgotten here, until it's hosted again on purpose
	const refuseToHost = (id, again) => {
		const takenPort = lanNamePort(id);

		if (id === selfId || (takenPort && takenPort !== games()[id]?.port))
			throw new ValidationError(`${id}.home is already the house's; name the game something else`);

		if (forgottenHosted().includes(id) && !again)
			throw new GoneError(`${id} was forgotten in the mother hub; host it again on purpose to bring it back`);

		if (again) db.data.forgottenHosted = forgottenHosted().filter(each => each !== id);
	};

	const gitOut = async (record, ...argv) => {
		const { code, output } = await run(['git', '-C', record.dir, ...argv], { timeout: GIT_TIMEOUT_MS });

		return code === 0 ? output.trim() : null;
	};

	// One pass over every game: each with an upstream is fetched, so its card says what's waiting, and, when it's the
	// night's round, each set to update itself does, unless someone's playing it (it waits for them to go) or the same
	// upstream already failed to update (it waits for a new one, rather than failing on the same commit every night).
	// Resolves to whether any game is still waiting on its players.
	const autoUpdateRound = async ({ updating = true } = {}) => {
		for (const record of Object.values(games())) {
			if (operations.get(record.id)?.running) continue;

			// A hosting that waited for its players goes ahead once they've gone
			if (updating && record.pendingHost) {
				if (await playing(record)) continue;

				updateWaiting.delete(record.id);
				await hostFolder(record.id, record.dir)
					.then(answer => answer.operation && operations.get(record.id) && waitFor(record.id))
					.catch(error => console.error(`Hosting ${record.id} failed`, error));
				continue;
			}

			const upstream =
				(await gitOut(record, 'rev-parse', '@{u}')) && (await gitOut(record, 'fetch', '--quiet')) !== null;

			if (!upstream) continue;

			gitCache.delete(record.id);

			const behind = Number(await gitOut(record, 'rev-list', '--count', 'HEAD..@{u}')) || 0;
			const target = await gitOut(record, 'rev-parse', '@{u}');

			if (!updating || !record.autoUpdate || behind === 0 || target === record.autoUpdateFailedAt) {
				updateWaiting.delete(record.id);
				continue;
			}

			if (await playing(record)) {
				updateWaiting.set(record.id, 'players');
				continue;
			}

			updateWaiting.delete(record.id);

			// Someone pressed something on this game while the round was looking at it: theirs goes first
			let started;

			try {
				started = update(record.id);
			} catch (error) {
				if (error instanceof BusyError) continue;
				throw error;
			}

			const operation = await started.done;

			record.autoUpdateFailedAt = operation.ok ? null : target;
			await db.write();
		}

		return updateWaiting.size > 0;
	};

	return {
		autoUpdateRound,

		// paude's arcade putting a game with the house's: hosted in place when the hub sees the same repo at the same
		// commit (the same machine), and otherwise asking for it as a git bundle (hostBundle), which works from anywhere
		host: async ({ name, dir, head, whenIdle = false, again = false }) => {
			const id = hostedName(name);
			const target = path.join(projectsRoot, id);

			refuseToHost(id, again);
			const here =
				dir &&
				path.resolve(dir) === target &&
				existsSync(target) &&
				(await gitOut({ dir: target }, 'rev-parse', 'HEAD'));

			if (!here || here !== head) return { needsBundle: true };

			return hostFolder(id, target, { whenIdle });
		},

		// The game's repo as a bundle: cloned into the projects folder the first time, brought forward after
		hostBundle: async (name, bundleFile, { whenIdle = false, again = false } = {}) => {
			const id = hostedName(name);
			const target = path.join(projectsRoot, id);
			const record = games()[id];
			// A game forgotten here and hosted again on purpose finds its old folder still its own
			const wasHosted = record?.hosted === 'paude' || (again && forgottenHosted().includes(id));

			refuseToHost(id, again);

			if (!existsSync(target)) {
				const { code, output } = await run(['git', 'clone', '--quiet', bundleFile, target]);

				if (code !== 0) throw new ValidationError(`The game couldn't be unpacked: ${output}`);
				// The bundle is gone once this is done; the game's next version comes the same way
				await run(['git', '-C', target, 'remote', 'remove', 'origin']);
			} else if (!wasHosted) {
				throw new ValidationError(`${target} is already here, and isn't a game paude hosted`);
			} else {
				const fetched = await run(['git', '-C', target, 'fetch', '--quiet', bundleFile, 'HEAD']);
				const merged = fetched.code === 0 && (await run(['git', '-C', target, 'merge', '--ff-only', 'FETCH_HEAD']));

				if (!merged || merged.code !== 0)
					throw new ValidationError(`${id}'s new version doesn't follow on from the one here`);
			}

			return hostFolder(id, target, { whenIdle });
		},

		// The night's round at `at` (HH:MM, local time) every night from now on, and again an hour later while a game
		// is still waiting on its players; returns what stops them
		startNightlyUpdates: at => {
			let timer;

			const schedule = delay => {
				timer = setTimeout(async () => {
					const waiting = await autoUpdateRound().catch(error => {
						console.error('The nightly update round failed', error);

						return false;
					});

					schedule(waiting ? RETRY_WAITING_MS : untilNext(at, now()));
				}, delay);
			};

			schedule(untilNext(at, now()));

			return () => clearTimeout(timer);
		},

		list: async () => {
			await discover();

			return Promise.all(Object.values(games()).map(status));
		},

		get: async id => status(game(id)),

		hub: () => ({
			exposure: { ...exposure, configured: !!(exposure.sshHost && exposure.publicHost) },
			shots: !!shots?.available,
		}),

		add: async ({ dir, ...overrides }) => add(dir, overrides),

		edit: async (id, changes) => {
			const record = game(id);

			// An operation holds the game's record (an expose marks it open); changing it underneath would lose that
			if (operations.get(id)?.running) throw new BusyError(`${record.name} is busy: ${operations.get(id).kind}`);

			const next = { ...record, ...pick(changes, ['name', 'port', 'databases', 'cover', 'autoUpdate']) };
			const { title } = await readLook(record);

			// An empty name hands the name back to the game's own manifest
			if (changes.name !== undefined && !String(changes.name).trim()) next.name = title ?? record.name;

			if (typeof (next.autoUpdate ?? false) !== 'boolean') throw new ValidationError('Auto-update is on or off');

			if (next.cover != null && typeof next.cover !== 'string') throw new ValidationError('A cover is a picture path');

			if (typeof next.name !== 'string' || !next.name.trim()) throw new ValidationError('A game needs a name');
			checkPort(next.port, id);
			if (
				!Array.isArray(next.databases) ||
				next.databases.some(file => typeof file !== 'string' || !path.isAbsolute(file))
			)
				throw new ValidationError('Save files are absolute paths');

			const portChanged = next.port !== record.port;

			// A name sent and different from the game's own makes it the hub's; an empty or matching one gives it back;
			// a change of port or cover leaves it as it was
			const renamed = changes.name === undefined ? !!record.renamed : next.name.trim() !== title;

			Object.assign(record, next, { name: next.name.trim(), renamed });
			await db.write();

			// The running unit still has the old port in it; a fresh start writes the new one
			if (portChanged && (await units.state(gameUnit(id))).active) {
				await startGame(record, () => {});
				if (record.exposed) await startTunnel(record, () => {});
			}

			// A game the hub named has its name follow it to the new port
			if (portChanged && record.hosted === 'paude') await nameOnLan(record, () => {});

			return status(record);
		},

		forget: async id => {
			const record = game(id);

			if (operations.get(id)?.running) throw new BusyError(`${record.name} is busy`);

			// Its tunnel was the hub's. A game paude hosted is the hub's too: it's stopped, its name taken back, and
			// paude told not to host it again. A house game's bun-server@ unit is dotfiles', and stays as it is.
			await units.removeTunnel(tunnelUnit(id));
			await shots?.forget(id);

			if (record.hosted === 'paude') {
				await units.stop(gameUnit(id));
				await dropLanName(record, () => {});
				forgottenHosted().push(id);
			}

			ignored().push(id);
			delete games()[id];
			await db.write();
		},

		turnOn: id =>
			operate(id, 'turn on', async (record, log) => {
				await startGame(record, log);
				// Turning it off closed its tunnel too; still meant to be open, it opens again with it
				if (record.exposed) await startTunnel(record, log);
			}),

		turnOff: id =>
			operate(id, 'turn off', async record => {
				await units.stop(gameUnit(id));
				// Nothing to reach on the other end of a tunnel to a stopped game
				if (record.exposed) await units.stop(tunnelUnit(id));
			}),

		restart: id => operate(id, 'restart', () => units.restart(gameUnit(id))),

		update: id => update(id),

		// Fetches, so the status shows how far behind its upstream the game is
		check: id =>
			operate(id, 'check for updates', async (record, log) => {
				await step(log, ['git', 'fetch', '--quiet'], record.dir);
			}),

		// The save files are moved aside, not deleted: a reset regretted the next morning is a folder to move back
		reset: id =>
			operate(id, 'reset', async (record, log) => {
				if (record.databases.length === 0)
					throw new Error('No save file is known for this game; add one in its settings');

				// A save that's a link is kept somewhere else on purpose (game-night's library lives in priv-config), and
				// moving the link would only break that
				const linked = record.databases.filter(file => existsSync(file) && lstatSync(file).isSymbolicLink());
				const saves = record.databases.filter(file => existsSync(file) && !linked.includes(file));

				for (const file of linked) log(`${file} is a link to a file kept elsewhere; leaving it`);

				// Nothing to move, nothing to stop the game for
				if (saves.length === 0) {
					log(
						linked.length > 0
							? 'Its only saves are kept elsewhere; nothing moved'
							: 'No save file yet; nothing to move',
					);

					return;
				}

				const wasActive = (await units.state(gameUnit(id))).active;

				if (wasActive) await units.stop(gameUnit(id));

				const aside = path.join(resetsDir, id, now().toISOString().replace(/[:.]/g, '-'));

				await mkdir(aside, { recursive: true });

				for (const file of saves) {
					await rename(file, path.join(aside, path.basename(file)));
					log(`Moved ${file} to ${aside}`);
				}

				if (wasActive) await startGame(record, log);

				log('✓ Reset');
			}),

		expose: id =>
			operate(id, 'expose', async (record, log) => {
				if (!exposure.sshHost || !exposure.publicHost)
					throw new Error('Exposing needs the VPS: give the hub MOTHER_HUB_VPS_HOST and MOTHER_HUB_PUBLIC_HOST');

				// Only the game's own port goes out: never the hub's, nor one the LAN names for something else
				const namedFor = lanUrl(record.port) && new URL(lanUrl(record.port)).hostname.replace(/\.home$/, '');

				if (record.port === selfPort || (namedFor && namedFor !== record.id && lanNamePort(record.id) !== record.port))
					throw new Error(
						`Port ${record.port} is ${namedFor ? `${namedFor}.home's` : "the hub's"}, not ${record.name}'s`,
					);

				if (!record.exposeSlot) {
					const taken = new Set(Object.values(games()).map(other => other.exposeSlot));
					const slot = Array.from({ length: exposure.slots }, (_, index) => index + 1).find(n => !taken.has(n));

					if (!slot) throw new Error(`All ${exposure.slots} public ports are in use; close another game first`);

					// Kept for good, so a game's public address is the same every game night
					record.exposeSlot = slot;
				}

				await startTunnel(record, log);

				record.exposed = true;
				await db.write();

				log(`✓ Open at ${publicUrl(record)}`);
			}),

		conceal: id =>
			operate(id, 'close to the internet', async record => {
				await units.stop(tunnelUnit(id));

				record.exposed = false;
				await db.write();
			}),

		concealAll: async () => {
			const open = Object.values(games()).filter(record => record.exposed);

			await Promise.all(open.map(record => units.stop(tunnelUnit(record.id))));

			for (const record of open) record.exposed = false;
			await db.write();

			return open.length;
		},

		// The tunnel's lines follow the game's, for an exposed game: that's where the VPS says why it refused
		icon: async id => (await readLook(game(id))).icon,

		// The README, its pictures pointed at the hub, for the game's page
		docs: async id => {
			const record = game(id);
			const docs = await readDocs(record);

			return {
				markdown: docs.markdown,
				media: pictures(record, docs).map(({ url, alt, path: file }) => ({ url, alt, path: file })),
			};
		},

		media: async (id, index) => (await readDocs(game(id))).media[index]?.file ?? null,

		shot: id => shots?.file(game(id).id) ?? null,

		// A fresh picture now, of a game that's running
		photograph: async id => {
			const record = game(id);

			if (!shots?.available) throw new ValidationError('No Chrome here to take pictures with (set CHROME)');
			if (!(await units.state(gameUnit(id))).active) throw new ValidationError(`${record.name} is off`);

			return photograph(record);
		},

		logs: async (id, lines) => {
			const record = game(id);
			const logs = await units.logs(gameUnit(id), lines);

			if (!record.exposeSlot) return logs;

			return `${logs}\n\n── tunnel to the VPS ──\n${await units.logs(tunnelUnit(id), Math.min(lines, 50))}`;
		},
	};
};

// The card's cover: the picture chosen for it here, or else the README's first of the game being played (the house
// READMEs caption those "Play: ..."), or else its first that isn't a logo, which is square and crops badly across a
// card, or else the hub's own live picture
const coverOf = (media, chosen) => {
	const named = item => `${item.alt} ${path.basename(item.file)}`;
	const readme = media.filter(item => item.path !== LIVE);
	const picture =
		media.find(item => item.path === chosen) ??
		readme.find(item => /^play\b/i.test(item.alt)) ??
		readme.find(item => !/\b(logo|icon|banner)\b/i.test(named(item))) ??
		readme[0] ??
		media.find(item => item.path === LIVE);

	return picture ? { url: picture.url, alt: picture.alt, path: picture.path } : null;
};

// How long from `from` until the next `at` o'clock (HH:MM, local time): today's if it's still ahead, else tomorrow's
export const untilNext = (at, from = new Date()) => {
	const [hours, minutes] = String(at).split(':').map(Number);
	const next = new Date(from);

	next.setHours(hours, minutes || 0, 0, 0);
	if (next <= from) next.setDate(next.getDate() + 1);

	return next - from;
};

// A hosted game's id is its folder's name: letters, digits and dashes
const hostedName = name => {
	const id = String(name ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '');

	if (!id) throw new ValidationError('A hosted game needs a name');

	return id;
};

const pick = (object, keys) =>
	Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
