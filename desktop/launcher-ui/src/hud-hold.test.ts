import { expect, test } from 'bun:test';
import { COPIED_HOLD_MS, DONE_HOLD_MS, HELD_PHASES, LEFT_HOLD_MS, NOTICE_HOLD_MS, OVER_HOLD_MS, OVER_MAX_MS, PASTED_HOLD_MS, SAVED_HOLD_MS, holdMs } from './hud-hold';

test('a hover holds the result, but never past the cap', () => {
  expect(holdMs('done', 'over', 0, 0)).toBe(OVER_HOLD_MS);
  expect(holdMs('done', 'over', 0, OVER_MAX_MS - 5_000)).toBe(5_000);
  expect(holdMs('done', 'over', 0, OVER_MAX_MS + 1)).toBe(0);
});

test('holdMs alone: re-armed every second, it never runs past the cap', () => {
  // Each move re-arms the timer with what holdMs gives at that moment.
  let collapsesAt = Infinity;
  for (let now = 0; now < collapsesAt; now += 1000) collapsesAt = now + holdMs('done', 'over', 0, now)!;
  expect(collapsesAt).toBe(OVER_MAX_MS);
});

test('without a hover the phase decides', () => {
  expect(holdMs('done', 'left', 0, 0)).toBe(LEFT_HOLD_MS);
  expect(holdMs('done', 'away', 0, 0)).toBe(DONE_HOLD_MS);
  expect(holdMs('saved', 'away', 0, 0)).toBe(SAVED_HOLD_MS);
  expect(SAVED_HOLD_MS).toBe(3500);
});

test('a receipt keeps its own time, whatever the pointer does', () => {
  expect(holdMs('done', 'away', 0, 0, 'pasted')).toBe(PASTED_HOLD_MS);
  expect(holdMs('done', 'over', 0, 0, 'pasted')).toBe(PASTED_HOLD_MS);
  expect(holdMs('done', 'left', 0, 0, 'copied')).toBe(COPIED_HOLD_MS);
  expect(holdMs('done', 'away', 0, 0, 'blocked')).toBeNull();
});

test('a failure goes back to the pill by itself, with the same pointer rules', () => {
  expect(HELD_PHASES).toContain('failed');
  expect(holdMs('failed', 'away', 0, 0)).toBe(NOTICE_HOLD_MS);
  expect(NOTICE_HOLD_MS).toBe(6000);
  expect(holdMs('failed', 'left', 0, 0)).toBe(LEFT_HOLD_MS);
  expect(holdMs('failed', 'over', 0, 0)).toBe(OVER_HOLD_MS);
  // A hover can't keep it on screen forever either.
  expect(holdMs('failed', 'over', 0, OVER_MAX_MS + 1)).toBe(0);
});

test('a save that says why the words were not typed stays long enough to read', () => {
  expect(holdMs('saved', 'away', 0, 0, null, true)).toBe(NOTICE_HOLD_MS);
  expect(holdMs('saved', 'left', 0, 0, null, true)).toBe(LEFT_HOLD_MS);
});

test('only results are held: idle and live phases never collapse on a timer', () => {
  for (const phase of ['idle', 'recording', 'transcribing']) expect(HELD_PHASES).not.toContain(phase);
});
