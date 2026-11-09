import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test } from 'bun:test';

import { leadParagraph, readDocs } from './docs';

let dir;

const write = async (file, contents = '') => {
	await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
	await writeFile(path.join(dir, file), contents);
};

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), 'docs-'));
});

afterEach(() => rm(dir, { recursive: true, force: true }));

test('the lead is the first prose, past the title, the logo and a quoted pitch', () => {
	const markdown = [
		'# Void Driller',
		'![logo](./img/logo.png)',
		'> **Void Driller: Mine the Belt** is a retro-style sci-fi mining game set on the edge of known space.',
		'## Setup',
	].join('\n\n');

	expect(leadParagraph(markdown)).toBe(
		'Void Driller: Mine the Belt is a retro-style sci-fi mining game set on the edge of known space.',
	);
});

test('a lead keeps the words of its links, not their markup', () => {
	expect(
		leadParagraph('# H\n\nMy take on the game by [these fine folks](https://example.com), for terrible people.'),
	).toBe('My take on the game by these fine folks, for terrible people.');
});

test("pictures are numbered in the README's order, each once, with their alt text, and served through the hub", async () => {
	await write('img/play.png');
	await write('img/phone.png');
	await write(
		'README.md',
		'# G\n\n![Play: the board](./img/play.png)\n\n<img src="./img/phone.png" alt="On a phone" width="300">\n\n![Again](img/play.png)',
	);

	const { media, markdown } = await readDocs({ id: 'g', dir });

	expect(media.map(({ alt, file }) => [alt, path.basename(file)])).toEqual([
		['Play: the board', 'play.png'],
		['On a phone', 'phone.png'],
	]);
	expect(markdown).toContain('![Play: the board](/api/games/g/media/0?v=');
	expect(markdown).toContain('![On a phone](/api/games/g/media/1?v=');
	expect(markdown).not.toContain('<img');
});

test("a picture outside the game's folder, or missing, is dropped; a remote one is left as it is", async () => {
	await write('README.md', '![secret](../../etc/x.png) ![gone](./nope.png) ![badge](https://img.example/b.svg)');

	const { media, markdown } = await readDocs({ id: 'g', dir });

	expect(media).toEqual([]);
	expect(markdown.trim()).toBe('![badge](https://img.example/b.svg)');
});

test('a link into the repo keeps its words; a link out stays a link', async () => {
	await write('README.md', 'See [the help](./docs/help.md) and [Bun](https://bun.sh).');

	expect((await readDocs({ id: 'g', dir })).markdown).toBe('See the help and [Bun](https://bun.sh).');
});

test('no README is nothing to say', async () => {
	expect(await readDocs({ id: 'g', dir })).toEqual({ blurb: null, media: [], markdown: null });
});

test('a README or picture that links outside the game is not read or served', async () => {
	const secret = path.join(path.dirname(dir), `secret-${path.basename(dir)}.json`);

	await writeFile(secret, '{"auth":{"secret":"do-not-serve"}}');
	await symlink(secret, path.join(dir, 'README.md'));

	expect(await readDocs({ id: 'g', dir })).toEqual({ blurb: null, media: [], markdown: null });

	await rm(path.join(dir, 'README.md'));
	await mkdir(path.join(dir, 'img'));
	await symlink(secret, path.join(dir, 'img/play.png'));
	await write('README.md', 'A game for the whole house to play together.\n\n![Play](./img/play.png)');

	const docs = await readDocs({ id: 'g', dir });

	expect(docs.media).toEqual([]);
	expect(JSON.stringify(docs)).not.toContain('do-not-serve');
	await rm(secret);
});

test('a picture linked to another file inside the game is served as that file', async () => {
	await write('img/real.png');
	await symlink(path.join(dir, 'img/real.png'), path.join(dir, 'img/alias.png'));
	await write('README.md', '![Play](./img/alias.png)');

	expect((await readDocs({ id: 'g', dir })).media.map(item => item.file)).toEqual([path.join(dir, 'img/real.png')]);
});
