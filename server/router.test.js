import { describe, expect, test } from 'bun:test';

import { createAuth } from './auth';
import { forPlayer, hubForPlayer } from './roles';
import { createRouter } from './router';

const db = () => ({ data: {}, write: async () => {} });

const setup = async () => {
	const auth = await createAuth({ db: db(), password: 'hunter2' });
	const hub = {
		list: async () => [{ id: 'game' }],
		turnOff: () => ({ operation: { kind: 'turn off', running: true } }),
	};

	return { router: createRouter({ hub, auth, projectsRoot: '/nowhere' }), auth };
};

const loggedIn = auth => ({ cookie: auth.sessionCookie().split(';')[0] });

test('a player finds the games without logging in, and every action, log or setting takes the admin', async () => {
	const { router } = await setup();
	const get = url => router(new Request(`http://hub${url}`));
	const send = (method, url) => router(new Request(`http://hub${url}`, { method }));

	expect((await get('/api/games')).status).toBe(200);
	expect(await (await get('/api/session')).json()).toEqual({ loggedIn: false, role: 'player' });

	for (const [method, url] of [
		['POST', '/api/games/game/turnOff'],
		['POST', '/api/games/game/expose'],
		['POST', '/api/games/game/reset'],
		['PATCH', '/api/games/game'],
		['DELETE', '/api/games/game'],
		['GET', '/api/games/game/logs'],
		['GET', '/api/candidates'],
		['POST', '/api/exposure/off'],
		['POST', '/api/host'],
	])
		expect([method, url, (await send(method, url)).status]).toEqual([method, url, 401]);
});

test("a player's view of a game leaves out its folder, saves, git and what the commands printed", async () => {
	const game = {
		id: 'humanity',
		name: 'Humanity',
		port: 8032,
		dir: '/home/home/Projects/humanity',
		databases: ['/home/home/.humanity.json'],
		git: { branch: 'main', commit: 'abc', dirty: false },
		exposed: true,
		publicUrl: 'https://203.0.113.7:9101',
		lanUrl: 'http://humanity.home',
		unit: { active: true, state: 'active', restarts: 0, since: null, enabled: true },
		health: { ok: true },
		operation: { kind: 'update', running: true, lines: ['$ git pull', 'secret path'], error: null },
		look: { color: '#fff' },
		about: { blurb: 'cards' },
	};
	const seen = forPlayer(game);

	expect(seen).toMatchObject({
		name: 'Humanity',
		publicUrl: 'https://203.0.113.7:9101',
		lanUrl: 'http://humanity.home',
	});
	expect(seen.operation).toEqual({ kind: 'update', running: true });
	for (const key of ['dir', 'databases', 'git', 'autoUpdate', 'exposeSlot', 'defaultPort'])
		expect(seen).not.toHaveProperty(key);
	expect(JSON.stringify(seen)).not.toContain('/home/home');
	expect(hubForPlayer({ exposure: { sshHost: 'ubuntu@203.0.113.7', configured: true } })).toEqual({
		exposure: { configured: true },
		shots: false,
	});
});

test('a wrong password is refused', async () => {
	const { router } = await setup();
	const response = await router(
		new Request('http://hub/api/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ password: 'nope' }),
		}),
	);

	expect(response.status).toBe(401);
});

test('logged in, actions answer as soon as they begin', async () => {
	const { router, auth } = await setup();
	const response = await router(
		new Request('http://hub/api/games/game/turnOff', { method: 'POST', headers: loggedIn(auth) }),
	);

	expect(response.status).toBe(202);
	expect(await response.json()).toEqual({ kind: 'turn off', running: true });
});

test("another site's page can't press the buttons, even riding a login", async () => {
	const { router, auth } = await setup();
	const response = await router(
		new Request('http://hub/api/games/game/turnOff', {
			method: 'POST',
			headers: { ...loggedIn(auth), origin: 'http://evil.example', host: 'hub' },
		}),
	);

	expect(response.status).toBe(403);
});

test('a restart with the same password keeps everyone logged in; a new password logs them out', async () => {
	const store = db();
	const first = await createAuth({ db: store, password: 'hunter2' });
	const session = new Request('http://hub/', { headers: { cookie: first.sessionCookie().split(';')[0] } });

	expect((await createAuth({ db: store, password: 'hunter2' })).isLoggedIn(session)).toBe(true);
	expect((await createAuth({ db: store, password: 'swordfish' })).isLoggedIn(session)).toBe(false);
});

test("paude's token hosts games; a wrong one is refused", async () => {
	const auth = await createAuth({ db: db(), password: 'hunter2', token: 'paude-secret-token' });
	const router = createRouter({ hub: { host: async () => ({ needsBundle: true }) }, auth, projectsRoot: '/nowhere' });
	const host = token =>
		router(
			new Request('http://hub/api/host', {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'sand' }),
			}),
		);

	expect(await (await host('paude-secret-token')).json()).toEqual({ needsBundle: true });
	expect((await host('paude-secret-tokex')).status).toBe(401);
});

test("a game's install and build scripts get none of the hub's secrets", async () => {
	const { plainEnvironment } = await import('./run');
	const plain = plainEnvironment({
		PATH: '/bin',
		HOME: '/h',
		MOTHER_HUB_PASSWORD: 'p',
		MOTHER_HUB_TOKEN: 't',
		SECRET: 's',
	});

	expect(plain).toEqual({ PATH: '/bin', HOME: '/h' });
});

describe('logging in', () => {
	const login = (
		router,
		{ password = 'nope', headers = {}, address = '127.0.0.1', url = 'http://hub/api/session' } = {},
	) =>
		router(
			new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: JSON.stringify({ password }),
			}),
			{ requestIP: () => ({ address }) },
		);

	test('over https (Caddy says so) the session cookie is Secure; over plain http it is not', async () => {
		const { router } = await setup();
		const secure = await login(router, { password: 'hunter2', headers: { 'x-forwarded-proto': 'https' } });
		const plain = await login(router, { password: 'hunter2', address: '192.168.1.40' });

		expect(secure.headers.get('set-cookie')).toContain('; Secure');
		expect(plain.headers.get('set-cookie')).not.toContain('Secure');
	});

	test("behind Caddy each client has its own count of wrong guesses, and a stranger can't claim another's", async () => {
		const { router } = await setup();
		const timed = async options => {
			const started = performance.now();

			await login(router, options);

			return performance.now() - started;
		};
		const guesser = { headers: { 'x-forwarded-for': '192.168.1.66' } };

		await timed(guesser);
		await timed(guesser);

		// Both pay one password check; only the guesser's third try also waits out its two wrong ones (750ms)
		const third = await timed(guesser);
		const admin = await timed({ password: 'hunter2', headers: { 'x-forwarded-for': '192.168.1.20' } });
		// A stranger (not loopback) naming the guesser in the header is still counted as itself
		const stranger = await timed({ address: '192.168.1.99', headers: { 'x-forwarded-for': '192.168.1.66' } });

		expect(third - admin).toBeGreaterThan(500);
		expect(third - stranger).toBeGreaterThan(500);
	});
});
