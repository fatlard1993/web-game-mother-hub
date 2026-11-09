import { existsSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';

// How a game looks, read the way a browser reads it: its web manifest's name, theme color and icons, and failing
// those its page's <title>, theme-color and icon link. A game with no color of its own gets one from its id, steady
// from one load to the next.

const readText = async file => {
	try {
		return await readFile(file, 'utf8');
	} catch {
		return null;
	}
};

const attribute = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1] ?? null;

const tags = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? [];

const linkHref = (html, rel) =>
	attribute(tags(html, 'link').find(tag => attribute(tag, 'rel')?.split(/\s+/).includes(rel)) ?? '', 'href');

const metaContent = (html, name) =>
	attribute(tags(html, 'meta').find(tag => attribute(tag, 'name') === name) ?? '', 'content');

// The biggest of the manifest's icons, "any" size beating every fixed one
const biggestIcon = icons =>
	[...(Array.isArray(icons) ? icons : [])]
		.filter(icon => typeof icon?.src === 'string')
		.sort((a, b) => iconSize(b) - iconSize(a))[0]?.src ?? null;

const iconSize = icon =>
	icon.sizes === 'any'
		? Infinity
		: Math.max(
				0,
				...String(icon.sizes ?? '')
					.split(/\s+/)
					.map(size => parseInt(size, 10) || 0),
			);

export const fallbackColor = id => {
	let hash = 0;

	for (const character of String(id)) hash = (hash * 31 + character.codePointAt(0)) >>> 0;

	return `hsl(${hash % 360}, 50%, 50%)`;
};

const isColor = value => typeof value === 'string' && /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([^)]*\))$/i.test(value.trim());

// A file the page names, kept inside the game's client folder however the href is written
const inClient = (clientDir, href) => {
	if (!href || /^[a-z]+:/i.test(href)) return null;

	const file = path.resolve(clientDir, href.replace(/^\//, '').split(/[?#]/)[0]);

	return file.startsWith(clientDir + path.sep) && existsSync(file) ? file : null;
};

export const readLook = async ({ id, dir }) => {
	const clientDir = path.join(dir, 'client');
	const html = (await readText(path.join(clientDir, 'index.html'))) ?? '';
	const manifestFile = inClient(clientDir, linkHref(html, 'manifest') ?? 'manifest.json');
	let manifest = {};

	try {
		manifest = manifestFile ? JSON.parse(await readFile(manifestFile, 'utf8')) : {};
	} catch {
		// A manifest that doesn't parse is no manifest; the page still has its say
	}

	const iconFile =
		inClient(path.dirname(manifestFile ?? path.join(clientDir, 'x')), biggestIcon(manifest.icons) ?? '') ??
		inClient(clientDir, linkHref(html, 'icon') ?? linkHref(html, 'shortcut') ?? '') ??
		inClient(clientDir, 'favicon.svg') ??
		inClient(clientDir, 'favicon.ico');

	const color = [manifest.theme_color, metaContent(html, 'theme-color')].find(isColor);
	const title = manifest.name || /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();

	return {
		title: title && !title.includes('{{') ? title : null,
		color: color ?? fallbackColor(id),
		background: isColor(manifest.background_color) ? manifest.background_color : null,
		icon: iconFile,
		// Changes when the icon does, so the page's copy of it is let go
		iconVersion: iconFile ? Math.round(statSync(iconFile).mtimeMs) : null,
	};
};
