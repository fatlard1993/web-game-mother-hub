import { afterAll, expect, test } from 'bun:test';

import { relay } from './relay';

// A big download and a big upload, through the relay, arrive whole
const big = new Uint8Array(24 * 1024 * 1024).map((_, index) => index % 251);
const game = Bun.serve({
	port: 0,
	fetch: async request =>
		request.method === 'POST' ? new Response(String((await request.arrayBuffer()).byteLength)) : new Response(big),
});
const through = relay({ listenPort: 0, targetPort: game.port });

afterAll(() => {
	through.stop(true);
	game.stop(true);
});

test('a download far bigger than a socket takes at once arrives whole, byte for byte', async () => {
	const body = new Uint8Array(await (await fetch(`http://127.0.0.1:${through.port}/`)).arrayBuffer());

	expect(body.byteLength).toBe(big.byteLength);
	expect(Bun.hash(body)).toBe(Bun.hash(big));
});

test('an upload arrives whole too', async () => {
	const sent = new Uint8Array(8 * 1024 * 1024).fill(7);
	const response = await fetch(`http://127.0.0.1:${through.port}/`, { method: 'POST', body: sent });

	expect(await response.text()).toBe(String(sent.byteLength));
});
