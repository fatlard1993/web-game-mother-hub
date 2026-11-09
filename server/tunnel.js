#!/usr/bin/env bun

// One exposed game's way out, run as its own systemd unit, which starts it again whenever it drops: from the htpc, an
// ssh reverse tunnel to the VPS, with a key of its own the VPS lets forward those ports and do nothing else; on the
// VPS itself (--host local), a relay on its loopback. Either way, Caddy there faces the internet and hands each public
// port to its tunnel (dotfiles' profiles/vps/dot-update.d/caddy).

import Argi from 'argi-cli';

import { relay } from './relay';

const { options } = new Argi({
	options: {
		host: { type: 'string', description: 'The VPS, as ssh takes it: user@address, or a Host in ~/.ssh/config' },
		identity: { type: 'string', description: 'The key to reach it with, alone' },
		remote: { type: 'number', description: "The port on the VPS's loopback the tunnel listens on" },
		local: { type: 'number', description: "The game's port here" },
	},
});

if (!options.host || !options.remote || !options.local) {
	console.error('tunnel needs --host, --remote and --local');
	process.exit(2);
}

if (options.host === 'local') {
	relay({ listenPort: options.remote, targetPort: options.local });

	console.log(`Forwarding 127.0.0.1:${options.remote} to the game on :${options.local}`);
} else {
	const ssh = Bun.spawn(
		[
			'ssh',
			'-N',
			'-o',
			'BatchMode=yes',
			...(options.identity ? ['-i', options.identity, '-o', 'IdentitiesOnly=yes'] : []),
			// The first tunnel meets the VPS's host key, kept from then on; one that changes after is refused
			'-o',
			'StrictHostKeyChecking=accept-new',
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
}
