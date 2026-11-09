#!/usr/bin/env bun

// One exposed game's way out: an SSH reverse tunnel from this machine to the VPS, run as its own systemd unit, which
// starts it again whenever the connection drops. The VPS end listens on its own loopback only; Caddy there is what
// faces the internet and hands each public port to its tunnel (see scripts/vpsCaddyfile.js).

import Argi from 'argi-cli';

const { options } = new Argi({
	options: {
		host: { type: 'string', description: 'The VPS, as ssh knows it (a Host in ~/.ssh/config)' },
		remote: { type: 'number', description: "The port on the VPS's loopback the tunnel listens on" },
		local: { type: 'number', description: "The game's port here" },
	},
});

if (!options.host || !options.remote || !options.local) {
	console.error('tunnel needs --host, --remote and --local');
	process.exit(2);
}

const ssh = Bun.spawn(
	[
		'ssh',
		'-N',
		'-o',
		'BatchMode=yes',
		// A forward the VPS refuses (its port still held by a dead session) is a failure, not a quiet tunnel to nowhere
		'-o',
		'ExitOnForwardFailure=yes',
		'-o',
		'ServerAliveInterval=15',
		'-o',
		'ServerAliveCountMax=3',
		'-R',
		`127.0.0.1:${options.remote}:127.0.0.1:${options.local}`,
		options.host,
	],
	{ stdio: ['ignore', 'inherit', 'inherit'] },
);

process.on('SIGTERM', () => ssh.kill('SIGTERM'));

process.exit(await ssh.exited);
