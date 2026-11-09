import { mkdtemp, readFile, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { expect, test } from 'bun:test';

import { vpsCaddyfile } from '../scripts/vpsCaddyfile';
import { createAuth } from './auth';
import { createRouter } from './router';

const db = () => ({ data: {}, write: async () => {} });

const setup = async ({ tokenFile } = {}) => {
	const auth = await createAuth({ db: db(), password: 'hunter2', tokenFile });
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

test('the VPS Caddyfile hands each public port to its tunnel, certifying a bare IP short-lived', () => {
	const caddyfile = vpsCaddyfile({ publicHost: '203.0.113.7', slots: 2 });

	expect(caddyfile).toContain('203.0.113.7:9101 {');
	expect(caddyfile).toContain('reverse_proxy 127.0.0.1:19102');
	expect(caddyfile).toContain('profile shortlived');
	expect(vpsCaddyfile({ publicHost: 'games.example.com', slots: 1 })).not.toContain('shortlived');
});

test('the local token logs in a script on this machine, and nothing from anywhere else', async () => {
	const tokenFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'hub-token-')), 'token');
	const { router } = await setup({ tokenFile });
	const token = (await readFile(tokenFile, 'utf8')).trim();
	const from = address => ({ requestIP: () => ({ address }) });
	const asking = value => new Request('http://hub/api/games', { headers: { authorization: `Bearer ${value}` } });

	expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
	expect((await router(asking(token), from('127.0.0.1'))).status).toBe(200);
	expect((await router(asking(token), from('192.168.1.20'))).status).toBe(401);
	expect((await router(asking(`${token.slice(0, -1)}x`), from('127.0.0.1'))).status).toBe(401);

	// The same token is kept across restarts
	await setup({ tokenFile });
	expect((await readFile(tokenFile, 'utf8')).trim()).toBe(token);
});
