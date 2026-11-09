// Two roles. A player (anyone on the LAN, no login) finds the games and plays them: what each is, whether it's up, who's
// on it, where to play it, and where to share it while it's open to the internet. The admin (the password, or paude's
// token) runs them. A player's view of a game leaves out what's only the admin's business: where it lives on disk, its
// save files, its git state, and what the hub's commands printed.

export const forPlayer = game => ({
	id: game.id,
	name: game.name,
	port: game.port,
	lanUrl: game.lanUrl ?? null,
	exposed: !!game.exposed,
	publicUrl: game.exposed ? game.publicUrl : null,
	look: game.look,
	about: game.about,
	report: game.report ?? null,
	health: { ok: !!game.health?.ok },
	unit: {
		active: !!game.unit?.active,
		state: game.unit?.state,
		restarts: game.unit?.restarts ?? 0,
		since: game.unit?.since ?? null,
	},
	tunnel: game.tunnel ? { active: !!game.tunnel.active, restarts: game.tunnel.restarts ?? 0 } : null,
	operation: game.operation ? { kind: game.operation.kind, running: !!game.operation.running } : null,
	updateWaiting: game.updateWaiting ?? null,
});

// The hub's settings a player needs: none of the VPS's, only whether games can be opened to the internet at all
export const hubForPlayer = info => ({ exposure: { configured: !!info.exposure?.configured }, shots: false });
