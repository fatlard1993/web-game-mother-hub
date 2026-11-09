const request = (method, url, body) =>
	fetch(url, {
		method,
		headers: body === undefined ? {} : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

// The server's { error }, or the status when there isn't one
export const failure = async response => {
	try {
		return (await response.json()).error || `${response.status} ${response.statusText}`;
	} catch {
		return `${response.status} ${response.statusText}`;
	}
};

export const getSession = async () => (await (await request('GET', '/api/session')).json()).loggedIn;
export const logIn = password => request('POST', '/api/session', { password });
export const logOut = () => request('DELETE', '/api/session');

export const getHub = () => request('GET', '/api/hub');
export const getGames = () => request('GET', '/api/games');
export const getCandidates = () => request('GET', '/api/candidates');
export const addGame = game => request('POST', '/api/games', game);
export const editGame = (id, changes) => request('PATCH', `/api/games/${encodeURIComponent(id)}`, changes);
export const forgetGame = id => request('DELETE', `/api/games/${encodeURIComponent(id)}`);
export const gameAction = (id, action) => request('POST', `/api/games/${encodeURIComponent(id)}/${action}`);
export const getLogs = (id, lines = 300) => request('GET', `/api/games/${encodeURIComponent(id)}/logs?lines=${lines}`);
export const closeAll = () => request('POST', '/api/exposure/off');
