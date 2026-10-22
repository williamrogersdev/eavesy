import { expect, test } from 'bun:test';
import { DONE_HOLD_MS, LEFT_HOLD_MS, OVER_HOLD_MS, OVER_MAX_MS, holdMs } from './hud-hold';

test('a hover holds the result, but never past the cap', () => {
  expect(holdMs('done', 'over', 0, 0)).toBe(OVER_HOLD_MS);
  expect(holdMs('done', 'over', 0, OVER_MAX_MS - 5_000)).toBe(5_000);
  expect(holdMs('done', 'over', 0, OVER_MAX_MS + 1)).toBe(0);
});

test('holdMs re-armed every second never runs past the cap', () => {
  // Each move re-arms the timer with what holdMs gives at that moment.
  let collapsesAt = Infinity;
  for (let now = 0; now < collapsesAt; now += 1000) collapsesAt = now + holdMs('done', 'over', 0, now);
  expect(collapsesAt).toBe(OVER_MAX_MS);
});

test('without a hover the phase decides', () => {
  expect(holdMs('done', 'left', 0, 0)).toBe(LEFT_HOLD_MS);
  expect(holdMs('done', 'away', 0, 0)).toBe(DONE_HOLD_MS);
  expect(holdMs('saved', 'away', 0, 0)).toBe(3500);
});
