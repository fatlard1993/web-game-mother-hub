// Hrefs here reach innerHTML (Markdown) or an anchor's href property (links, attachments), and
// the HTML parser decodes entities in attribute values *after* the markdown renderer is done
// with them: `&#106;avascript:alert(1)` passes a raw-text check and still becomes `javascript:`
// by the time it is clicked. So decode first, then judge, and judge against an allowlist. A
// denylist of the executable schemes is a list of the ones somebody thought of.
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

const NAMED_ENTITIES = {
	colon: ':',
	sol: '/',
	Tab: '\t',
	NewLine: '\n',
	amp: '&',
};

const decodeOnce = url =>
	url
		.replaceAll(/&#(\d+);?/g, (_, code) => String.fromCodePoint(Number(code)))
		.replaceAll(/&#x([\da-f]+);?/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replaceAll(/&(\w+);/g, (match, name) => NAMED_ENTITIES[name] ?? match);

// An `&amp;#106;` needs two passes; the cap stops a crafted string from spinning here
const decodeEntities = url => {
	let decoded = url;

	for (let pass = 0; pass < 3; pass++) {
		const next = decodeOnce(decoded);

		if (next === decoded) break;

		decoded = next;
	}

	return decoded;
};

const SCHEME = /^([a-z][\d+.a-z-]*):/i;

// Browsers ignore spaces, tabs, newlines, and control characters while resolving a scheme
const stripIgnored = url =>
	[...url].filter(character => character.codePointAt(0) > 0x20 && character.codePointAt(0) !== 0x7f).join('');

/**
 * The url unchanged when a browser would treat it as inert, '#' when it would execute.
 * Relative urls, anchors, and query-only urls have no scheme and always pass.
 * @param url the raw href, as authored
 */
export const safeUrl = url => {
	if (typeof url !== 'string') return '#';

	const scheme = SCHEME.exec(stripIgnored(decodeEntities(url)))?.[1];

	if (scheme && !ALLOWED_SCHEMES.has(scheme.toLowerCase())) return '#';

	return url;
};
