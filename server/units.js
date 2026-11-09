import { service } from '@vanilla-bean/components/app';

// Every game, and every game's tunnel, is a systemd user unit, so they all keep running through the hub's own restarts
// and come back at boot (with `loginctl enable-linger`). A game's unit is named for the game, the same unit its own
// `bun run service:enable` makes, so a game already running as a service is taken over rather than doubled.

export const tunnelUnit = id => `mother-hub-tunnel-${id}`;

const parseShow = output =>
	Object.fromEntries(
		output
			.split('\n')
			.filter(line => line.includes('='))
			.map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
	);

export const createUnits = ({ run }) => {
	const systemctl = (...argv) => run(['systemctl', '--user', ...argv]);

	const state = async name => {
		const { output } = await systemctl(
			'show',
			name,
			'--timestamp=unix',
			'--property=LoadState,ActiveState,SubState,UnitFileState,NRestarts,ActiveEnterTimestamp',
		);
		const show = parseShow(output);
		const enteredAt = Number(show.ActiveEnterTimestamp?.replace(/^@/, ''));

		return {
			installed: show.LoadState === 'loaded',
			active: show.ActiveState === 'active',
			// activating (auto-restart) is a crash loop, failed is given up on
			state: show.ActiveState === 'activating' ? show.SubState : show.ActiveState || 'unknown',
			enabled: show.UnitFileState === 'enabled',
			restarts: Number(show.NRestarts) || 0,
			since: show.ActiveState === 'active' && enteredAt > 0 ? new Date(enteredAt * 1000).toISOString() : null,
		};
	};

	// Written fresh every time it's started, so a changed port or entry takes; vbc's enable starts it and keeps it
	// starting at boot
	const start = async (name, definition, onLine) => {
		const code = await service(
			'enable',
			{ name, ...definition },
			{ run: argv => run(argv, { onLine }).then(result => result.code), log: onLine },
		);

		if (code !== 0) throw new Error(`systemd couldn't start ${name}`);
	};

	// Stopped and kept from starting at boot, its definition left in place
	const stop = async name => {
		const { code, output } = await systemctl('disable', '--now', name);

		if (code !== 0 && !/not loaded|does not exist/i.test(output)) throw new Error(output || `couldn't stop ${name}`);
	};

	const restart = async name => {
		const { code, output } = await systemctl('restart', name);

		if (code !== 0) throw new Error(output || `couldn't restart ${name}`);
	};

	const remove = name =>
		service('disable', { name }, { run: argv => run(argv).then(result => result.code), log: () => {} });

	const logs = async (name, lines = 200) =>
		(await run(['journalctl', '--user', '-u', name, '-n', String(lines), '--no-pager', '-o', 'short-iso'])).output;

	return { state, start, stop, restart, remove, logs };
};
