import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

let aboutDialog;
const realFetch = globalThis.fetch;

beforeAll(async () => {
	GlobalRegistrator.register({ url: 'http://localhost/' });
	({ aboutDialog } = await import('./About'));
});

afterAll(async () => {
	globalThis.fetch = realFetch;
	await GlobalRegistrator.unregister();
});

test('a gallery thumbnail is named by its alt text, or by where it is when it has none', async () => {
	globalThis.fetch = mock(async () =>
		Response.json({
			markdown: '',
			media: [
				{ url: '/a.png', path: 'a.png', alt: '' },
				{ url: '/b.png', path: 'b.png', alt: 'The lobby' },
			],
		}),
	);

	await aboutDialog({ id: 'cards', name: 'Cards', look: { color: '#888' }, about: {}, unit: { active: false } });

	const names = [...document.querySelectorAll('.thumbs button')].map(button =>
		(button.getAttribute('aria-labelledby') ?? '')
			.split(' ')
			.map(id => document.getElementById(id)?.textContent ?? '')
			.join(' ')
			.trim(),
	);

	expect(names).toEqual(['Picture 1', 'The lobby']);

	document.querySelector('dialog')?.remove();
});
