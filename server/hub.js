import { existsSync, lstatSync, statSync } from 'fs';
import { mkdir, rename } from 'fs/promises';
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
const HEALTH_TIMEOUT_MS = 1500;
const OPERATION_LINES = 400;
// What leaves a game freshly started, and so worth a new picture of
const FRESH_STARTS = ['turn on', 'restart', 'update', 'reset'];
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
	const operations = new Map();
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

		return { operation, done };
	};

	const step = async (log, argv, cwd) => {
		log(`$ ${argv.join(' ')}`);

		const { code } = await run(argv, { cwd, onLine: log });

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
				args: ['--host', exposure.sshHost, '--remote', String(ports.remote), '--local', String(record.port)],
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

		// A port given it already, by shelf-game's drop-in, is kept; otherwise one is handed out
		record.port ??= (await units.portOf(gameUnit(record.id))) ?? freePort();
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

	return {
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
			const next = { ...record, ...pick(changes, ['name', 'port', 'databases', 'cover']) };

			if (next.cover != null && typeof next.cover !== 'string') throw new ValidationError('A cover is a picture path');

			if (typeof next.name !== 'string' || !next.name.trim()) throw new ValidationError('A game needs a name');
			checkPort(next.port, id);
			if (
				!Array.isArray(next.databases) ||
				next.databases.some(file => typeof file !== 'string' || !path.isAbsolute(file))
			)
				throw new ValidationError('Save files are absolute paths');

			const portChanged = next.port !== record.port;

			// Only a name sent and different from the game's own makes it the hub's; a change of port or cover leaves it
			const renamed =
				record.renamed || (changes.name !== undefined && next.name.trim() !== (await readLook(record)).title);

			games()[id] = { ...next, name: next.name.trim(), renamed };
			await db.write();

			// The running unit still has the old port in it; a fresh start writes the new one
			if (portChanged && (await units.state(gameUnit(id))).active) {
				await startGame(games()[id], () => {});
				if (record.exposed) await startTunnel(games()[id], () => {});
			}

			return status(games()[id]);
		},

		forget: async id => {
			const record = game(id);

			if (operations.get(id)?.running) throw new BusyError(`${record.name} is busy`);

			// Its tunnel was the hub's; its bun-server@ unit is dotfiles', and stays as it is, on or off
			await units.removeTunnel(tunnelUnit(id));
			await shots?.forget(id);

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

		// Pulls, installs and builds. Any step failing stops it there, and the running game is left alone: still the code
		// it was started with, since it's only restarted once everything before it worked.
		update: id =>
			operate(id, 'update', async (record, log) => {
				// An arcade game shelved from the folder it's built in has nothing to pull from; what's there is built
				const { code: tracking } = await run(['git', '-C', record.dir, 'rev-parse', '--abbrev-ref', '@{u}']);

				if (tracking === 0) await step(log, ['git', 'pull', '--ff-only'], record.dir);
				else log('No upstream to pull from; building what is here');

				// Frozen, as dotfiles installs them: a plain install rewrites bun.lock when the framework drifts ahead of it,
				// and the dirty file stops every pull after
				const locked = ['bun.lock', 'bun.lockb'].some(file => existsSync(path.join(record.dir, file)));

				await step(log, [bun, 'install', ...(locked ? ['--frozen-lockfile'] : [])], record.dir);
				if (record.hasBuild) await step(log, [bun, 'run', 'build'], record.dir);

				if ((await units.state(gameUnit(id))).active) {
					log('Restarting');
					await units.restart(gameUnit(id));
				}

				log('✓ Up to date');
			}),

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

				const wasActive = (await units.state(gameUnit(id))).active;

				if (wasActive) await units.stop(gameUnit(id));

				const aside = path.join(resetsDir, id, now().toISOString().replace(/[:.]/g, '-'));

				if (saves.length > 0) {
					await mkdir(aside, { recursive: true });

					for (const file of saves) {
						await rename(file, path.join(aside, path.basename(file)));
						log(`Moved ${file} to ${aside}`);
					}
				} else log('No save file yet; nothing to move');

				if (wasActive) await startGame(record, log);

				log('✓ Reset');
			}),

		expose: id =>
			operate(id, 'expose', async (record, log) => {
				if (!exposure.sshHost || !exposure.publicHost)
					throw new Error('Exposing needs the VPS: give the hub MOTHER_HUB_VPS_HOST and MOTHER_HUB_PUBLIC_HOST');

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

const pick = (object, keys) =>
	Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
