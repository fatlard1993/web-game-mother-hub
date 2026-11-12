import { Button, Component, Content, Dialog, EmptyState, Notify, Toolbar, styled } from '@vanilla-bean/components';

import { closeAll, failure, getGames, getHub, logOut } from './api';
import { aboutDialog } from './About';
import { addDialog, loginDialog, logsDialog, settingsDialog } from './dialogs';
import GameCard from './GameCard';

const POLL_MS = 3000;
// Quicker while something is under way, so its output reads as it comes
const BUSY_POLL_MS = 1000;

const Grid = styled.Component`
	&.stale {
		opacity: 0.45;
		filter: grayscale(0.7);
	}

	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
	gap: 12px;
	padding: 12px 0;
`;

export default class Hub extends Component {
	static schema = { admin: {}, onSessionChanged: {} };

	build() {
		this.cards = new Map();
		this.exposure = { configured: false };
		this.hubInfo = { shots: false };

		this.closeAllButton = new Button({
			icon: 'shield-halved',
			textContent: 'Close everything to the internet',
			intent: 'warning',
			style: { display: 'none' },
			onPointerPress: async () => {
				if (!(await Dialog.confirm({ header: 'Close every game to the internet?', confirmLabel: 'Close them' })))
					return;

				const response = await closeAll();

				if (!response.ok) new Notify({ intent: 'danger', content: await failure(response) });

				this.refresh();
			},
		});

		const { admin, onSessionChanged } = this.options;

		new Toolbar({
			appendTo: this,
			variant: 'bar',
			heading: 'Mother Hub',
			append: admin
				? [
						this.closeAllButton,
						new Button({
							icon: 'plus',
							textContent: 'Add a game',
							onPointerPress: () => addDialog(() => this.refresh()),
						}),
						new Button({
							icon: 'right-from-bracket',
							variant: 'flat',
							tooltip: 'Log out',
							onPointerPress: async () => {
								await logOut();
								onSessionChanged?.();
							},
						}),
					]
				: [
						new Button({
							icon: 'lock',
							variant: 'flat',
							textContent: 'Admin',
							tooltip: 'Log in to turn games on and off, update, reset and share them',
							onPointerPress: () => loginDialog(() => onSessionChanged?.()),
						}),
					],
		});

		this.grid = new Grid();
		this.empty = new EmptyState({
			icon: 'gamepad',
			title: 'No games yet',
			message: admin
				? 'Add one from its folder, and it can be turned on, updated, reset and shared from here.'
				: 'There are no games here yet.',
			style: { display: 'none' },
		});

		this.offline = new EmptyState({
			icon: 'triangle-exclamation',
			title: "Can't reach the hub right now",
			message: 'The games may still be running. This page tries again every few seconds.',
			action: { textContent: 'Try again', onPointerPress: () => this.refresh() },
			style: { display: 'none' },
		});

		// Until the first poll answers
		this.loading = new EmptyState({ loading: true });

		new Content({ appendTo: this, column: 1200, append: [this.loading, this.offline, this.empty, this.grid] });

		Object.assign(this.elem.style, { display: 'flex', flexDirection: 'column', height: '100%' });

		getHub()
			.then(response => response.json())
			.then(hubInfo => {
				this.hubInfo = hubInfo;
				this.exposure = hubInfo.exposure;
			})
			.finally(() => this.refresh());
	}

	async refresh() {
		clearTimeout(this.timer);

		// A page that's been replaced (logged in or out) stops; a hidden tab waits to be looked at again
		if (this.stopped) return;
		if (document.hidden) {
			document.addEventListener('visibilitychange', () => this.refresh(), { once: true });

			return;
		}

		let games = null;

		try {
			const response = await getGames();

			if (response.status === 401 && this.options.admin) {
				new Notify({ intent: 'warning', content: 'Your admin login ran out: log in again to run the games' });

				return this.options.onSessionChanged?.();
			}

			games = response.ok ? await response.json() : null;
		} catch {
			// The hub restarting, or the network gone: said below, and the next poll finds it again
		}

		this.loading.elem.style.display = 'none';
		this.offline.elem.style.display = games ? 'none' : '';
		this.grid.elem.classList.toggle('stale', !games);
		if (games) this.show(games);

		this.timer = setTimeout(
			() => this.refresh(),
			games?.some(game => game.operation?.running) ? BUSY_POLL_MS : POLL_MS,
		);
	}

	destroy() {
		this.stopped = true;
		clearTimeout(this.timer);
		super.destroy();
	}

	show(games) {
		this.shown = true;
		this.empty.elem.style.display = games.length === 0 ? '' : 'none';
		this.closeAllButton.elem.style.display = games.some(game => game.exposed) ? '' : 'none';

		const seen = new Set();

		for (const game of games) {
			seen.add(game.id);

			// A card is rebuilt only when what it shows changed, or once a minute so its "started 5m ago" and "Starting…"
			// move on; a press rarely lands on a card being replaced for nothing
			const signature = JSON.stringify({ ...game, report: undefined, minute: Math.floor(Date.now() / 60_000) });
			const current = this.cards.get(game.id);

			if (current?.signature === signature) {
				current.card.showReport(game.report);
				continue;
			}

			const card = new GameCard({
				game,
				exposure: this.exposure,
				onChanged: () => this.refresh(),
				admin: this.options.admin,
				onLogs: logsDialog,
				onAbout: about =>
					aboutDialog(about, () => this.refresh(), {
						canPhotograph: this.hubInfo.shots,
						canChooseCover: !!this.options.admin,
					}),
				onSettings: () => settingsDialog(game, () => this.refresh()),
			});

			if (current) current.card.elem.replaceWith(card.elem);
			else this.grid.elem.append(card.elem);

			current?.card.destroy();
			this.cards.set(game.id, { card, signature });
		}

		for (const [id, { card }] of this.cards) {
			if (seen.has(id)) continue;

			card.destroy();
			this.cards.delete(id);
		}
	}
}
