import { describe, expect, test } from 'bun:test';
import { googleOutcome } from './google-calendar';

const outcome = (query: string) => googleOutcome(new URLSearchParams(query));

describe('googleOutcome', () => {
  test('a finished connection says so, and points back to the Mac app when it started there', () => {
    expect(outcome('connected=google')).toEqual({ kind: 'ok', text: 'Google Calendar connected.' });
    expect(outcome('connected=google&from=mac')?.text).toBe('Google Calendar connected. You can go back to the Eavesy app.');
  });
  test('a known Google error gets its own message', () => {
    expect(outcome('error=google_cancelled')?.kind).toBe('error');
    expect(outcome('error=google_expired&from=mac')?.text).toEndWith('You can go back to the Eavesy app.');
  });
  test('anything else is not a Google outcome', () => {
    expect(outcome('')).toBeNull();
    expect(outcome('connected=openrouter')).toBeNull();
    expect(outcome('error=constructor')).toBeNull();
  });
});
