import { existsSync } from 'fs';
import { mkdir, rename } from 'fs/promises';
import path from 'path';

import { ValidationError } from '@vanilla-bean/components/app';

import { detectGame } from './detect';
import { tunnelUnit } from './units';

// Ports handed to games that don't come with one of their own (the scaffold's games). Kept clear of paude's arcade
// shelf (3100-3999), so a game the arcade is still building and one served here never fight over a port.
const ASSIGNED_PORTS = [4100, 4199];
const GIT_CACHE_MS = 30_000;
const HEALTH_TIMEOUT_MS = 1500;
const OPERATION_LINES = 400;

class BusyError extends Error {
	status = 409;
}

class NotFoundError extends Error {
	status = 404;
}

// What the hub does to games: keeps the list, starts and stops them, updates, resets and exposes them, and says how
// each one is doing. Everything it touches outside its database goes through units (systemd), run (commands) and
// probe (HTTP), so tests hand it fakes.
export const createHub = ({ db, units, run, probe, hubDir, resetsDir, exposure, now = () => new Date() }) => {
	const games = () => db.data.games;
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

	const definition = record => ({
		description: `${record.name} (web-game-mother-hub)`,
		cwd: record.dir,
		entry: record.entry,
		args: record.portVia === 'flag' ? ['--port', String(record.port)] : [],
		env: record.portVia === 'env' ? { PORT: String(record.port) } : {},
	});

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
			git('status', '--porcelain'),
			git('rev-list', '--count', 'HEAD..@{u}'),
		]);

		const [commit, age, subject] = last?.split('\t') ?? [];
		const info = branch
			? { branch, commit, age, subject, dirty: !!status, behind: behind === null ? null : Number(behind) }
			: null;

		gitCache.set(record.id, { at: now(), info });

		return info;
	};

	const status = async record => {
		const [unit, tunnel, health, git] = await Promise.all([
			units.state(record.id),
			record.exposeSlot ? units.state(tunnelUnit(record.id)) : null,
			probe(`http://127.0.0.1:${record.port}/`, HEALTH_TIMEOUT_MS),
			gitInfo(record),
		]);
		const operation = operations.get(record.id);

		return {
			...record,
			unit,
			tunnel,
			health,
			git,
			publicUrl: record.exposed ? publicUrl(record) : null,
			operation: operation && { ...operation, lines: operation.lines.slice(-60) },
		};
	};

	// The first start notes whether the game's unit was the hub's to make or already there (made by the game's own
	// `service:enable`), so forgetting the game takes away only what the hub put there
	const startGame = async (record, log) => {
		if (!record.unitOrigin) {
			record.unitOrigin = (await units.state(record.id)).installed ? 'adopted' : 'hub';
			await db.write();
		}

		await units.start(record.id, definition(record), log);
	};

	const startTunnel = async (record, log) => {
		const ports = tunnelPorts(record.exposeSlot);

		await units.start(
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

	return {
		list: async () => Promise.all(Object.values(games()).map(status)),

		get: async id => status(game(id)),

		hub: () => ({ exposure: { ...exposure, configured: !!(exposure.sshHost && exposure.publicHost) } }),

		add: async ({ dir, ...overrides }) => {
			const detected = await detectGame(dir);
			const record = {
				...detected,
				...pick(overrides, ['name', 'port', 'databases']),
				exposed: false,
				exposeSlot: null,
			};

			if (games()[record.id]) throw new ValidationError(`${games()[record.id].name} is already here`);
			if (Object.values(games()).some(other => other.dir === record.dir))
				throw new ValidationError(`${record.dir} is already here`);

			record.port ??= freePort();
			checkPort(record.port, record.id);

			games()[record.id] = record;
			await db.write();

			return status(record);
		},

		edit: async (id, changes) => {
			const record = game(id);
			const next = { ...record, ...pick(changes, ['name', 'port', 'databases']) };

			if (typeof next.name !== 'string' || !next.name.trim()) throw new ValidationError('A game needs a name');
			checkPort(next.port, id);
			if (
				!Array.isArray(next.databases) ||
				next.databases.some(file => typeof file !== 'string' || !path.isAbsolute(file))
			)
				throw new ValidationError('Save files are absolute paths');

			const portChanged = next.port !== record.port;

			games()[id] = { ...next, name: next.name.trim() };
			await db.write();

			// The running unit still has the old port in it; a fresh start writes the new one
			if (portChanged && (await units.state(id)).active) {
				await startGame(games()[id], () => {});
				if (record.exposed) await startTunnel(games()[id], () => {});
			}

			return status(games()[id]);
		},

		forget: async id => {
			const record = game(id);

			if (operations.get(id)?.running) throw new BusyError(`${record.name} is busy`);

			await units.remove(tunnelUnit(id));
			if (record.unitOrigin === 'hub') await units.remove(id);

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
				await units.stop(id);
				// Nothing to reach on the other end of a tunnel to a stopped game
				if (record.exposed) await units.stop(tunnelUnit(id));
			}),

		restart: id => operate(id, 'restart', () => units.restart(id)),

		// Pulls, installs and builds. Any step failing stops it there, and the running game is left alone: still the code
		// it was started with, since it's only restarted once everything before it worked.
		update: id =>
			operate(id, 'update', async (record, log) => {
				await step(log, ['git', 'pull', '--ff-only'], record.dir);
				await step(log, ['bun', 'install'], record.dir);
				if (record.hasBuild) await step(log, ['bun', 'run', 'build'], record.dir);

				if ((await units.state(id)).active) {
					log('Restarting');
					await units.restart(id);
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

				const saves = record.databases.filter(file => existsSync(file));

				const wasActive = (await units.state(id)).active;

				if (wasActive) await units.stop(id);

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
					throw new Error('Exposing needs the VPS: start the hub with --vps-host and --public-host');

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
		logs: async (id, lines) => {
			const record = game(id);
			const logs = await units.logs(id, lines);

			if (!record.exposeSlot) return logs;

			return `${logs}\n\n── tunnel to the VPS ──\n${await units.logs(tunnelUnit(id), Math.min(lines, 50))}`;
		},
	};
};

const pick = (object, keys) =>
	Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
