import { describe, expect, test } from 'bun:test';

import { safeUrl } from './safeUrl';

describe('safeUrl', () => {
	test('passes the schemes a link is normally written with', () => {
		expect(safeUrl('https://example.com')).toBe('https://example.com');
		expect(safeUrl('http://localhost:8034/games')).toBe('http://localhost:8034/games');
		expect(safeUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com');
	});

	test('passes urls with no scheme at all', () => {
		expect(safeUrl('/games/abc')).toBe('/games/abc');
		expect(safeUrl('#rules')).toBe('#rules');
		expect(safeUrl('example.com/path')).toBe('example.com/path');
	});

	test('drops executable schemes', () => {
		expect(safeUrl('javascript:alert(1)')).toBe('#');
		expect(safeUrl('JAVASCRIPT:alert(1)')).toBe('#');
		expect(safeUrl('vbscript:msgbox(1)')).toBe('#');
		expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
		expect(safeUrl('javascript://%0aalert(1)')).toBe('#');
	});

	// The renderer's output goes to innerHTML, where the parser decodes entities in attribute
	// values after markdown is finished with them; a raw-text check never sees the real scheme
	test('drops schemes hidden behind html entities', () => {
		expect(safeUrl('&#106;avascript:alert(1)')).toBe('#');
		expect(safeUrl('&#x6a;avascript:alert(1)')).toBe('#');
		expect(safeUrl('java&NewLine;script:alert(1)')).toBe('#');
		expect(safeUrl('javascript&colon;alert(1)')).toBe('#');
		expect(safeUrl('&amp;#106;avascript:alert(1)')).toBe('#');
	});

	test('drops schemes hidden behind whitespace and control characters', () => {
		expect(safeUrl('  javascript:alert(1)')).toBe('#');
		expect(safeUrl('java\tscript:alert(1)')).toBe('#');
		expect(safeUrl('java\nscript:alert(1)')).toBe('#');
		expect(safeUrl('java\u0000script:alert(1)')).toBe('#');
	});

	test('anything that is not a string is not a url', () => {
		expect(safeUrl(undefined)).toBe('#');
		expect(safeUrl({ toString: () => 'https://example.com' })).toBe('#');
	});
});
