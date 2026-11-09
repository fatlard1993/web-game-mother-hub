// Runs a command to its end, its output (stdout and stderr together, in order) handed line by line to onLine as it
// comes and returned whole with the exit code
export const run = async (argv, { cwd, env, onLine } = {}) => {
	const child = Bun.spawn(argv, {
		cwd,
		env: { ...process.env, ...env },
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

	return { code: await child.exited, output: lines.join('\n') };
};
