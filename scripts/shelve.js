#!/usr/bin/env bun

// An arcade game, finished enough, made one of the house's own: paude's shelf command. It clones the game out of the
// folder paude builds it in, so the hub runs its own copy with its own saves while building carries on; the clone's
// origin is that folder, so the game's Update button on the hub brings in whatever was built since. Then the hub is
// told of it, it's installed and built, and turned on.
//
// In ~/.config/paude/server.json:
//   { "arcade": { "shelf": "bun ~/Projects/web-game-mother-hub/scripts/shelve.js {path} {port}" } }
//
// Run again for the same game, it pulls, updates and restarts rather than adding it twice.

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';

const [source, portArgument] = process.argv.slice(2);
const HUB = process.env.MOTHER_HUB_URL || 'http://127.0.0.1:8036';
const TOKEN_FILE = process.env.MOTHER_HUB_TOKEN_FILE || path.join(os.homedir(), '.web-game-mother-hub-token');
const GAMES = process.env.MOTHER_HUB_GAMES || path.join(os.homedir(), '.web-game-mother-hub-games');
const OPERATION_TIMEOUT_MS = 10 * 60 * 1000;

const fail = message => {
	console.error(message);
	process.exit(1);
};

if (!source) fail('Usage: shelve.js <game folder> [port]');

const from = path.resolve(source);
const port = Number(portArgument) || undefined;
const token = (await readFile(TOKEN_FILE, 'utf8').catch(() => '')).trim();

if (!token) fail(`No hub token at ${TOKEN_FILE}: is the hub running on this machine?`);

const api = async (method, url, body) => {
	const response = await fetch(new URL(url, HUB), {
		method,
		headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	}).catch(error => fail(`The hub at ${HUB} didn't answer: ${error.message}`));
	const data = await response.json().catch(() => null);

	if (!response.ok) fail(`${method} ${url}: ${data?.error ?? response.status}`);

	return data;
};

const git = async (...argv) => {
	const child = Bun.spawn(['git', ...argv], { stdout: 'inherit', stderr: 'inherit' });

	if ((await child.exited) !== 0) fail(`git ${argv.join(' ')} failed`);
};

// Each action is answered as soon as it starts; this follows it to its end, printing what it prints
const follow = async (id, action) => {
	await api('POST', `/api/games/${id}/${action}`);

	const until = Date.now() + OPERATION_TIMEOUT_MS;
	let printed = 0;

	while (Date.now() < until) {
		await Bun.sleep(1000);

		const { operation } = await api('GET', `/api/games/${id}`);

		for (const line of operation.lines.slice(printed)) console.log(`  ${line}`);
		printed = operation.lines.length;

		if (!operation.running) {
			if (!operation.ok) fail(`${action} failed: ${operation.error}`);

			return;
		}
	}

	fail(`${action} took too long`);
};

const folder = path.join(GAMES, path.basename(from));

if (existsSync(folder)) console.log(`${folder} is already here; updating it from ${from}`);
else {
	console.log(`Cloning ${from} to ${folder}`);
	await git('clone', '--quiet', from, folder);
}

const games = await api('GET', '/api/games');
const game = games.find(each => each.dir === folder) ?? (await api('POST', '/api/games', { dir: folder, port }));

console.log(`${game.name} on the hub, on port ${game.port}`);

// An update restarts a game that's running; one that isn't is turned on after it
await follow(game.id, 'update');
if (!(await api('GET', `/api/games/${game.id}`)).unit.active) await follow(game.id, 'turnOn');

console.log(`${game.name} is on: http://${os.hostname()}:${game.port}`);
