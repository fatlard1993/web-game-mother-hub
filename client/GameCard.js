import { Button, Card, Component, Dialog, Elem, Notify, styled } from '@vanilla-bean/components';

import { failure, gameAction } from './api';
import { capitalize, exposureState, gameState } from './gameState';

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
		display: flex;
		flex-direction: column;
		gap: ${space.sm};

		.title {
			display: flex;
			align-items: center;
			gap: ${space.sm};
			font-weight: bold;
			font-size: 1.1em;
		}

		.title a {
			margin-left: auto;
			font-weight: normal;
			font-size: 0.85em;
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

	build() {
		const { game, exposure } = this.options;
		const state = gameState(game);
		const open = exposureState(game);
		const busy = state.key === 'busy';
		const on = game.unit.active || game.unit.state === 'auto-restart';
		const lanUrl = `http://${location.hostname}:${game.port}`;

		new Component({
			appendTo: this,
			addClass: 'title',
			append: [
				light(state.key),
				new Elem({ tag: 'span', textContent: game.name }),
				game.unit.active && new Elem({ tag: 'a', href: lanUrl, target: '_blank', textContent: `:${game.port}` }),
			].filter(Boolean),
		});

		new Component({
			appendTo: this,
			addClass: 'row',
			append: [new Elem({ tag: 'span', textContent: state.label })],
		});

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
