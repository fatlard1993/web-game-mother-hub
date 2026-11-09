#!/usr/bin/env bun

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

const { options } = new Argi({
	options: {
		port: { type: 'number', alias: 'p', defaultValue: 8036 },
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
			description: 'The VPS games are exposed through, as ssh knows it (a Host in ~/.ssh/config)',
		},
		'public-host': { type: 'string', description: "The VPS's public address, as players will type it" },
		'public-port-base': { type: 'number', defaultValue: 9100, description: 'Exposed games get the ports after this' },
		'tunnel-port-base': {
			type: 'number',
			defaultValue: 19100,
			description: "Tunnels listen on the VPS's loopback at the ports after this",
		},
		slots: { type: 'number', defaultValue: 8, description: 'How many games can be exposed at once' },
	},
});

const db = await openDatabase({ path: options.database, defaults: { games: {} } });

const auth = await createAuth({
	db,
	password: options.password || process.env.MOTHER_HUB_PASSWORD,
	tokenFile: path.join(path.dirname(db.path), '.web-game-mother-hub-token'),
});

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
	hubDir: path.resolve(import.meta.dir, '..'),
	resetsDir: path.join(path.dirname(db.path), '.web-game-mother-hub-resets'),
	exposure: {
		sshHost: options['vps-host'] ?? null,
		publicHost: options['public-host'] ?? null,
		publicPortBase: options['public-port-base'],
		tunnelPortBase: options['tunnel-port-base'],
		slots: options.slots,
	},
});

await serve({ port: options.port, router: createRouter({ hub, auth, projectsRoot: options.projects }) });

devConsole();
