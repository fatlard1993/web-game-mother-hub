#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from 'fs';
import os from 'os';
import path from 'path';

import { devConsole, handleExit, openDatabase, serve } from '@vanilla-bean/components/app';
import Argi from 'argi-cli';

import { createAuth } from './auth';
import { createHub } from './hub';
import { createRouter } from './router';
import { run } from './run';
import { createShots } from './shots';
import { createUnits } from './units';

handleExit();

// Each setting is a flag, or under bun-server@ (which runs plain `bun run start`) an environment variable, which
// dotfiles' mother-hub drop-in reads from the env file priv-config keeps
const env = process.env;

const { options } = new Argi({
	options: {
		port: { type: 'number', alias: 'p', defaultValue: Number(env.MOTHER_HUB_PORT) || 8036 },
		database: {
			type: 'string',
			alias: 'd',
			defaultValue: path.join(os.homedir(), '.web-game-mother-hub.json'),
			description: 'Database json file to use',
		},
		projects: {
			type: 'string',
			defaultValue: path.join(os.homedir(), 'Projects'),
			description: 'Where to look for games to add',
		},
		password: { type: 'string', description: 'The password for this page (or set MOTHER_HUB_PASSWORD)' },
		'vps-host': {
			type: 'string',
			defaultValue: env.MOTHER_HUB_VPS_HOST,
			description: 'The VPS games are exposed through, as ssh knows it (a Host in ~/.ssh/config)',
		},
		'public-host': {
			type: 'string',
			defaultValue: env.MOTHER_HUB_PUBLIC_HOST,
			description: "The VPS's public address, as players will type it",
		},
		'vps-key': {
			type: 'string',
			defaultValue: env.MOTHER_HUB_VPS_KEY || path.join(os.homedir(), '.ssh', 'mother-hub-tunnel'),
			description: 'The key the tunnels reach the VPS with (dotfiles makes one, the VPS lets it forward and no more)',
		},
		'lan-names': {
			type: 'string',
			defaultValue: env.MOTHER_HUB_LAN_NAMES || path.join(os.homedir(), '.config', 'lan-names.urls'),
			description: "Each service's address on the LAN, a `port url` line apiece (dotfiles' lan-names writes it)",
		},
		'public-port-base': { type: 'number', defaultValue: 9100, description: 'Exposed games get the ports after this' },
		'tunnel-port-base': {
			type: 'number',
			defaultValue: 19100,
			description: "Tunnels listen on the VPS's loopback at the ports after this",
		},
		'update-minutes': {
			type: 'number',
			defaultValue: Number(env.MOTHER_HUB_UPDATE_MINUTES) || 15,
			description: 'How often every game is checked upstream, and those set to update themselves are updated',
		},
		slots: { type: 'number', defaultValue: 8, description: 'How many games can be exposed at once' },
	},
});

const db = await openDatabase({ path: options.database, defaults: { games: {} } });

const auth = await createAuth({ db, password: options.password || env.MOTHER_HUB_PASSWORD });

// The LAN's names for what this machine serves, read again when the file changes (lan-names regenerates it)
let lanNames = { at: 0, urls: new Map() };

const lanUrl = port => {
	const changed = (() => {
		try {
			return statSync(options['lan-names']).mtimeMs;
		} catch {
			return 0;
		}
	})();

	if (changed !== lanNames.at) {
		const text = changed ? readFileSync(options['lan-names'], 'utf8') : '';

		lanNames = {
			at: changed,
			urls: new Map([...text.matchAll(/^(\d+)\s+(https?:\/\/\S+)$/gm)].map(([, at, url]) => [Number(at), url])),
		};
	}

	return lanNames.urls.get(port) ?? null;
};

const hubDir = path.resolve(import.meta.dir, '..');

const probe = async (url, timeout) => {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'manual' });
		const report = response.ok ? await response.json().catch(() => null) : null;

		return { ok: response.status < 500, report: report && typeof report === 'object' ? report : null };
	} catch {
		return { ok: false };
	}
};

const hub = createHub({
	db,
	units: createUnits({ run }),
	run,
	probe,
	shots: createShots({ dir: path.join(path.dirname(db.path), '.web-game-mother-hub-shots'), run }),
	projectsRoot: path.resolve(options.projects),
	// The hub runs as bun-server@<its folder> on the htpc, and isn't one of the games
	selfId: path.basename(hubDir),
	lanUrl,
	hubDir,
	resetsDir: path.join(path.dirname(db.path), '.web-game-mother-hub-resets'),
	exposure: {
		sshHost: options['vps-host'] ?? null,
		publicHost: options['public-host'] ?? null,
		publicPortBase: options['public-port-base'],
		tunnelPortBase: options['tunnel-port-base'],
		slots: options.slots,
		// Used when it's there; without it ssh offers whatever keys it has
		identity: existsSync(options['vps-key']) ? options['vps-key'] : null,
	},
});

await serve({ port: options.port, router: createRouter({ hub, auth, projectsRoot: options.projects }) });

// The first round a minute after starting, not in the same breath as a restart, and then every so often
setTimeout(() => hub.autoUpdateRound().catch(error => console.error('An auto-update round failed', error)), 60_000);
hub.startAutoUpdates(options['update-minutes'] * 60_000);

devConsole();
