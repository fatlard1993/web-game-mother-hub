const STARTING_GRACE_MS = 20_000;

// One word for how a game is doing, from what systemd says of its unit and whether its port answers, with the line
// that says it to a person
export const gameState = (game, now = Date.now()) => {
	const { unit, health, operation } = game;

	if (operation?.running) return { key: 'busy', label: `${capitalize(operation.kind)}…` };

	if (unit.state === 'auto-restart' || unit.state === 'failed')
		return { key: 'crashing', label: unit.state === 'failed' ? 'Crashed' : `Crashing (restarted ${unit.restarts}×)` };

	if (!unit.active) return { key: 'off', label: 'Off' };

	if (health.ok) return { key: 'up', label: `Running${unit.since ? `, started ${since(unit.since, now)}` : ''}` };

	const startedAt = Date.parse(unit.since);

	if (Number.isFinite(startedAt) && now - startedAt < STARTING_GRACE_MS) return { key: 'starting', label: 'Starting…' };

	return { key: 'silent', label: 'Running, but not answering' };
};

export const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);

export const exposureState = game => {
	if (!game.exposed) return { key: 'closed', label: 'Only in the house' };

	if (game.tunnel?.active && game.unit.active) return { key: 'open', label: 'Open to the internet' };

	if (!game.unit.active) return { key: 'waiting', label: 'Open once it is on' };

	// ssh gives up and systemd tries again every few seconds; after a few, it's not about to work by itself
	if (game.tunnel?.restarts > 2) return { key: 'failing', label: 'Can’t reach the VPS (its logs say why)' };

	return { key: 'connecting', label: 'Reaching the VPS…' };
};

const since = (stamp, now) => {
	const minutes = Math.round((now - Date.parse(stamp)) / 60_000);

	if (!Number.isFinite(minutes)) return stamp;
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;

	return `${Math.round(minutes / 1440)}d ago`;
};
