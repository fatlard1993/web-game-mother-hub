import { Button, Card, Component, Dialog, Elem, Notify, styled } from '@vanilla-bean/components';

import { failure, gameAction } from './api';
import { capitalize, exposureState, gameState, reportChips } from './gameState';

const LIGHTS = {
	up: 'success',
	busy: 'info',
	starting: 'info',
	silent: 'warning',
	crashing: 'danger',
	off: null,
	open: 'success',
	connecting: 'info',
	waiting: 'warning',
	failing: 'danger',
	closed: null,
};

const StyledCard = styled(
	Card,
	({ colors, space }) => `
		/* --game-color is set per card, from the game's own manifest */
		display: flex;
		flex-direction: column;
		gap: ${space.sm};
		border-top: 3px solid var(--game-color);
		background-image: linear-gradient(
			165deg,
			color-mix(in srgb, var(--game-color) 24%, transparent),
			transparent 55%
		);
		transition: filter 0.3s;

		&.off {
			background-image: linear-gradient(
				165deg,
				color-mix(in srgb, var(--game-color) 8%, transparent),
				transparent 55%
			);
		}

		&.off .tile {
			filter: grayscale(0.6) brightness(0.8);
		}

		.title {
			display: flex;
			align-items: center;
			gap: ${space.sm};
		}

		.title .name {
			display: flex;
			flex-direction: column;
			min-width: 0;
		}

		.title .name strong {
			font-size: 1.15em;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.title a {
			margin-left: auto;
			align-self: flex-start;
			font-size: 0.85em;
		}

		.tile {
			position: relative;
			flex: none;
			display: flex;
			align-items: center;
			justify-content: center;
			width: 52px;
			height: 52px;
			border-radius: 12px;
			background: var(--game-color);
			box-shadow: 0 2px 10px color-mix(in srgb, var(--game-color) 45%, transparent);
			font-size: 1.6em;
			font-weight: bold;
			color: ${colors.white};
			text-shadow: 0 1px 2px ${colors.alpha(colors.vantablack, 0.6)};
			transition: filter 0.3s;
		}

		.tile img {
			width: 70%;
			height: 70%;
			object-fit: contain;
			image-rendering: pixelated;
		}

		.tile .light {
			position: absolute;
			right: -4px;
			bottom: -4px;
			width: 14px;
			height: 14px;
			border: 2px solid ${colors.surface};
		}

		.metrics {
			display: flex;
			flex-wrap: wrap;
			gap: ${space.xs};
		}

		.metrics:empty {
			display: none;
		}

		.chip {
			display: inline-flex;
			align-items: baseline;
			gap: 0.35em;
			padding: 2px 8px;
			border-radius: 999px;
			background: ${colors.alpha(colors.white, 0.06)};
			font-size: 0.85em;
		}

		.chip b {
			font-variant-numeric: tabular-nums;
		}

		.chip span {
			color: ${colors.muted};
		}

		.chip.lead {
			background: color-mix(in srgb, var(--game-color) 30%, transparent);
		}

		.chip.lead span {
			color: inherit;
		}

		.chip.quiet {
			background: none;
			padding-inline: 0;
		}

		.row {
			display: flex;
			align-items: center;
			gap: ${space.sm};
			flex-wrap: wrap;
		}

		.muted {
			color: ${colors.muted};
			font-size: 0.85em;
		}

		.light {
			flex: none;
			width: 0.7em;
			height: 0.7em;
			border-radius: 50%;
			background: ${colors.gray};
		}

		.light.success { background: ${colors.success}; box-shadow: 0 0 6px ${colors.success}; }
		.light.info { background: ${colors.info}; }
		.light.warning { background: ${colors.warning}; }
		.light.danger { background: ${colors.danger}; box-shadow: 0 0 6px ${colors.danger}; }

		pre {
			margin: 0;
			max-height: 10em;
			overflow: auto;
			font-size: 0.75em;
			white-space: pre-wrap;
			background: ${colors.alpha(colors.vantablack, 0.3)};
			padding: ${space.xs};
		}

		.error { color: ${colors.light(colors.danger)}; }
	`,
);

const light = key => new Elem({ addClass: ['light', LIGHTS[key]].filter(Boolean) });

const ago = stamp => {
	const minutes = Math.round((Date.now() - Date.parse(stamp)) / 60_000);

	if (minutes < 1) return 'just now';

	return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
};

export default class GameCard extends StyledCard {
	static schema = {
		game: {},
		exposure: {},
		onChanged: {},
		onSettings: {},
		onLogs: {},
	};

	async act(action, { confirm } = {}) {
		const { game, onChanged } = this.options;

		if (confirm && !(await Dialog.confirm(confirm))) return;

		const response = await gameAction(game.id, action);

		if (!response.ok) new Notify({ intent: 'danger', content: `${game.name}: ${await failure(response)}` });

		onChanged?.();
	}

	// Live numbers change every poll; they're redrawn here alone, not the whole card under a pointer about to press it
	showReport(report) {
		this.metrics.elem.replaceChildren(
			...reportChips(report).map(
				chip =>
					new Elem({
						addClass: ['chip', chip.lead && 'lead', chip.quiet && 'quiet'].filter(Boolean),
						append: [
							new Elem({ tag: 'b', textContent: chip.value }),
							new Elem({ tag: 'span', textContent: chip.label }),
						],
					}).elem,
			),
		);
	}

	build() {
		const { game, exposure } = this.options;
		const state = gameState(game);
		const open = exposureState(game);
		const busy = state.key === 'busy';
		const on = game.unit.active || game.unit.state === 'auto-restart';
		const lanUrl = `http://${location.hostname}:${game.port}`;

		this.elem.style.setProperty('--game-color', game.look.color);
		if (!on) this.addClass('off');

		new Component({
			appendTo: this,
			addClass: 'title',
			append: [
				new Elem({
					addClass: 'tile',
					append: [
						game.look.icon
							? new Elem({ tag: 'img', src: game.look.icon, alt: '' })
							: new Elem({ tag: 'span', textContent: [...game.name][0]?.toUpperCase() ?? '?' }),
						light(state.key),
					],
				}),
				new Elem({
					addClass: 'name',
					append: [
						new Elem({ tag: 'strong', textContent: game.name, title: game.name }),
						new Elem({ tag: 'span', textContent: state.label }),
					],
				}),
				game.unit.active && new Elem({ tag: 'a', href: lanUrl, target: '_blank', textContent: `:${game.port}` }),
			].filter(Boolean),
		});

		this.metrics = new Elem({ appendTo: this, addClass: 'metrics' });
		this.showReport(game.report);

		if (game.git) {
			const { branch, commit, age, subject, dirty, behind } = game.git;
			const notes = [behind > 0 && `${behind} new upstream`, dirty && 'has local changes'].filter(Boolean);

			new Component({
				appendTo: this,
				addClass: ['row', 'muted'],
				textContent: `${branch} @ ${commit}, ${age}${notes.length > 0 ? ` · ${notes.join(' · ')}` : ''}`,
				title: subject,
			});
		}

		const exposeRow = new Component({ appendTo: this, addClass: 'row', append: [light(open.key)] });

		if (game.exposed && game.publicUrl) {
			new Elem({ appendTo: exposeRow, tag: 'a', href: game.publicUrl, target: '_blank', textContent: game.publicUrl });
			new Button({
				appendTo: exposeRow,
				icon: 'copy',
				variant: 'flat',
				tooltip: 'Copy the address',
				onPointerPress: () =>
					navigator.clipboard
						.writeText(game.publicUrl)
						.then(() => new Notify({ intent: 'success', content: 'Copied' })),
			});
		}

		new Elem({ appendTo: exposeRow, tag: 'span', addClass: 'muted', textContent: open.label });

		if (exposure.configured) {
			new Button({
				appendTo: exposeRow,
				variant: 'chip',
				disabled: busy,
				textContent: game.exposed ? 'Close' : 'Open to the internet',
				onPointerPress: () =>
					game.exposed
						? this.act('conceal')
						: this.act('expose', {
								confirm: {
									header: `Open ${game.name} to the internet?`,
									body: 'Anyone with its address can reach it until you close it.',
									confirmLabel: 'Open it',
									intent: 'warning',
								},
							}),
			});
		}

		const { operation } = game;

		if (operation && (operation.running || !operation.ok)) {
			if (operation.error)
				new Elem({
					appendTo: this,
					addClass: 'error',
					textContent: `${capitalize(operation.kind)} failed: ${operation.error}`,
				});

			if (operation.lines.length > 0) {
				const pre = new Elem({ appendTo: this, tag: 'pre', textContent: operation.lines.join('\n') });

				requestAnimationFrame(() => (pre.elem.scrollTop = pre.elem.scrollHeight));
			}
		} else if (operation?.ok && operation.endedAt) {
			new Elem({
				appendTo: this,
				addClass: 'muted',
				textContent: `${capitalize(operation.kind)}: done ${ago(operation.endedAt)}`,
			});
		}

		new Component({
			appendTo: this,
			addClass: 'row',
			append: [
				on
					? new Button({
							icon: 'power-off',
							textContent: 'Turn off',
							disabled: busy,
							onPointerPress: () => this.act('turnOff'),
						})
					: new Button({
							icon: 'power-off',
							textContent: 'Turn on',
							intent: 'success',
							disabled: busy,
							onPointerPress: () => this.act('turnOn'),
						}),
				on &&
					new Button({
						icon: 'rotate-right',
						variant: 'flat',
						tooltip: 'Restart',
						disabled: busy,
						onPointerPress: () => this.act('restart'),
					}),
				new Button({
					icon: 'download',
					variant: 'flat',
					tooltip:
						game.git?.behind > 0 ? 'Update: pull, install, build, restart' : 'Update (pull, install, build, restart)',
					intent: game.git?.behind > 0 ? 'info' : undefined,
					disabled: busy,
					onPointerPress: () => this.act('update'),
				}),
				new Button({
					icon: 'cloud-arrow-down',
					variant: 'flat',
					tooltip: 'Check for updates',
					disabled: busy,
					onPointerPress: () => this.act('check'),
				}),
				new Button({
					icon: 'eraser',
					variant: 'flat',
					tooltip: 'Reset: start over with no saves',
					intent: 'danger',
					disabled: busy,
					onPointerPress: () =>
						this.act('reset', {
							confirm: {
								header: `Reset ${game.name}?`,
								body: 'Every game and player saved in it is cleared. The old save files are moved aside, not deleted.',
								confirmLabel: 'Reset',
								intent: 'danger',
							},
						}),
				}),
				new Button({
					icon: 'scroll',
					variant: 'flat',
					tooltip: 'Logs',
					onPointerPress: () => this.options.onLogs?.(game),
				}),
				new Button({
					icon: 'gear',
					variant: 'flat',
					tooltip: 'Settings',
					onPointerPress: () => this.options.onSettings?.(game),
				}),
			].filter(Boolean),
		});
	}
}
