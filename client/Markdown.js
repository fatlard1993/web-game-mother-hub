import { marked } from 'marked';
import { Component, styled } from '@vanilla-bean/components';

import { safeUrl } from './safeUrl';

const escapeHtml = text =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// breaks: true, game rules are often written as plain lines; GFM line breaks keep
// single newlines visible instead of collapsing them into one paragraph.
// The html renderer and walkTokens sanitize: descriptions arrive from third parties (Steam
// store, pasted text) and land in innerHTML, so raw HTML renders as visible text instead of
// executing, and every link href goes through the scheme allowlist. Markdown covers the rest.
marked.use({
	breaks: true,
	gfm: true,
	renderer: {
		html({ text }) {
			return escapeHtml(text);
		},
	},
	walkTokens: token => {
		if (token.type === 'link' || token.type === 'image') token.href = safeUrl(token.href);
	},
});

const StyledMarkdown = styled(
	Component,
	({ colors, radius, space }) => `
		line-height: 1.5;
		overflow-wrap: break-word;

		h1, h2 {
			border-bottom: 1px solid ${colors.border};
			padding-bottom: ${space.xs};
		}

		ul, ol {
			padding-left: ${space.xl};
			margin: ${space.sm} 0;
		}

		li {
			margin: ${space.xs} 0;
		}

		p {
			margin: ${space.sm} 0 ${space.md};
		}

		a {
			color: ${colors.light(colors.blue)};
		}

		img {
			max-width: 100%;
			border-radius: ${radius.md};
		}

		code:not([class*='language-']) {
			background-color: ${colors.alpha(colors.black, 0.5)};
			padding: 1px ${space.sm};
			border-radius: ${radius.sm};
		}

		blockquote {
			margin: ${space.sm} 0;
			padding: ${space.xs} ${space.md};
			border-left: 4px solid ${colors.alpha(colors.blue, 0.5)};
			background-color: ${colors.alpha(colors.white, 0.03)};

			&.NOTE { border-color: ${colors.alpha(colors.info, 0.6)}; }
			&.TIP { border-color: ${colors.alpha(colors.success, 0.6)}; }
			&.WARNING { border-color: ${colors.alpha(colors.warning, 0.6)}; }
			&.CAUTION { border-color: ${colors.alpha(colors.danger, 0.6)}; }
		}

		table {
			border-collapse: collapse;
			margin: ${space.sm} 0;

			th, td {
				border: 1px solid ${colors.border};
				padding: ${space.xs} ${space.md};
			}

			th {
				background-color: ${colors.alpha(colors.white, 0.05)};
			}
		}

		hr {
			border: none;
			border-top: 1px solid ${colors.border};
			margin: ${space.md} 0;
		}
	`,
);

// Mirrors the transforms in vanilla-bean-components' parseMarkdown: the pre/code class shuffle
// hooks the theme's pre[class*="language-"] styling, the blockquote one supports [!NOTE] alerts
export const renderMarkdown = md =>
	marked
		.parse(md || '')
		.replaceAll(/<pre><code class="language-([^\s"]+)/g, `<pre class="language-$1"><code class="language-$1`)
		.replaceAll(/<blockquote>\s?<p>\s?\[!(\w+)]/g, `<blockquote class="$1"><p><strong>$1</strong></p><p>`);

// vbc-markdown: the theme's voice for rendered markdown, green headings with their # markers
export default class Markdown extends StyledMarkdown {
	static schema = {
		md: {
			set(value) {
				this.elem.innerHTML = renderMarkdown(value);
			},
		},
	};

	static prepareOptions(options) {
		return { ...options, addClass: ['vbc-markdown', options.addClass] };
	}

	build() {
		this.elem.innerHTML = renderMarkdown(this.options.md);
	}
}
