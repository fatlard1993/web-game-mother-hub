import { Button, Component, Content, Dialog, EmptyState, Notify, Toolbar, styled } from '@vanilla-bean/components';

import { closeAll, failure, getGames, getHub, logOut } from './api';
import { aboutDialog } from './About';
import { addDialog, logsDialog, settingsDialog } from './dialogs';
import GameCard from './GameCard';

const POLL_MS = 3000;
// Quicker while something is under way, so its output reads as it comes
const BUSY_POLL_MS = 1000;

const Grid = styled.Component`
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
	gap: 12px;
	padding: 12px 0;
`;

export default class Hub extends Component {
	static schema = { onLoggedOut: {} };

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

		new Toolbar({
			appendTo: this,
			variant: 'bar',
			heading: 'Mother Hub',
			append: [
				this.closeAllButton,
				new Button({ icon: 'plus', textContent: 'Add a game', onPointerPress: () => addDialog(() => this.refresh()) }),
				new Button({
					icon: 'right-from-bracket',
					variant: 'flat',
					tooltip: 'Log out',
					onPointerPress: async () => {
						await logOut();
						this.options.onLoggedOut?.();
					},
				}),
			],
		});

		this.grid = new Grid();
		this.empty = new EmptyState({
			icon: 'gamepad',
			heading: 'No games yet',
			body: 'Add one from its folder, and it can be turned on, updated, reset and shared from here.',
			style: { display: 'none' },
		});

		new Content({ appendTo: this, column: 1200, append: [this.empty, this.grid] });

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

		let games = null;

		try {
			const response = await getGames();

			if (response.status === 401) return this.options.onLoggedOut?.();

			games = response.ok ? await response.json() : null;
		} catch {
			// The hub restarting: the next poll finds it
		}

		if (games) this.show(games);

		if (!this.elem.isConnected && this.shown) return;

		this.timer = setTimeout(
			() => this.refresh(),
			games?.some(game => game.operation?.running) ? BUSY_POLL_MS : POLL_MS,
		);
	}

	show(games) {
		this.shown = true;
		this.empty.elem.style.display = games.length === 0 ? '' : 'none';
		this.closeAllButton.elem.style.display = games.some(game => game.exposed) ? '' : 'none';

		const seen = new Set();

		for (const game of games) {
			seen.add(game.id);

			// A card is rebuilt only when what it shows changed, so a press never lands on a card being replaced for nothing
			const signature = JSON.stringify({ ...game, report: undefined });
			const current = this.cards.get(game.id);

			if (current?.signature === signature) {
				current.card.showReport(game.report);
				continue;
			}

			const card = new GameCard({
				game,
				exposure: this.exposure,
				onChanged: () => this.refresh(),
				onLogs: logsDialog,
				onAbout: about => aboutDialog(about, () => this.refresh(), { canPhotograph: this.hubInfo.shots }),
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
