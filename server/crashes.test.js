import { expect, test } from 'bun:test';

import { crashBriefing, createCrashWatch } from './crashes';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

const setup = ({ upstream = null, failing = 0 } = {}) => {
	let clock = new Date('2026-11-17T12:00:00Z');
	const states = new Map([['bun-server@digger', { state: 'active', restarts: 0 }]]);
	const calls = [];
	let refusals = failing;
	const db = {
		data: { games: { digger: { id: 'digger', name: 'Digger', dir: '/p/digger', port: 4100, databases: [] } } },
		write: async () => {},
	};
	const watch = createCrashWatch({
		db,
		units: { state: async name => states.get(name) },
		run: async () => (upstream ? { code: 0, output: upstream } : { code: 128, output: 'no upstream' }),
		leeway: 'fix',
		now: () => clock,
		log: quiet,
		paude: {
			start: async (project, text) => {
				if (refusals-- > 0) throw new Error("paude isn't answering");
				calls.push(['start', project, text]);

				return 'session-1';
			},
			name: async (id, name) => calls.push(['name', id, name]),
			prompt: async (id, text) => calls.push(['prompt', id, text]),
			link: id => `https://paude.home/#/sessions/${id}`,
		},
	});

	return {
		db,
		watch,
		calls,
		crash: (restarts, state = 'auto-restart') => states.set('bun-server@digger', { state, restarts }),
		later: ms => (clock = new Date(clock.getTime() + ms)),
	};
};

test("a restart systemd made on its own starts a session in the game's folder", async () => {
	const { db, watch, calls, crash } = setup();

	await watch.check();
	expect(calls).toEqual([]);

	crash(1);
	await watch.check();

	expect(calls[0].slice(0, 2)).toEqual(['start', 'digger']);
	expect(calls[0][2]).toContain('systemd restarted it (1 restarts so far)');
	expect(calls[1][0]).toBe('name');
	expect(db.data.games.digger.crash).toMatchObject({
		session: 'session-1',
		url: 'https://paude.home/#/sessions/session-1',
	});
});

test('a crash loop is one session, told again no more than every ten minutes', async () => {
	const { watch, calls, crash, later } = setup();

	await watch.check();
	crash(1);
	await watch.check();
	crash(2);
	await watch.check();
	expect(calls.filter(([kind]) => kind === 'prompt')).toEqual([]);

	later(11 * 60 * 1000);
	crash(5, 'failed');
	await watch.check();
	expect(calls.filter(([kind]) => kind === 'start')).toHaveLength(1);
	expect(calls.at(-1)).toEqual([
		'prompt',
		'session-1',
		'It crashed again. Digger crashed and systemd gave up on it, after 5 restarts.',
	]);

	later(60 * 60 * 1000);
	crash(0, 'active');
	await watch.check();
	crash(1);
	await watch.check();
	expect(calls.filter(([kind]) => kind === 'start')).toHaveLength(2);
});

test('a game given up on before the hub started is caught; one already in hand is not', async () => {
	const first = setup();

	first.crash(5, 'failed');
	await first.watch.check();
	expect(first.calls[0][0]).toBe('start');

	const again = setup();

	again.db.data.games.digger.crash = { session: 'old', at: '2026-11-17T11:30:00Z', toldAt: '2026-11-17T11:30:00Z' };
	again.crash(5, 'failed');
	await again.watch.check();
	expect(again.calls).toEqual([]);
});

test("a crash paude doesn't take is tried again at the next checks", async () => {
	const { watch, calls, crash } = setup({ failing: 2 });

	await watch.check();
	crash(1);
	await watch.check();
	await watch.check();
	expect(calls).toEqual([]);

	await watch.check();
	expect(calls[0][0]).toBe('start');
});

test('the briefing says where a fix goes, and only lets a bundled copy be looked at', () => {
	const record = { id: 'digger', name: 'Digger', dir: '/p/digger', port: 4100, databases: ['/p/digger/db.json'] };

	expect(crashBriefing({ record, what: 'x', leeway: 'fix', upstream: 'origin/main' })).toContain(
		'pushed with `git push`',
	);
	expect(crashBriefing({ record, what: 'x', leeway: 'fix', upstream: null })).toContain('nothing to push to');
	expect(crashBriefing({ record: { ...record, bundled: true }, what: 'x', leeway: 'fix' })).toContain(
		'change nothing here',
	);
	expect(crashBriefing({ record, what: 'x', leeway: 'investigate' })).toContain('until someone joins');
	expect(crashBriefing({ record: { ...record, hosted: 'paude' }, what: 'x', leeway: 'fix' })).toContain(
		'restarting it as above is what is asked',
	);
});
