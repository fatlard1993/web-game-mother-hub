import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

let Hub;
const realFetch = globalThis.fetch;

beforeAll(async () => {
	GlobalRegistrator.register({ url: 'http://localhost/' });
	({ default: Hub } = await import('./Hub'));
});

afterAll(async () => {
	globalThis.fetch = realFetch;
	await GlobalRegistrator.unregister();
});

test('a logout the hub refuses keeps the session and says why', async () => {
	// Everything but the logout answers as an empty hub; the logout is refused
	globalThis.fetch = mock(async (url, { method = 'GET' } = {}) =>
		method === 'DELETE' && String(url).endsWith('/api/session')
			? Response.json({ error: 'Session store is read-only' }, { status: 500 })
			: Response.json(String(url).includes('/api/games') ? [] : {}),
	);

	const onSessionChanged = mock();
	const hub = new Hub({ admin: true, onSessionChanged, appendTo: document.body });
	const logOutButton = [...document.querySelectorAll('button')].find(button =>
		/log out/i.test(button.getAttribute('aria-label') ?? button.textContent),
	);

	logOutButton.click();
	await new Promise(resolve => setTimeout(resolve, 50));

	expect(onSessionChanged).not.toHaveBeenCalled();
	expect(document.body.textContent).toContain("Couldn't log out: Session store is read-only");

	hub.destroy();
});
