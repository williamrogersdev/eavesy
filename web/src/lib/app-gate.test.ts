import { afterEach, describe, expect, test } from 'bun:test';
import { appGateRecentlyPassed, forgetAppGatePass, rememberAppGatePass } from './app-gate';

const g = globalThis as { window?: unknown };

function setClerkUser(id: string | null) {
  g.window = { Clerk: { user: id === null ? null : { id } } };
}

afterEach(() => {
  forgetAppGatePass();
  delete g.window;
});

describe('app gate pass cache', () => {
  test('a pass holds for the same user within the TTL', () => {
    setClerkUser('user_a');
    rememberAppGatePass(1_000);
    expect(appGateRecentlyPassed(30_000)).toBe(true);
    expect(appGateRecentlyPassed(61_001)).toBe(false);
  });

  test('switching account or signing out misses', () => {
    setClerkUser('user_a');
    rememberAppGatePass(1_000);
    setClerkUser('user_b');
    expect(appGateRecentlyPassed(2_000)).toBe(false);
    setClerkUser(null);
    expect(appGateRecentlyPassed(2_000)).toBe(false);
  });

  test('nothing is cached before Clerk has a user, or on the server', () => {
    setClerkUser(null);
    rememberAppGatePass(1_000);
    setClerkUser('user_a');
    expect(appGateRecentlyPassed(2_000)).toBe(false);
    delete g.window;
    rememberAppGatePass(1_000);
    expect(appGateRecentlyPassed(2_000)).toBe(false);
  });
});
