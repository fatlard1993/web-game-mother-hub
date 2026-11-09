import { rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { requestMatch, sameOrigin, serveApp, ValidationError, withErrors } from '@vanilla-bean/components/app';

import { findCandidates } from './detect';
import { forPlayer, hubForPlayer } from './roles';

const ACTIONS = ['turnOn', 'turnOff', 'restart', 'update', 'check', 'reset', 'expose', 'conceal'];

// A growing delay after wrong passwords, forgotten after a quiet quarter hour, so a script on the LAN can't grind
// through a word list
const failures = new Map();
const MAX_PENALTY_MS = 10_000;
const FORGET_AFTER_MS = 15 * 60 * 1000;

const failureCount = address => {
	const entry = failures.get(address);

	return entry && Date.now() - entry.at < FORGET_AFTER_MS ? entry.count : 0;
};

const jsonObject = async request => {
	const body = await request.json();

	if (!body || typeof body !== 'object' || Array.isArray(body))
		throw new ValidationError('Expected a JSON object body');

	return body;
};

export const createRouter = ({ hub, auth, projectsRoot, pageRoot = 'client/build' }) => {
	const session = async (request, server) => {
		if (requestMatch('GET', '/api/session', request)) {
			const admin = auth.isLoggedIn(request);

			return Response.json({ loggedIn: admin, role: admin ? 'admin' : 'player' });
		}

		if (requestMatch('POST', '/api/session', request)) {
			const address = server?.requestIP(request)?.address || 'unknown';

			await Bun.sleep(Math.min(250 * 2 ** failureCount(address) - 250, MAX_PENALTY_MS));

			const { password } = await jsonObject(request);

			if (!(await auth.checkPassword(password))) {
				failures.set(address, { count: failureCount(address) + 1, at: Date.now() });

				return Response.json({ error: 'Wrong password' }, { status: 401 });
			}

			failures.delete(address);

			return new Response(null, { status: 204, headers: { 'Set-Cookie': auth.sessionCookie() } });
		}

		if (requestMatch('DELETE', '/api/session', request))
			return new Response(null, { status: 204, headers: { 'Set-Cookie': auth.clearedCookie() } });
	};

	const file = found => new Response(Bun.file(found), { headers: { 'cache-control': 'private, max-age=86400' } });

	// What makes a game's card, for anyone: its icon, its README and its pictures
	const pictures = async request => {
		let match;

		// The URLs carry each file's version, so a new picture is a new URL and these can be kept
		if ((match = requestMatch('GET', '/api/games/:id/icon', request))) {
			const found = await hub.icon(match.id);

			return found ? file(found) : Response.json({ error: 'No icon' }, { status: 404 });
		}

		if ((match = requestMatch('GET', '/api/games/:id/docs', request))) return Response.json(await hub.docs(match.id));

		if ((match = requestMatch('GET', '/api/games/:id/media/:index', request))) {
			const found = await hub.media(match.id, Number(match.index));

			return found ? file(found) : Response.json({ error: 'No such picture' }, { status: 404 });
		}

		if ((match = requestMatch('GET', '/api/games/:id/shot', request))) {
			const found = hub.shot(match.id);

			return found ? file(found) : Response.json({ error: 'No picture yet' }, { status: 404 });
		}
	};

	// What a player may have: the games as a player sees them, and their cards' pictures. The rest of /api is the admin's.
	const playerApi = async request => {
		let match;

		if (requestMatch('GET', '/api/hub', request)) return Response.json(hubForPlayer(hub.hub()));

		if (requestMatch('GET', '/api/games', request)) return Response.json((await hub.list()).map(forPlayer));

		if ((match = requestMatch('GET', '/api/games/:id', request)))
			return Response.json(forPlayer(await hub.get(match.id)));

		return pictures(request);
	};

	const api = async request => {
		let match;

		if (requestMatch('GET', '/api/hub', request)) return Response.json(hub.hub());

		if (requestMatch('GET', '/api/games', request)) return Response.json(await hub.list());

		if (requestMatch('POST', '/api/games', request))
			return Response.json(await hub.add(await jsonObject(request)), { status: 201 });

		if (requestMatch('GET', '/api/candidates', request)) {
			const known = (await hub.list()).map(game => game.dir);

			return Response.json(await findCandidates(projectsRoot, known));
		}

		// paude hosting a game: JSON first, and the repo as a git bundle when the hub can't see it where paude does
		if (requestMatch('POST', '/api/host', request)) return Response.json(await hub.host(await jsonObject(request)));

		if ((match = requestMatch('POST', '/api/host/:name/bundle', request))) {
			const file = path.join(os.tmpdir(), `mother-hub-${process.pid}-${Date.now()}.bundle`);

			await Bun.write(file, await request.arrayBuffer());

			try {
				return Response.json(await hub.hostBundle(match.name, file, { whenIdle: match.whenIdle === '1' }));
			} finally {
				await rm(file, { force: true });
			}
		}

		if (requestMatch('POST', '/api/exposure/off', request)) return Response.json({ closed: await hub.concealAll() });

		if ((match = requestMatch('GET', '/api/games/:id', request))) return Response.json(await hub.get(match.id));

		if ((match = requestMatch('PATCH', '/api/games/:id', request)))
			return Response.json(await hub.edit(match.id, await jsonObject(request)));

		if ((match = requestMatch('DELETE', '/api/games/:id', request))) {
			await hub.forget(match.id);

			return new Response(null, { status: 204 });
		}

		const picture = await pictures(request);
		if (picture) return picture;

		if ((match = requestMatch('POST', '/api/games/:id/shot', request)))
			return Response.json({ taken: await hub.photograph(match.id) });

		if ((match = requestMatch('GET', '/api/games/:id/logs', request))) {
			const lines = Math.min(Number(new URL(request.url).searchParams.get('lines')) || 200, 2000);

			return Response.json({ logs: await hub.logs(match.id, lines) });
		}

		// Answered as soon as it's begun; the page follows it in the game's status
		if ((match = requestMatch('POST', '/api/games/:id/:action', request))) {
			if (!ACTIONS.includes(match.action)) return;

			const { operation } = hub[match.action](match.id);

			return Response.json(operation, { status: 202 });
		}
	};

	const router = async (request, server) => {
		const { pathname } = new URL(request.url);

		if (!sameOrigin(request)) return new Response('Cross-origin request refused', { status: 403 });

		if (!pathname.startsWith('/api/')) return serveApp(request, { root: pageRoot });

		const answered = await session(request, server);
		if (answered) return answered;

		if (!auth.isLoggedIn(request))
			return (await playerApi(request)) ?? Response.json({ error: 'That takes the admin password' }, { status: 401 });

		return (await api(request)) ?? Response.json({ error: 'Not found' }, { status: 404 });
	};

	return withErrors(router, { log: (...args) => console.error('A request failed\n', ...args) });
};
