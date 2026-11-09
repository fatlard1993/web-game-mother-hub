import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import { service } from '@vanilla-bean/components/app';

// The games run as instances of the bun-server@ template unit that dotfiles links (profiles/htpc/systemd), the same
// units its game-servers loop starts: bun-server@<folder> runs `bun run start` in ~/Projects/<folder>. The hub turns
// them on and off and sets their port in a port.conf drop-in, the one place a game's port is kept. Where there's no
// template (a machine paude hosts on by itself) the hub installs its own. Tunnels are the hub's own units.

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

export const createUnits = ({
	run,
	home = os.homedir(),
	bun = process.execPath,
	projectsRoot = path.join(home, 'Projects'),
}) => {
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

	// The port a game's drop-in gives it
	const portOf = async name => {
		const text = await readFile(dropIn(name), 'utf8').catch(() => '');

		return Number(/PORT=(\d+)/.exec(text)?.[1] ?? /--port (\d+)/.exec(text)?.[1]) || null;
	};

	// The port a running unit's processes are listening on: the truth for a game already running when the hub first
	// meets it, whatever its package says (or doesn't). The lowest, when it listens on more than one.
	const listeningPort = async name => {
		const { output: group } = await systemctl('show', name, '--property=ControlGroup', '--value');
		const pids = new Set(
			(await readFile(path.join('/sys/fs/cgroup', group.trim(), 'cgroup.procs'), 'utf8').catch(() => ''))
				.split('\n')
				.filter(Boolean),
		);

		if (pids.size === 0) return null;

		const { output } = await run(['ss', '-ltnpH']);
		const ports = output
			.split('\n')
			.filter(line => [...line.matchAll(/pid=(\d+)/g)].some(([, pid]) => pids.has(pid)))
			.map(line => Number(/:(\d+)\s/.exec(line)?.[1]))
			.filter(Boolean);

		return ports.length > 0 ? Math.min(...ports) : null;
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

	// The template the games run as, where dotfiles hasn't linked its own (a machine paude hosts games on by itself):
	// the same shape, a game's folder in the projects folder run with `bun run start`
	const installTemplate = async onLine => {
		const file = path.join(home, '.config', 'systemd', 'user', TEMPLATE);

		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(
			file,
			`# Written by web-game-mother-hub, there being no ${TEMPLATE} here. Each instance is a game: bun-server@<folder>.\n[Unit]\nDescription=%i bun server\n\n[Service]\nWorkingDirectory=${projectsRoot}/%i\nExecStart=${bun} run start\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`,
		);
		await systemctl('daemon-reload');
		onLine(`Installed the ${TEMPLATE} template unit`);
	};

	const startGame = async (id, settings, onLine = () => {}) => {
		const name = gameUnit(id);

		await writePort(name, settings);
		await systemctl('daemon-reload');

		if ((await systemctl('cat', TEMPLATE)).code !== 0) await installTemplate(onLine);

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

	// The bun-server@ instances systemd knows of, by folder
	const instances = async () => {
		const { output } = await systemctl('list-units', '--all', '--plain', '--no-legend', 'bun-server@*');

		return [...output.matchAll(/^bun-server@([\w.-]+)\.service/gm)].map(match => match[1]);
	};

	// The connections open to a port right now, less the hub's own (its health checks): players on a game that doesn't
	// say how many it has
	const connectionsTo = async (port, { except = process.pid } = {}) => {
		const lines = async argv => (await run(argv)).output.split('\n').filter(line => line.trim());
		const all = await lines(['ss', '-tnH', 'state', 'established', `( sport = :${port} )`]);
		const ours = (await lines(['ss', '-tnpH', 'state', 'established', `( dport = :${port} )`])).filter(line =>
			line.includes(`pid=${except},`),
		);

		return Math.max(0, all.length - ours.length);
	};

	const logs = async (name, lines = 200) =>
		(await run(['journalctl', '--user', '-u', name, '-n', String(lines), '--no-pager', '-o', 'short-iso'])).output;

	return {
		state,
		portOf,
		listeningPort,
		startGame,
		startTunnel,
		stop,
		restart,
		removeTunnel,
		instances,
		connectionsTo,
		logs,
	};
};
