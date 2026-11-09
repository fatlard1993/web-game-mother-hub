import { expect, test } from 'bun:test';

import { createAuth } from './auth';
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

test('nothing under /api answers without logging in', async () => {
	const { router } = await setup();

	expect((await router(new Request('http://hub/api/games'))).status).toBe(401);
	expect((await router(new Request('http://hub/api/games/game/turnOff', { method: 'POST' }))).status).toBe(401);
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
