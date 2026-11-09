import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import { service } from '@vanilla-bean/components/app';

// The games run as instances of the bun-server@ template unit that dotfiles links (profiles/htpc/systemd), the same
// units its game-servers loop and shelf-game start: bun-server@<folder> runs `bun run start` in ~/Projects/<folder>.
// The hub only turns them on and off and sets their port, in the same port.conf drop-in shelf-game writes, so there's
// one place a game's port is kept. Tunnels are the hub's own units, made with vbc's service.

export const gameUnit = id => `bun-server@${id}`;
export const tunnelUnit = id => `mother-hub-tunnel-${id}`;
const TEMPLATE = 'bun-server@.service';

const parseShow = output =>
	Object.fromEntries(
		output
			.split('\n')
			.filter(line => line.includes('='))
			.map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
	);

export const createUnits = ({ run, home = os.homedir(), bun = process.execPath }) => {
	const systemctl = (...argv) => run(['systemctl', '--user', ...argv]);
	const dropIn = name => path.join(home, '.config', 'systemd', 'user', `${name}.service.d`, 'port.conf');

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

	// The port a game's drop-in gives it, as shelf-game or the hub wrote it
	const portOf = async name => {
		const text = await readFile(dropIn(name), 'utf8').catch(() => '');

		return Number(/PORT=(\d+)/.exec(text)?.[1] ?? /--port (\d+)/.exec(text)?.[1]) || null;
	};

	// A game that takes PORT gets it in the environment; one that takes --port gets it on the command line, and only
	// when it isn't the port it starts on by itself, so a house game needs no drop-in at all
	const writePort = async (name, { port, portVia, defaultPort }) => {
		const file = dropIn(name);

		if (portVia === 'flag' && port === defaultPort) return rm(file, { force: true });

		const contents =
			portVia === 'env'
				? `[Service]\nEnvironment=PORT=${port}\n`
				: `[Service]\nExecStart=\nExecStart=${bun} run start -- --port ${port}\n`;

		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, `# Written by web-game-mother-hub\n${contents}`);
	};

	const startGame = async (id, settings, onLine = () => {}) => {
		const name = gameUnit(id);

		await writePort(name, settings);
		await systemctl('daemon-reload');

		if ((await systemctl('cat', TEMPLATE)).code !== 0)
			throw new Error(`The ${TEMPLATE} template unit isn't installed here (dotfiles' game-servers links it)`);

		for (const argv of [
			['enable', '--now', name],
			['restart', name],
		]) {
			const { code, output } = await systemctl(...argv);

			if (output) onLine(output);
			if (code !== 0) throw new Error(output || `systemd couldn't ${argv[0]} ${name}`);
		}
	};

	// Written fresh each time, so a changed port takes; vbc's enable starts it and keeps it starting at boot
	const startTunnel = async (name, definition, onLine = () => {}) => {
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

	const removeTunnel = name =>
		service('disable', { name }, { run: argv => run(argv).then(result => result.code), log: () => {} });

	// The bun-server@ instances systemd knows of, by folder: what dotfiles' game-servers and shelf-game have started
	const instances = async () => {
		const { output } = await systemctl('list-units', '--all', '--plain', '--no-legend', 'bun-server@*');

		return [...output.matchAll(/^bun-server@([\w.-]+)\.service/gm)].map(match => match[1]);
	};

	const logs = async (name, lines = 200) =>
		(await run(['journalctl', '--user', '-u', name, '-n', String(lines), '--no-pager', '-o', 'short-iso'])).output;

	return {
		state,
		portOf,
		startGame,
		startTunnel,
		stop,
		restart,
		removeTunnel,
		instances,
		logs,
	};
};
