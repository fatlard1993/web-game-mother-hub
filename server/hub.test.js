import { existsSync } from 'fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { findCandidates } from './detect';
import { createHub } from './hub';

let root;

const fakeDb = () => ({ data: { games: {} }, write: async () => {} });

// A systemd that keeps its units in a map: started is active and enabled, stopped is neither
const fakeUnits = () => {
	const units = new Map();
	const calls = [];

	return {
		units,
		calls,
		state: async name => {
			const unit = units.get(name);

			return {
				installed: !!unit,
				active: !!unit?.active,
				state: unit?.active ? 'active' : 'inactive',
				enabled: !!unit?.active,
				restarts: 0,
				since: null,
			};
		},
		start: async (name, definition) => {
			calls.push(['start', name, definition]);
			units.set(name, { active: true, definition });
		},
		stop: async name => {
			calls.push(['stop', name]);
			if (units.has(name)) units.get(name).active = false;
		},
		restart: async name => calls.push(['restart', name]),
		remove: async name => {
			calls.push(['remove', name]);
			units.delete(name);
		},
		logs: async name => `logs of ${name}`,
	};
};

const makeGame = async (name, { scaffold = false, scripts = {} } = {}) => {
	const dir = path.join(root, name);

	await mkdir(path.join(dir, scaffold ? '.' : 'server'), { recursive: true });
	await writeFile(path.join(dir, scaffold ? 'server.js' : 'server/index.js'), '');
	await writeFile(
		path.join(dir, 'package.json'),
		JSON.stringify({ name, scripts: { start: 'bun x', build: 'vbc-build', ...scripts } }),
	);

	return dir;
};

const setup = ({ run = async () => ({ code: 0, output: '' }), exposure = {} } = {}) => {
	const units = fakeUnits();
	const hub = createHub({
		db: fakeDb(),
		units,
		run,
		probe: async () => ({ ok: true }),
		hubDir: '/hub',
		resetsDir: path.join(root, 'resets'),
		exposure: {
			sshHost: 'vps',
			publicHost: 'games.example',
			publicPortBase: 9100,
			tunnelPortBase: 19100,
			slots: 2,
			...exposure,
		},
	});

	return { hub, units };
};

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), 'mother-hub-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('adding', () => {
	test('a house app takes its port and save file from its scripts', async () => {
		const dir = await makeGame('void-driller', {
			scripts: { 'service:enable': 'vbc-service enable --port 1040', 'db:clean': 'rm -f ~/.void-driller.json' },
		});
		const { hub } = setup();

		const game = await hub.add({ dir });

		expect(game).toMatchObject({
			id: 'void-driller',
			name: 'Void Driller',
			port: 1040,
			entry: 'server/index.js',
			portVia: 'flag',
			databases: [path.join(os.homedir(), '.void-driller.json')],
		});
	});

	test('a scaffold game gets a port handed to it and saves under its own data folder', async () => {
		const dir = await makeGame('dino-dash', { scaffold: true });
		const { hub } = setup();

		const game = await hub.add({ dir });

		expect(game).toMatchObject({
			port: 4100,
			entry: 'server.js',
			portVia: 'env',
			databases: [path.join(dir, 'data/games.json')],
		});
	});

	test('two games on one port are refused', async () => {
		const scripts = { 'service:enable': 'vbc-service enable --port 1040' };
		const { hub } = setup();

		await hub.add({ dir: await makeGame('one', { scripts }) });

		await expect(hub.add({ dir: await makeGame('two', { scripts }) })).rejects.toThrow('One already uses port 1040');
	});

	test('a folder with nothing to start is refused', async () => {
		const dir = path.join(root, 'notes');

		await mkdir(dir);
		await writeFile(path.join(dir, 'package.json'), '{"name":"notes"}');

		await expect(setup().hub.add({ dir })).rejects.toThrow('no start script');
	});
});

describe('running', () => {
	test('a house app is started with --port, a scaffold game with PORT', async () => {
		const { hub, units } = setup();
		const app = await hub.add({ dir: await makeGame('app', { scripts: { 'service:enable': 'x --port 1040' } }) });
		const scaffold = await hub.add({ dir: await makeGame('kid-game', { scaffold: true }) });

		await hub.turnOn(app.id).done;
		await hub.turnOn(scaffold.id).done;

		expect(units.units.get('app').definition).toMatchObject({
			entry: 'server/index.js',
			args: ['--port', '1040'],
			env: {},
		});
		expect(units.units.get('kid-game').definition).toMatchObject({
			entry: 'server.js',
			args: [],
			env: { PORT: '4100' },
		});
	});

	test('a second operation while one runs is refused', async () => {
		let finish;
		const run = argv =>
			argv[1] === 'pull'
				? new Promise(resolve => (finish = () => resolve({ code: 0, output: '' })))
				: { code: 0, output: '' };
		const { hub } = setup({ run });
		const { id } = await hub.add({ dir: await makeGame('slow') });

		const { done } = hub.update(id);

		expect(() => hub.reset(id)).toThrow('Slow is busy: update');

		finish();
		await done;
	});

	test('a failed pull stops the update before anything is restarted', async () => {
		const run = async argv => ({ code: argv[1] === 'pull' ? 1 : 0, output: '' });
		const { hub, units } = setup({ run });
		const { id } = await hub.add({ dir: await makeGame('game') });

		await hub.turnOn(id).done;
		const operation = await hub.update(id).done;

		expect(operation.ok).toBe(false);
		expect(operation.error).toContain('git pull --ff-only failed');
		expect(units.calls.some(([verb]) => verb === 'restart')).toBe(false);
	});

	test('an update pulls, installs, builds, and restarts a running game', async () => {
		const ran = [];
		const { hub, units } = setup({ run: async argv => (ran.push(argv.join(' ')), { code: 0, output: '' }) });
		const { id } = await hub.add({ dir: await makeGame('game') });

		await hub.turnOn(id).done;
		const operation = await hub.update(id).done;

		expect(operation.ok).toBe(true);
		expect(ran.filter(command => !command.includes(' -C '))).toEqual([
			'git pull --ff-only',
			'bun install',
			'bun run build',
		]);
		expect(units.calls.at(-1)).toEqual(['restart', 'game']);
	});
});

describe('resetting', () => {
	test('moves the save files aside and starts the game again', async () => {
		const dir = await makeGame('kid-game', { scaffold: true });
		const { hub, units } = setup();
		const { id, databases } = await hub.add({ dir });

		await mkdir(path.dirname(databases[0]), { recursive: true });
		await writeFile(databases[0], '{"games":{}}');
		await hub.turnOn(id).done;

		const operation = await hub.reset(id).done;

		expect(operation.ok).toBe(true);
		expect(existsSync(databases[0])).toBe(false);

		const [stamp] = await readdir(path.join(root, 'resets', id));

		expect(existsSync(path.join(root, 'resets', id, stamp, 'games.json'))).toBe(true);
		expect(units.calls.map(([verb]) => verb)).toEqual(['start', 'stop', 'start']);
	});

	test('a game with no save file known says so instead of pretending', async () => {
		const { hub } = setup();
		const { id } = await hub.add({ dir: await makeGame('app') });

		const operation = await hub.reset(id).done;

		expect(operation.ok).toBe(false);
		expect(operation.error).toContain('No save file is known');
	});
});

describe('exposing', () => {
	test('opens a tunnel to the VPS for its slot, and keeps the slot when closed', async () => {
		const { hub, units } = setup();
		const { id } = await hub.add({ dir: await makeGame('app', { scripts: { 'service:enable': 'x --port 1040' } }) });

		await hub.expose(id).done;

		expect(units.units.get('mother-hub-tunnel-app').definition.args).toEqual([
			'--host',
			'vps',
			'--remote',
			'19101',
			'--local',
			'1040',
		]);
		expect((await hub.get(id)).publicUrl).toBe('https://games.example:9101');

		await hub.conceal(id).done;

		expect((await hub.get(id)).publicUrl).toBe(null);
		expect((await hub.get(id)).exposeSlot).toBe(1);
	});

	test('runs out of slots plainly', async () => {
		const { hub } = setup({ exposure: { slots: 1 } });
		const one = await hub.add({ dir: await makeGame('one') });
		const two = await hub.add({ dir: await makeGame('two') });

		await hub.expose(one.id).done;
		const operation = await hub.expose(two.id).done;

		expect(operation.error).toContain('All 1 public ports are in use');
	});

	test('without the VPS configured, exposing explains what it needs', async () => {
		const { hub } = setup({ exposure: { sshHost: null, publicHost: null } });
		const { id } = await hub.add({ dir: await makeGame('app') });

		expect((await hub.expose(id).done).error).toContain('--vps-host and --public-host');
	});

	test('closing everything stops every tunnel', async () => {
		const { hub, units } = setup();
		const one = await hub.add({ dir: await makeGame('one') });
		const two = await hub.add({ dir: await makeGame('two') });

		await hub.expose(one.id).done;
		await hub.expose(two.id).done;

		expect(await hub.concealAll()).toBe(2);
		expect(units.units.get('mother-hub-tunnel-one').active).toBe(false);
		expect(units.units.get('mother-hub-tunnel-two').active).toBe(false);
	});

	test('turning a game off closes its tunnel, and turning it on opens it again', async () => {
		const { hub, units } = setup();
		const { id } = await hub.add({ dir: await makeGame('app') });

		await hub.turnOn(id).done;
		await hub.expose(id).done;
		await hub.turnOff(id).done;

		expect(units.units.get('mother-hub-tunnel-app').active).toBe(false);

		await hub.turnOn(id).done;

		expect(units.units.get('mother-hub-tunnel-app').active).toBe(true);
	});
});

test('forgetting a game removes the unit the hub made for it, and its tunnel', async () => {
	const { hub, units } = setup();
	const { id } = await hub.add({ dir: await makeGame('app') });

	await hub.turnOn(id).done;
	await hub.forget(id);

	expect(units.calls.filter(([verb]) => verb === 'remove')).toEqual([
		['remove', 'mother-hub-tunnel-app'],
		['remove', 'app'],
	]);
	expect(await hub.list()).toEqual([]);
});

test("forgetting a game leaves a unit it didn't make: one from the game's own service:enable", async () => {
	const { hub, units } = setup();
	const { id } = await hub.add({ dir: await makeGame('app') });

	units.units.set('app', { active: true });
	await hub.turnOn(id).done;
	await hub.forget(id);

	expect(units.calls.filter(([verb]) => verb === 'remove')).toEqual([['remove', 'mother-hub-tunnel-app']]);
});

test('forgetting a game never started touches no unit of its name', async () => {
	const { hub, units } = setup();
	const { id } = await hub.add({ dir: await makeGame('app') });

	await hub.forget(id);

	expect(units.calls).toEqual([['remove', 'mother-hub-tunnel-app']]);
});

describe('finding games', () => {
	test("a house app with no db:clean still has its save file found in its server's default", async () => {
		const dir = await makeGame('humanity');

		await writeFile(path.join(dir, 'server/server.js'), "defaultValue: path.join(os.homedir(), '.humanity.json'),");

		expect((await setup().hub.add({ dir })).databases).toEqual([path.join(os.homedir(), '.humanity.json')]);
	});

	test('offers what looks like a game, and not what merely mentions games', async () => {
		await makeGame('rts', { scripts: { 'db:clean': 'rm -f ~/.rts.json' } });
		await makeGame('library');
		await writeFile(
			path.join(root, 'library/package.json'),
			JSON.stringify({ name: 'library', description: 'A library of games', scripts: { start: 'x' } }),
		);

		expect((await findCandidates(root, [], '/hub')).map(game => game.id)).toEqual(['rts']);
	});
});
