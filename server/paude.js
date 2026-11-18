import { readFile } from 'fs/promises';

const TIMEOUT_MS = 15_000;
const ACTIVE_MS = 30 * 60 * 1000;

// The few calls of paude's API a crash session needs, made as the token's owner: start one in a project, name it, and
// tell it more. The token is read from its file each time, so paude reinstalled needs no restart here.
export const createPaude = ({ url, token = null, tokenFile = null, browserUrl = null, fetcher = fetch }) => {
	const base = url.replace(/\/+$/, '');

	const bearer = async () => token ?? (await readFile(tokenFile, 'utf8')).trim();

	const call = async (method, route, body) => {
		let response;

		try {
			response = await fetcher(`${base}${route}`, {
				method,
				signal: AbortSignal.timeout(TIMEOUT_MS),
				headers: { authorization: `Bearer ${await bearer()}`, 'content-type': 'application/json' },
				body: body && JSON.stringify(body),
			});
		} catch (error) {
			throw new Error(error.code === 'ENOENT' ? `No paude token at ${tokenFile}` : `paude isn't answering at ${base}`);
		}

		if (!response.ok) throw new Error(`paude said ${response.status}: ${(await response.text()).trim()}`);

		const text = await response.text();

		return text ? JSON.parse(text) : null;
	};

	return {
		// A plain Claude Code session, never the arcade's, even in an arcade game's folder: nobody is there to tap choices
		start: async (project, text) =>
			(await call('POST', `/api/projects/${encodeURIComponent(project)}/sessions`, { text, arcade: false })).id,

		name: (session, name) => call('PUT', `/api/sessions/${session}/name`, { name }),

		// Typed in once Claude's prompt box is free; a session that had stopped is taken back up first
		prompt: (session, text) => call('POST', `/api/sessions/${session}/prompt`, { text }),

		// The session someone is building the game in right now, if any: running, and busy, attended or lately active.
		// The likeliest cause of a crash, and the one to tell.
		active: async (project, { now = Date.now() } = {}) => {
			const sessions = await call('GET', `/api/projects/${encodeURIComponent(project)}/sessions`);
			const building = (sessions ?? [])
				.filter(each => each.live && !each.archived)
				.filter(each => each.busy || each.attached > 0 || now - (each.activeAt ?? 0) < ACTIVE_MS)
				.sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0));

			return building[0]?.id ?? null;
		},

		link: session => (browserUrl ? `${browserUrl.replace(/\/+$/, '')}/#/sessions/${session}` : null),
	};
};
