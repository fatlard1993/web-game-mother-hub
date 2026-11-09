// The tunnel for a hub on the VPS itself (no ssh needed): connections to the loopback port Caddy serves are relayed,
// byte for byte, to the game's port. A socket takes only what it has room for, so what doesn't fit waits in an outbox
// and goes when the socket drains, and a side that closes is ended only once everything bound for it has gone.

const outbox = socket => {
	const queue = [];
	let ending = false;

	const flush = () => {
		while (queue.length > 0) {
			const sent = socket.write(queue[0]);

			if (sent < queue[0].byteLength) {
				queue[0] = queue[0].subarray(Math.max(sent, 0));

				return;
			}

			queue.shift();
		}

		if (ending) socket.end();
	};

	return {
		// Copied when kept: the chunk a socket hands over isn't promised to stay as it was after the handler returns
		send: chunk => {
			if (queue.length > 0) {
				queue.push(Buffer.from(chunk));

				return;
			}

			const sent = socket.write(chunk);

			if (sent < chunk.byteLength) queue.push(Buffer.from(chunk.subarray(Math.max(sent, 0))));
		},
		flush,
		end: () => {
			ending = true;
			flush();
		},
	};
};

export const relay = ({ listenPort, targetPort, hostname = '127.0.0.1' }) =>
	Bun.listen({
		hostname,
		port: listenPort,
		socket: {
			open: async client => {
				const state = { early: [], toClient: outbox(client), toGame: null, game: null };

				client.data = state;

				try {
					state.game = await Bun.connect({
						hostname,
						port: targetPort,
						socket: {
							data: (_, chunk) => state.toClient.send(chunk),
							drain: () => state.toGame?.flush(),
							close: () => state.toClient.end(),
							error: () => state.toClient.end(),
						},
					});
				} catch {
					client.end();

					return;
				}

				state.toGame = outbox(state.game);

				for (const chunk of state.early) state.toGame.send(chunk);
				state.early = null;
			},
			data: (client, chunk) =>
				client.data.early ? client.data.early.push(Buffer.from(chunk)) : client.data.toGame?.send(chunk),
			drain: client => client.data.toClient.flush(),
			close: client => client.data.toGame?.end(),
			error: client => client.data.toGame?.end(),
		},
	});
