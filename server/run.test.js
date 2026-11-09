import { expect, test } from 'bun:test';

import { run } from './run';

test('a command that runs past its timeout is stopped, failed, and says why', async () => {
	const { code, output } = await run(['sleep', '5'], { timeout: 300 });

	expect(code).not.toBe(0);
	expect(output).toContain('took too long');
});

test("a command's output comes back whole, stdout and stderr both", async () => {
	const { code, output } = await run(['sh', '-c', 'echo one; echo two >&2']);

	expect(code).toBe(0);
	expect(output.split('\n').sort()).toEqual(['one', 'two']);
});
