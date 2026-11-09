#!/usr/bin/env bun

// Prints the Caddyfile the VPS needs, once: a public port for each slot, each handed to the loopback port its game's
// tunnel listens on. Nothing on the VPS changes when a game is exposed or closed; only the tunnel comes and goes, and
// with no tunnel there the port answers that the game isn't open.
//   bun run vps:caddyfile -- --public-host 203.0.113.7 > Caddyfile

import Argi from 'argi-cli';

export const vpsCaddyfile = ({ publicHost, publicPortBase = 9100, tunnelPortBase = 19100, slots = 8 }) => {
	// Let's Encrypt certifies a bare IP only on its short-lived profile
	const isIp = /^[\d.]+$|:/.test(publicHost);
	const tls = isIp ? '\ttls {\n\t\tissuer acme {\n\t\t\tprofile shortlived\n\t\t}\n\t}\n' : '';

	return Array.from(
		{ length: slots },
		(_, index) => `${publicHost}:${publicPortBase + index + 1} {
${tls}	reverse_proxy 127.0.0.1:${tunnelPortBase + index + 1}
	handle_errors {
		respond "This game isn't open right now." 503
	}
}
`,
	).join('\n');
};

if (import.meta.main) {
	const { options } = new Argi({
		options: {
			'public-host': { type: 'string', description: "The VPS's public address: an IP or a domain name" },
			'public-port-base': { type: 'number', defaultValue: 9100 },
			'tunnel-port-base': { type: 'number', defaultValue: 19100 },
			slots: { type: 'number', defaultValue: 8 },
		},
	});

	if (!options['public-host']) {
		console.error('Needs --public-host, the address players will type');
		process.exit(2);
	}

	process.stdout.write(
		vpsCaddyfile({
			publicHost: options['public-host'],
			publicPortBase: options['public-port-base'],
			tunnelPortBase: options['tunnel-port-base'],
			slots: options.slots,
		}),
	);
}
