import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import { ValidationError } from '@vanilla-bean/components/app';

// Two shapes of game run here, and how each takes its port and keeps its saves is read from the game itself:
// - a house app (void-driller, humanity): `bun server/index.js --port N`, its save file named by its `db:clean` script
//   and its usual port by its `service:enable` script
// - a web-game-framework scaffold (the arcade's games): `bun server.js` with PORT set, saving to ./data/games.json

const expandHome = file => (file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);

export const gameId = name =>
	String(name)
		.toLowerCase()
		.replace(/^@[^/]+\//, '')
		.replace(/[^a-z0-9.-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60) || 'game';

const titleCase = name => name.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());

const readPackage = async dir => {
	try {
		return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
	} catch {
		return null;
	}
};

const scriptPort = scripts => Number(/--port[ =](\d+)/.exec(scripts?.['service:enable'] ?? '')?.[1]) || null;

const scriptDatabases = scripts =>
	[...(scripts?.['db:clean'] ?? '').matchAll(/rm\s+(?:-\w+\s+)*([^\s&;|]+)/g)].map(match => expandHome(match[1]));

// A house app without a db:clean script still names its save file's default in its server, as
// `path.join(os.homedir(), '.humanity.json')`
const serverDatabases = async root => {
	const serverDir = path.join(root, 'server');
	let files = [];

	try {
		files = (await readdir(serverDir)).filter(file => file.endsWith('.js') && !file.endsWith('.test.js'));
	} catch {
		return [];
	}

	const found = new Set();

	for (const file of files) {
		const source = await readFile(path.join(serverDir, file), 'utf8');

		for (const match of source.matchAll(/homedir\(\),\s*['"`](\.[\w.-]+\.json)['"`]/g))
			found.add(path.join(os.homedir(), match[1]));
	}

	return [...found];
};

const appDatabases = async (root, scripts) => {
	const fromScript = scriptDatabases(scripts);

	return fromScript.length > 0 ? fromScript : serverDatabases(root);
};

export const detectGame = async dir => {
	const root = path.resolve(expandHome(String(dir ?? '').trim()));
	const pkg = await readPackage(root);

	if (!pkg) throw new ValidationError(`No package.json in ${root}`);
	if (!pkg.scripts?.start) throw new ValidationError(`${root} has no start script, so there's nothing to run`);

	const scaffold = !existsSync(path.join(root, 'server/index.js')) && existsSync(path.join(root, 'server.js'));

	return {
		id: gameId(pkg.name || path.basename(root)),
		name: titleCase(pkg.name?.replace(/^@[^/]+\//, '') || path.basename(root)),
		dir: root,
		entry: scaffold ? 'server.js' : 'server/index.js',
		portVia: scaffold ? 'env' : 'flag',
		port: scriptPort(pkg.scripts),
		databases: scaffold ? [path.join(root, 'data/games.json')] : await appDatabases(root, pkg.scripts),
		hasBuild: !!pkg.scripts.build,
	};
};

// Built on the framework, made by paude's arcade, keeping a save file to clean, or saying it's a game
const looksLikeGame = (pkg, dir) =>
	!!pkg?.scripts?.start &&
	(!!pkg.dependencies?.['@fatlard1993/web-game-framework'] ||
		existsSync(path.join(dir, '.paude-arcade.json')) ||
		!!pkg.scripts['db:clean'] ||
		/\bgame\b/i.test(pkg.description ?? ''));

// The folders under the projects root that look like games, for the add dialog to offer
export const findCandidates = async (projectsRoot, known = [], self = path.resolve(import.meta.dir, '..')) => {
	let entries = [];

	try {
		entries = await readdir(projectsRoot, { withFileTypes: true });
	} catch {
		return [];
	}

	const candidates = await Promise.all(
		entries
			.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
			.map(async entry => {
				const dir = path.join(projectsRoot, entry.name);

				if (dir === self || known.includes(dir) || !looksLikeGame(await readPackage(dir), dir)) return null;

				return detectGame(dir).catch(() => null);
			}),
	);

	return candidates.filter(Boolean);
};
