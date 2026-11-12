import { Button, Component, Dialog, Elem, Notify, styled } from '@vanilla-bean/components';

import { editGame, failure, getDocs, photographGame } from './api';
import Markdown from './Markdown';

const Gallery = styled(
	Component,
	({ colors, space }) => `
		display: flex;
		flex-direction: column;
		gap: ${space.sm};
		margin-bottom: ${space.lg};

		.stage {
			display: flex;
			align-items: center;
			justify-content: center;
			height: min(55vh, 520px);
			background: ${colors.alpha(colors.vantablack, 0.45)};
			border-radius: 8px;
			border-top: 3px solid var(--game-color);
			overflow: hidden;
		}

		.stage img {
			max-width: 100%;
			max-height: 100%;
			object-fit: contain;
		}

		.caption {
			display: flex;
			align-items: center;
			gap: ${space.sm};
			color: ${colors.muted};
			font-size: 0.9em;
			min-height: 2em;
		}

		.caption span {
			flex: 1;
		}

		.thumbs {
			display: flex;
			gap: ${space.xs};
			overflow-x: auto;
			padding-bottom: ${space.xs};
		}

		.thumbs button {
			flex: none;
			width: 96px;
			height: 60px;
			padding: 0;
			border: 2px solid transparent;
			border-radius: 6px;
			overflow: hidden;
			cursor: pointer;
			background: ${colors.alpha(colors.vantablack, 0.45)};
			opacity: 0.6;
		}

		.thumbs button[aria-pressed='true'] {
			border-color: var(--game-color);
			opacity: 1;
		}

		.thumbs img {
			width: 100%;
			height: 100%;
			object-fit: cover;
			object-position: top;
		}
	`,
);

// The pictures the README shows, one large with its alt text for a caption, the rest a strip to pick from; arrows
// step through them
const gallery = (media, { cover, onCover }) => {
	const stage = new Elem({ addClass: 'stage' });
	const captionText = new Elem({ tag: 'span' });
	const coverButton = new Button({
		icon: 'image',
		variant: 'chip',
		textContent: 'Use as the card’s cover',
		onPointerPress: async () => {
			if (await onCover(media[current].path)) {
				cover = media[current].path;
				show(current);
			}
		},
	});
	const caption = new Elem({ addClass: 'caption', append: [captionText, coverButton] });
	const thumbs = new Elem({ addClass: 'thumbs' });
	let current = 0;

	const show = index => {
		current = (index + media.length) % media.length;
		stage.elem.replaceChildren(new Elem({ tag: 'img', src: media[current].url, alt: media[current].alt }).elem);
		captionText.elem.textContent = media[current].alt;
		coverButton.elem.style.display = !onCover || media[current].path === cover ? 'none' : '';
		thumbButtons.forEach((thumb, at) => (thumb.options.pressed = at === current));
		thumbButtons[current]?.elem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	};

	const thumbButtons = media.map(
		(item, index) =>
			new Button({
				appendTo: thumbs,
				variant: 'flat',
				tooltip: item.alt || false,
				onPointerPress: () => show(index),
				append: new Elem({ tag: 'img', src: item.url, alt: '', attributes: { loading: 'lazy' } }),
			}),
	);

	const element = new Gallery({
		append: media.length > 1 ? [stage, caption, thumbs] : [stage, caption],
		attributes: { tabindex: '0' },
		onKeyDown: event => {
			if (event.key === 'ArrowRight') show(current + 1);
			if (event.key === 'ArrowLeft') show(current - 1);
		},
	});

	show(0);

	return element;
};

// Markdown's pictures sized for reading beside the text: the gallery above is where they're seen large
const Readme = styled(
	Markdown,
	() => `
		img {
			max-height: 320px;
			width: auto;
		}
	`,
);

export const aboutDialog = async (game, onChanged, { canPhotograph = false, canChooseCover = false } = {}) => {
	const body = new Component({ textContent: 'Loading…' });
	let cover = game.about.cover?.path;

	body.elem.style.setProperty('--game-color', game.look.color);

	const load = async () => {
		const response = await getDocs(game.id);

		if (!response.ok) {
			body.elem.textContent = await failure(response);

			return;
		}

		const { markdown, media } = await response.json();

		body.elem.replaceChildren(
			...[
				media.length > 0 &&
					gallery(media, {
						cover,
						onCover:
							canChooseCover &&
							(async picture => {
								const saved = await editGame(game.id, { cover: picture });

								if (saved.ok) {
									cover = picture;
									onChanged?.();
								}

								return saved.ok;
							}),
					}).elem,
				markdown && new Readme({ md: markdown }).elem,
			].filter(Boolean),
		);

		if (!markdown && media.length === 0) body.elem.textContent = 'No README or pictures yet.';
	};

	// A fresh picture of the game as it is right now, added to the gallery (and the card's cover, if it has no other)
	let photographing = false;

	const photograph = async () => {
		if (photographing) return;

		photographing = true;
		new Notify({ intent: 'info', content: 'Taking a picture of it…' });

		const response = await photographGame(game.id);
		const { taken } = response.ok ? await response.json() : {};

		photographing = false;

		if (!taken)
			new Notify({
				intent: 'warning',
				content: response.ok ? 'The game didn’t answer in time' : await failure(response),
			});

		await load();
		onChanged?.();
	};

	new Dialog({
		header: game.name,
		size: 'large',
		body,
		buttons: [
			...(canPhotograph && game.unit.active
				? [{ textContent: 'Take a picture now', icon: 'camera', variant: 'flat' }]
				: []),
			'Close',
		],
		onButtonPress: ({ button, closeDialog }) => (button === 'Close' ? closeDialog() : photograph()),
	});

	await load();
};
