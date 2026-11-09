import { expect, test } from 'bun:test';

import { createUnits } from './units';

// ss, as it answers for a game on :3100 with a player through Caddy and the hub's own health check open
const ss = {
	'( sport = :3100 )': [
		'0 0 127.0.0.1:3100 127.0.0.1:56052 users:(("bun",pid=2901282,fd=8))',
		'0 0 127.0.0.1:3100 127.0.0.1:41000 users:(("bun",pid=2901282,fd=9))',
	],
	'( dport = :3100 )': [
		'0 0 127.0.0.1:56052 127.0.0.1:3100 users:(("bun",pid=4242,fd=81))',
		'0 0 127.0.0.1:41000 127.0.0.1:3100',
	],
};

test("a game's players are the connections to it, less the hub's own", async () => {
	const units = createUnits({ run: async argv => ({ code: 0, output: (ss[argv.at(-1)] ?? []).join('\n') }) });

	expect(await units.connectionsTo(3100, { except: 4242 })).toBe(1);
	expect(await units.connectionsTo(3100, { except: 1 })).toBe(2);
});
