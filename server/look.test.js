import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test } from 'bun:test';

import { fallbackColor, readLook } from './look';

let dir;

const write = async (file, contents) => {
	await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
	await writeFile(path.join(dir, file), contents);
};

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), 'look-'));
});

afterEach(() => rm(dir, { recursive: true, force: true }));

test("the manifest's name, theme color and biggest icon", async () => {
	await write('client/index.html', '<title>page</title><link rel="manifest" href="./manifest.json" />');
	await write(
		'client/manifest.json',
		JSON.stringify({
			name: 'Sorcery & Savagery',
			theme_color: '#4f7a3a',
			icons: [
				{ src: 'small.png', sizes: '16x16' },
				{ src: 'assets/big.png', sizes: '96x96' },
			],
		}),
	);
	await write('client/small.png', '');
	await write('client/assets/big.png', '');

	expect(await readLook({ id: 'ss', dir })).toMatchObject({
		title: 'Sorcery & Savagery',
		color: '#4f7a3a',
		icon: path.join(dir, 'client/assets/big.png'),
	});
});

test("without a manifest, the page's theme-color, icon link and title", async () => {
	await write(
		'client/index.html',
		'<title>humanity</title><meta name="theme-color" content="#e6e0d0" /><link rel="icon" type="image/svg+xml" href="./favicon.svg" />',
	);
	await write('client/favicon.svg', '<svg/>');

	expect(await readLook({ id: 'humanity', dir })).toMatchObject({
		title: 'humanity',
		color: '#e6e0d0',
		icon: path.join(dir, 'client/favicon.svg'),
	});
});

test("a scaffold game's unfilled title, no color and no icon fall back to its id", async () => {
	await write('client/index.html', '<title>{{name}}</title>');

	expect(await readLook({ id: 'dino-dash', dir })).toMatchObject({
		title: null,
		color: fallbackColor('dino-dash'),
		icon: null,
	});
});

test("an icon named outside the game's client folder is not served", async () => {
	await write('client/index.html', '<link rel="icon" href="../../secret.png" />');
	await write('secret.png', '');

	expect((await readLook({ id: 'x', dir })).icon).toBe(null);
});
