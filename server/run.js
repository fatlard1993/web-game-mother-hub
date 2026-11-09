// What a command that runs a game's own code (its install and build scripts) is given of the hub's environment: enough
// to find its tools and its home, and nothing the hub keeps secret (its password, its token)
const PLAIN = [
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'LANG',
	'LC_ALL',
	'TERM',
	'TMPDIR',
	'XDG_RUNTIME_DIR',
	'BUN_INSTALL',
];

export const plainEnvironment = (from = process.env) =>
	Object.fromEntries(PLAIN.filter(name => from[name] !== undefined).map(name => [name, from[name]]));

// Runs a command to its end, its output (stdout and stderr together, in order) handed line by line to onLine as it
// comes and returned whole with the exit code. `plain` gives it the plain environment instead of the hub's own. One
// that runs past its timeout is killed and says so, so a stuck install or fetch can't hold a game busy for good.
const TIMEOUT_MS = 10 * 60 * 1000;

export const run = async (argv, { cwd, env, onLine, plain = false, timeout = TIMEOUT_MS } = {}) => {
	const child = Bun.spawn(argv, {
		cwd,
		env: { ...(plain ? plainEnvironment() : process.env), ...env },
		timeout,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});

	const lines = [];

	const read = async stream => {
		const decoder = new TextDecoder();
		let pending = '';

		for await (const chunk of stream) {
			pending += decoder.decode(chunk, { stream: true });

			const complete = pending.split('\n');

			pending = complete.pop();

			for (const line of complete) {
				lines.push(line);
				onLine?.(line);
			}
		}

		if (pending) {
			lines.push(pending);
			onLine?.(pending);
		}
	};

	await Promise.all([read(child.stdout), read(child.stderr)]);

	const code = await child.exited;

	if (child.signalCode && child.killed) {
		lines.push(`Stopped after ${Math.round(timeout / 1000)}s: it took too long`);
		onLine?.(lines.at(-1));
	}

	return { code: code ?? 1, output: lines.join('\n') };
};
