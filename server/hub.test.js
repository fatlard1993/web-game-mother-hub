import { existsSync } from 'fs';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { findCandidates } from './detect';
import { createHub, untilNext } from './hub';

let root;

const fakeDb = () => ({ data: { games: {} }, write: async () => {} });

// A systemd that keeps its units in a map: started is active and enabled, stopped is neither. Games are bun-server@
// instances, as dotfiles runs them; tunnels are the hub's own.
const fakeUnits = () => {
	const units = new Map();
	const calls = [];
	const ports = new Map();
	const known = [];

	return {
		units,
		calls,
		ports,
		known,
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
		portOf: async name => ports.get(name) ?? null,
		listening: new Map(),
		listeningPort: async function (name) {
			return this.listening.get(name) ?? null;
		},
		instances: async () => known,
		startGame: async (id, settings) => {
			calls.push(['start', `bun-server@${id}`, settings]);
			units.set(`bun-server@${id}`, { active: true, settings });
		},
		startTunnel: async (name, definition) => {
			calls.push(['start', name, definition]);
			units.set(name, { active: true, definition });
		},
		stop: async name => {
			calls.push(['stop', name]);
			if (units.has(name)) units.get(name).active = false;
		},
		restart: async name => calls.push(['restart', name]),
		removeTunnel: async name => {
			calls.push(['remove', name]);
			units.delete(name);
		},
		logs: async name => `logs of ${name}`,
	};
};

const makeGame = async (name, { scaffold = false, scripts = {}, description } = {}) => {
	const dir = path.join(root, name);

	await mkdir(path.join(dir, scaffold ? '.' : 'server'), { recursive: true });
	await writeFile(path.join(dir, scaffold ? 'server.js' : 'server/index.js'), '');
	await writeFile(
		path.join(dir, 'package.json'),
		JSON.stringify({
			name,
			description,
			scripts: { start: 'bun x', build: 'vbc-build', ...scripts },
			// A scaffold game is on the framework, which is how it's known for a game
			dependencies: scaffold ? { '@fatlard1993/web-game-framework': 'x' } : {},
		}),
	);

	return dir;
};

const setup = ({ run = async () => ({ code: 0, output: '' }), exposure = {}, shots = null } = {}) => {
	const units = fakeUnits();
	const hub = createHub({
		db: fakeDb(),
		units,
		run,
		probe: async () => ({ ok: true }),
		shots,
		projectsRoot: root,
		selfId: 'web-game-mother-hub',
		hubDir: '/hub',
		bun: 'bun',
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
	test('a game is started as its bun-server@ instance, a house app on its own port, a scaffold game on PORT', async () => {
		const { hub, units } = setup();
		const app = await hub.add({ dir: await makeGame('app', { scripts: { 'service:enable': 'x --port 1040' } }) });
		const scaffold = await hub.add({ dir: await makeGame('kid-game', { scaffold: true }) });

		await hub.turnOn(app.id).done;
		await hub.turnOn(scaffold.id).done;

		expect(units.units.get('bun-server@app').settings).toEqual({ port: 1040, portVia: 'flag', defaultPort: 1040 });
		expect(units.units.get('bun-server@kid-game').settings).toEqual({ port: 4100, portVia: 'env', defaultPort: null });
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

		while (!finish) await Bun.sleep(1);
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
		expect(units.calls.at(-1)).toEqual(['restart', 'bun-server@game']);
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

	test('a tunnel reaches the VPS with the hub its own key, when it has one', async () => {
		const { hub, units } = setup({ exposure: { sshHost: 'ubuntu@203.0.113.7', identity: '/k/mother-hub-tunnel' } });
		const { id } = await hub.add({ dir: await makeGame('app') });

		await hub.expose(id).done;

		expect(units.units.get('mother-hub-tunnel-app').definition.args).toEqual(
			expect.arrayContaining(['--host', 'ubuntu@203.0.113.7', '--identity', '/k/mother-hub-tunnel']),
		);
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

		expect((await hub.expose(id).done).error).toContain('MOTHER_HUB_VPS_HOST and MOTHER_HUB_PUBLIC_HOST');
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

test("forgetting a game removes its tunnel, leaves dotfiles' unit as it is, and isn't undone by discovery", async () => {
	const { hub, units } = setup();
	const { id } = await hub.add({ dir: await makeGame('app') });

	await hub.turnOn(id).done;
	await hub.forget(id);

	expect(units.calls.filter(([verb]) => verb === 'remove')).toEqual([['remove', 'mother-hub-tunnel-app']]);
	expect(units.units.get('bun-server@app').active).toBe(true);

	units.known.push('app');
	expect(await hub.list()).toEqual([]);
});

describe('finding games', () => {
	test("a house app with no db:clean still has its save file found in its server's default", async () => {
		const dir = await makeGame('humanity', { description: 'A card game for terrible people' });

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

test("the card's cover is the first picture of play, not the logo", async () => {
	const { hub } = setup();
	const dir = await makeGame('driller');

	await mkdir(path.join(dir, 'img'));
	await writeFile(path.join(dir, 'img/logo.png'), '');
	await writeFile(path.join(dir, 'img/play.png'), '');
	await writeFile(
		path.join(dir, 'README.md'),
		'# Driller\n\n![logo](./img/logo.png)\n\nA game about drilling through asteroids for money.\n\n![Play: the rig](./img/play.png)',
	);

	const { about } = await hub.add({ dir });

	expect(about).toMatchObject({
		blurb: 'A game about drilling through asteroids for money.',
		cover: { alt: 'Play: the rig' },
		pictures: 2,
		hasReadme: true,
	});
});

test('a cover chosen here outranks the README, and changing it leaves the name following the game', async () => {
	const { hub } = setup();
	const dir = await makeGame('driller');

	await mkdir(path.join(dir, 'img'));
	await mkdir(path.join(dir, 'client'));
	await writeFile(path.join(dir, 'client/manifest.json'), JSON.stringify({ name: 'Driller' }));
	await writeFile(path.join(dir, 'img/lobby.png'), '');
	await writeFile(path.join(dir, 'img/play.png'), '');
	await writeFile(path.join(dir, 'README.md'), '![The lobby](./img/lobby.png) ![Play: the rig](./img/play.png)');

	const { id, about } = await hub.add({ dir });

	expect(about.cover.alt).toBe('Play: the rig');

	const edited = await hub.edit(id, { cover: 'img/lobby.png' });

	expect(edited.about.cover.alt).toBe('The lobby');

	await writeFile(path.join(dir, 'client/manifest.json'), JSON.stringify({ name: 'Driller 2' }));
	expect((await hub.get(id)).name).toBe('Driller 2');
});

describe('live pictures', () => {
	// A camera that writes an empty png where the real one would, and remembers what it was pointed at
	const fakeShots = () => {
		const taken = [];

		return {
			taken,
			available: true,
			file: id => (taken.includes(id) ? path.join(root, `${id}.png`) : null),
			take: async (id, url) => {
				await writeFile(path.join(root, `${id}.png`), '');
				taken.push(id);

				return url.endsWith(':1040/');
			},
			forget: async () => {},
		};
	};

	test("a game is pictured once it's started and answering", async () => {
		const shots = fakeShots();
		const { hub } = setup({ shots });
		const { id } = await hub.add({ dir: await makeGame('app', { scripts: { 'service:enable': 'x --port 1040' } }) });

		await hub.turnOn(id).done;
		await Bun.sleep(10);

		expect(shots.taken).toEqual(['app']);
	});

	test('a game whose README shows nothing gets its live picture as its cover', async () => {
		const shots = fakeShots();
		const { hub } = setup({ shots });
		const { id } = await hub.add({ dir: await makeGame('app') });

		expect((await hub.get(id)).about.cover).toBe(null);

		await hub.turnOn(id).done;
		await Bun.sleep(10);

		expect((await hub.get(id)).about.cover).toMatchObject({
			path: 'live',
			url: expect.stringContaining('/api/games/app/shot?v='),
		});
	});

	test("a game that's off isn't pictured on request, and saying so is the answer", async () => {
		const { hub } = setup({ shots: fakeShots() });
		const { id } = await hub.add({ dir: await makeGame('app') });

		await expect(hub.photograph(id)).rejects.toThrow('App is off');
	});
});

describe('living with dotfiles', () => {
	test("a game outside the projects folder is refused: bun-server@ runs only ~/Projects' folders", async () => {
		const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'elsewhere-'));

		await mkdir(path.join(elsewhere, 'server'), { recursive: true });
		await writeFile(path.join(elsewhere, 'server/index.js'), '');
		await writeFile(path.join(elsewhere, 'package.json'), JSON.stringify({ name: 'x', scripts: { start: 'x' } }));

		await expect(setup().hub.add({ dir: elsewhere })).rejects.toThrow('runs games from folders in');
		await rm(elsewhere, { recursive: true, force: true });
	});

	test("the bun-server@ units' games are listed on their own, keeping a port shelf-game gave, and never the hub", async () => {
		const { hub, units } = setup();

		await makeGame('humanity', { scripts: { 'service:enable': 'x --port 8032' } });
		await makeGame('sand-sorter', { scaffold: true });
		await makeGame('web-game-mother-hub');
		units.known.push('humanity', 'sand-sorter', 'web-game-mother-hub', 'not-a-folder');
		units.ports.set('bun-server@sand-sorter', 3100);

		const listed = await hub.list();

		expect(listed.map(game => [game.id, game.port])).toEqual([
			['humanity', 8032],
			['sand-sorter', 3100],
		]);
	});

	test("a running game is listed on the port it's really listening on, which becomes its own when nothing else says", async () => {
		const { hub, units } = setup();

		await makeGame('sorcery');
		units.known.push('sorcery');
		units.listening.set('bun-server@sorcery', 3040);

		const [game] = await hub.list();

		expect(game).toMatchObject({ port: 3040, defaultPort: 3040 });
	});

	test('an update installs frozen when the game has a lockfile, and builds what is there when nothing upstream', async () => {
		const ran = [];
		const run = async argv => {
			ran.push(argv.join(' '));

			return { code: argv.includes('@{u}') ? 128 : 0, output: '' };
		};
		const { hub } = setup({ run });
		const dir = await makeGame('kid-game', { scaffold: true });

		await writeFile(path.join(dir, 'bun.lock'), '');

		const { id } = await hub.add({ dir });
		const operation = await hub.update(id).done;

		expect(operation.ok).toBe(true);
		expect(operation.lines).toContain('No upstream to pull from; building what is here');
		expect(ran.filter(command => !command.includes(' -C '))).toEqual([
			'bun install --frozen-lockfile',
			'bun run build',
		]);
	});

	test("a save that's a link into somewhere else is left where it is by a reset", async () => {
		const { hub } = setup();
		const kept = path.join(root, 'kept.json');
		const dir = await makeGame('linked', { description: 'A game of links' });
		const save = path.join(root, 'linked-save.json');

		await writeFile(kept, '{}');
		await symlink(kept, save);

		const { id } = await hub.add({ dir });

		await hub.edit(id, { databases: [save] });

		const operation = await hub.reset(id).done;

		expect(operation.ok).toBe(true);
		expect(operation.lines.join('\n')).toContain('is a link to a file kept elsewhere');
		expect(existsSync(save)).toBe(true);
	});

	test("a house app that isn't a game has no saves to reset (game-night's library)", async () => {
		const dir = await makeGame('game-night', { description: 'A searchable library of games' });

		await writeFile(path.join(dir, 'server/index.js'), "defaultValue: path.join(os.homedir(), '.gameNight.json'),");

		expect((await setup().hub.add({ dir })).databases).toEqual([]);
	});
});

describe('updating by itself', () => {
	// A git with commits waiting upstream at `target`, and an update that ends as `pullOk` says
	const gitWaiting = ({ behind = 2, target = 'abc123', pullOk = true } = {}) => {
		const ran = [];
		const run = async argv => {
			ran.push(argv.join(' '));
			if (argv.includes('rev-list')) return { code: 0, output: String(behind) };
			if (argv.at(-1) === '@{u}' && argv.includes('rev-parse')) return { code: 0, output: target };
			if (argv[1] === 'pull') return { code: pullOk ? 0 : 1, output: '' };

			return { code: 0, output: '' };
		};

		return { ran, run };
	};

	const pulls = ran => ran.filter(command => command === 'git pull --ff-only').length;

	test('every game is fetched each round, and only one set to update itself is updated', async () => {
		const { ran, run } = gitWaiting();
		const { hub } = setup({ run });
		const manual = await hub.add({ dir: await makeGame('manual') });
		const auto = await hub.add({ dir: await makeGame('auto', { scripts: { 'service:enable': 'x --port 1040' } }) });

		await hub.edit(auto.id, { autoUpdate: true });
		await hub.autoUpdateRound();

		expect(ran.filter(command => command.endsWith('fetch --quiet'))).toHaveLength(2);
		expect(pulls(ran)).toBe(1);
		expect((await hub.get(auto.id)).operation).toMatchObject({ kind: 'update', ok: true });
		expect((await hub.get(manual.id)).operation).toBeUndefined();
	});

	test("someone playing holds the update until they've gone, and the card says why", async () => {
		const { ran, run } = gitWaiting();
		const units = fakeUnits();
		let connections = 1;
		const hub = createHub({
			db: fakeDb(),
			units,
			run,
			probe: async () => ({ ok: true, report: { connections } }),
			projectsRoot: root,
			resetsDir: path.join(root, 'resets'),
			exposure: {},
			bun: 'bun',
		});
		const { id } = await hub.add({ dir: await makeGame('busy') });

		await hub.edit(id, { autoUpdate: true });
		await hub.autoUpdateRound();

		expect(pulls(ran)).toBe(0);
		expect((await hub.get(id)).updateWaiting).toBe('players');

		connections = 0;
		await hub.autoUpdateRound();

		expect(pulls(ran)).toBe(1);
		expect((await hub.get(id)).updateWaiting).toBe(null);
	});

	test('an upstream that failed to update is left until a new one lands', async () => {
		const git = gitWaiting({ pullOk: false });
		const { hub } = setup({ run: git.run });
		const { id } = await hub.add({ dir: await makeGame('broken') });

		await hub.edit(id, { autoUpdate: true });
		await hub.autoUpdateRound();
		await hub.autoUpdateRound();

		expect(pulls(git.ran)).toBe(1);
	});

	test('a game with nothing upstream is never fetched or updated', async () => {
		const ran = [];
		const { hub } = setup({
			run: async argv => (ran.push(argv.join(' ')), { code: argv.includes('@{u}') ? 128 : 0, output: '' }),
		});
		const { id } = await hub.add({ dir: await makeGame('local') });

		await hub.edit(id, { autoUpdate: true });
		await hub.autoUpdateRound();

		expect(ran.some(command => command.includes('fetch'))).toBe(false);
		expect(pulls(ran)).toBe(0);
	});
});

describe('the nightly round', () => {
	test("runs at tonight's hour if it's still ahead, else tomorrow's", () => {
		const at = (hours, minutes) => new Date(2026, 10, 8, hours, minutes);

		expect(untilNext('04:00', at(3, 30))).toBe(30 * 60 * 1000);
		expect(untilNext('04:00', at(21, 0))).toBe(7 * 60 * 60 * 1000);
		expect(untilNext('04:00', at(4, 0))).toBe(24 * 60 * 60 * 1000);
	});

	test("a round that's only fetching updates nothing, even a game set to update itself", async () => {
		const ran = [];
		const run = async argv => {
			ran.push(argv.join(' '));
			if (argv.includes('rev-list')) return { code: 0, output: '3' };

			return { code: 0, output: argv.includes('rev-parse') ? 'abc' : '' };
		};
		const { hub } = setup({ run });
		const { id } = await hub.add({ dir: await makeGame('auto') });

		await hub.edit(id, { autoUpdate: true });
		await hub.autoUpdateRound({ updating: false });

		expect(ran.some(command => command.endsWith('fetch --quiet'))).toBe(true);
		expect(ran.includes('git pull --ff-only')).toBe(false);
	});
});
