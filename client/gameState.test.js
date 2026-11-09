import { describe, expect, test } from 'bun:test';

import { exposureState, gameState, reportChips } from './gameState';

const NOW = Date.parse('2026-11-08T20:00:00Z');
const unit = (overrides = {}) => ({
	active: true,
	state: 'active',
	restarts: 0,
	since: '2026-11-08T18:00:00Z',
	...overrides,
});

describe('gameState', () => {
	test('running and answering', () => {
		expect(gameState({ unit: unit(), health: { ok: true } }, NOW)).toEqual({
			key: 'up',
			label: 'Running, started 2h ago',
		});
	});

	test('a moment after starting, not answering yet is starting', () => {
		const game = { unit: unit({ since: '2026-11-08T19:59:55Z' }), health: { ok: false } };

		expect(gameState(game, NOW).key).toBe('starting');
	});

	test('long after starting, not answering is said plainly', () => {
		expect(gameState({ unit: unit(), health: { ok: false } }, NOW).key).toBe('silent');
	});

	test('restarting over and over is a crash, with the count', () => {
		const game = { unit: unit({ active: false, state: 'auto-restart', restarts: 14 }), health: { ok: false } };

		expect(gameState(game, NOW)).toEqual({ key: 'crashing', label: 'Crashing (restarted 14×)' });
	});

	test('an operation under way outranks the rest', () => {
		const game = { unit: unit(), health: { ok: true }, operation: { running: true, kind: 'update' } };

		expect(gameState(game, NOW)).toEqual({ key: 'busy', label: 'Update…' });
	});
});

describe('exposureState', () => {
	test('meant to be open but off waits for it', () => {
		expect(exposureState({ exposed: true, unit: unit({ active: false }), tunnel: { active: false } }).key).toBe(
			'waiting',
		);
	});

	test('open needs both the game and its tunnel up', () => {
		expect(exposureState({ exposed: true, unit: unit(), tunnel: { active: true } }).key).toBe('open');
		expect(exposureState({ exposed: true, unit: unit(), tunnel: { active: false } }).key).toBe('connecting');
	});

	test('a tunnel that keeps failing says so, instead of reaching forever', () => {
		const game = { exposed: true, unit: unit(), tunnel: { active: false, restarts: 5 } };

		expect(exposureState(game).key).toBe('failing');
	});
});

describe('reportChips', () => {
	test("who's here leads, then the games going, the game's own numbers, and memory last", () => {
		const report = {
			connections: 3,
			games: 1,
			players: 4,
			memory: 52 * 1048576,
			metrics: [{ label: 'deepest dig', value: 42 }],
		};

		expect(reportChips(report)).toEqual([
			{ value: 3, label: 'here now', lead: true },
			{ value: '4 players', label: 'in 1 game' },
			{ value: '42', label: 'deepest dig' },
			{ value: '52 MB', label: 'memory', quiet: true },
		]);
	});

	test('no games going says nothing of players; no report shows nothing', () => {
		expect(reportChips({ connections: 0, games: 0, players: 0 })).toEqual([
			{ value: 0, label: 'here now', lead: true },
		]);
		expect(reportChips(null)).toEqual([]);
	});
});
