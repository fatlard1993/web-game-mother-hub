import { existsSync, statSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import path from 'path';

// What a game says about itself in its README: the paragraph that introduces it, and the pictures it shows off,
// captioned by their alt text. The house READMEs are written to be read cold, so they make a good card and a good
// page without anyone writing either twice.

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

const findReadme = async dir => {
	try {
		const name = (await readdir(dir)).find(file => /^readme\.md$/i.test(file));

		return name ? path.join(dir, name) : null;
	} catch {
		return null;
	}
};

const attribute = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1] ?? '';

// <img> written as HTML (to size it) becomes markdown, so the page can render it with raw HTML refused
const htmlImagesToMarkdown = markdown =>
	markdown.replace(/<img\b[^>]*>/gi, tag => `![${attribute(tag, 'alt')}](${attribute(tag, 'src')})`);

const isRemote = href => /^[a-z][\d+.a-z-]*:/i.test(href) || href.startsWith('//');

const localFile = (dir, readmeDir, href) => {
	if (!href || isRemote(href) || href.startsWith('#')) return null;

	const file = path.resolve(readmeDir, decodeURIComponent(href.split(/[?#]/)[0]));

	return file.startsWith(dir + path.sep) ? file : null;
};

const plain = text =>
	text
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, '')
		.replace(/(\*\*|__|\*|_|`)/g, '')
		.replace(/\s+/g, ' ')
		.trim();

// The first block of prose: past the title, the logo, the badges and the headings. A blockquote counts, since
// some READMEs open on a quoted pitch.
export const leadParagraph = markdown => {
	for (const block of markdown.replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/)) {
		const lines = block
			.trim()
			.split('\n')
			.map(line => line.replace(/^>\s?/, ''));
		const first = lines[0]?.trim() ?? '';

		if (!first || /^(#|\||-|\*\s|\d+\.\s|<|!\[|\[!\[|\[!)/.test(first)) continue;

		const text = plain(lines.join(' '));

		if (text.length >= 40) return text;
	}

	return null;
};

export const readDocs = async ({ id, dir }) => {
	const readme = await findReadme(dir);

	if (!readme) return { blurb: null, media: [], markdown: null };

	const readmeDir = path.dirname(readme);
	const media = [];
	const seen = new Map();
	const url = index =>
		`/api/games/${encodeURIComponent(id)}/media/${index}?v=${Math.round(statSync(media[index].file).mtimeMs)}`;

	let markdown = htmlImagesToMarkdown(await readFile(readme, 'utf8'));

	// Each local picture is served through the hub, numbered in the order the README shows them
	markdown = markdown.replace(MARKDOWN_IMAGE, (whole, alt, href) => {
		const file = localFile(dir, readmeDir, href);

		if (!file) return isRemote(href) ? whole : '';
		if (!IMAGE.test(file) || !existsSync(file)) return '';

		if (!seen.has(file)) {
			seen.set(file, media.length);
			media.push({ file, alt: alt.trim() });
		}

		return `![${alt}](${url(seen.get(file))})`;
	});

	// A link into the repo means nothing from here; its words stay
	markdown = markdown.replace(/(?<!!)\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g, (whole, text, href) =>
		isRemote(href) || href.startsWith('#') || href.startsWith('/api/') ? whole : text,
	);

	return {
		blurb: leadParagraph(markdown),
		media: media.map((item, index) => ({ ...item, path: path.relative(dir, item.file), url: url(index) })),
		markdown,
	};
};
