import { Button, Component, Dialog, Elem, FormDialog, Notify, styled } from '@vanilla-bean/components';

import { addGame, editGame, failure, forgetGame, getCandidates, getLogs, logIn } from './api';

export const loginDialog = onLoggedIn =>
	new FormDialog({
		header: 'Mother Hub',
		saveLabel: 'Log in',
		intro: 'Turning games on and off, updating, resetting and sharing them takes the admin password.',
		inputs: [{ key: 'password', label: 'Password', type: 'password' }],
		data: { password: '' },
		onSave: async ({ password }) => {
			const response = await logIn(password);

			if (response.ok) onLoggedIn();

			return response;
		},
	});

const lines = text =>
	String(text ?? '')
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean);

export const settingsDialog = (game, onChanged) =>
	new FormDialog({
		header: game.name,
		inputs: [
			{ key: 'name', label: 'Name' },
			{ key: 'port', label: 'Port', type: 'number' },
			{ key: 'databases', label: 'Save files (one per line; a reset moves these aside)', type: 'textarea' },
		],
		data: { name: game.name, port: game.port, databases: game.databases.join('\n') },
		intro: `${game.dir}\nRuns ${game.entry}, its port given by ${game.portVia === 'env' ? 'PORT' : '--port'}.`,
		onSave: async ({ name, port, databases }) => {
			const response = await editGame(game.id, { name, port: Number(port), databases: lines(databases) });

			if (response.ok) onChanged();

			return response;
		},
		deleteLabel: 'Forget',
		confirmDelete: {
			header: `Forget ${game.name}?`,
			body: 'It comes off this page and is closed to the internet. Its unit stays as it is, on or off, and nothing in its folder is touched.',
			confirmLabel: 'Forget it',
		},
		onDelete: async () => {
			const response = await forgetGame(game.id);

			if (response.ok) onChanged();

			return response;
		},
	});

const Log = styled(
	Component,
	({ colors, space }) => `
		margin: 0;
		white-space: pre-wrap;
		font-size: 0.75em;
		background: ${colors.alpha(colors.vantablack, 0.3)};
		padding: ${space.sm};
		min-height: 100%;
	`,
);

export const logsDialog = async game => {
	const log = new Log({ tag: 'pre', textContent: 'Loading…' });

	const load = async () => {
		const response = await getLogs(game.id);

		log.options.textContent = response.ok
			? (await response.json()).logs || 'Nothing logged yet'
			: await failure(response);
		log.elem.parentElement?.scrollTo({ top: log.elem.scrollHeight });
	};

	new Dialog({
		header: `${game.name}: logs`,
		size: 'large',
		body: log,
		buttons: ['Refresh', 'Close'],
		onButtonPress: ({ button, closeDialog }) => (button === 'Refresh' ? load() : closeDialog()),
	});

	await load();
};

const Candidates = styled.Component`
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin-bottom: 12px;
`;

export const addDialog = async onChanged => {
	const response = await getCandidates();
	const candidates = response.ok ? await response.json() : [];

	const add = async body => {
		const added = await addGame(body);

		if (added.ok) {
			new Notify({ intent: 'success', content: `Added ${(await added.clone().json()).name}` });
			onChanged();
		}

		return added;
	};

	const dialog = new FormDialog({
		header: 'Add a game',
		saveLabel: 'Add',
		intro:
			candidates.length > 0
				? [
						new Elem({ textContent: 'These look like games:' }),
						new Candidates({
							append: candidates.map(
								candidate =>
									new Button({
										variant: 'chip',
										textContent: candidate.name,
										tooltip: candidate.dir,
										onPointerPress: async () => {
											const added = await add({ dir: candidate.dir });

											if (added.ok) dialog.close();
											else new Notify({ intent: 'danger', content: await failure(added) });
										},
									}),
							),
						}),
						new Elem({ textContent: 'Or give its folder:' }),
					]
				: 'The folder of a game checked out on this machine:',
		inputs: [{ key: 'dir', label: 'Folder', placeholder: '~/Projects/void-driller' }],
		data: { dir: '' },
		onSave: ({ dir }) => add({ dir }),
	});
};
