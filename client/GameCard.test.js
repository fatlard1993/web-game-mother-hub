import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

let GameCard;
const realFetch = globalThis.fetch;

beforeAll(async () => {
	GlobalRegistrator.register({ url: 'http://localhost/' });
	({ default: GameCard } = await import('./GameCard'));
});

afterAll(async () => {
	globalThis.fetch = realFetch;
	await GlobalRegistrator.unregister();
});

test("a game's action the hub refuses says what failed, and why", async () => {
	globalThis.fetch = mock(async () => Response.json({ error: 'The unit is masked' }, { status: 500 }));

	const card = new GameCard({
		game: {
			id: 'cards',
			name: 'Cards',
			databases: [],
			unit: { active: false, state: 'inactive' },
			health: {},
			look: { color: '#888' },
			about: {},
			port: 8000,
		},
		admin: true,
		exposure: { configured: false },
		appendTo: document.body,
	});

	await card.act('turnOn');

	expect(document.body.textContent).toContain("Couldn't turn Cards on: The unit is masked");

	card.destroy();
});
