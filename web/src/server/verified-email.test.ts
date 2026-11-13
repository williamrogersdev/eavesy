import { expect, test } from 'bun:test';
import { verifiedEmail } from './verified-email';

const address = (id: string, status?: string) => ({ id, emailAddress: `${id}@example.com`, verification: status ? { status } : null });

test('takes the primary address when it is verified', () => {
  expect(verifiedEmail([address('a', 'verified'), address('b', 'verified')], 'b')).toBe('b@example.com');
});

test('skips an unverified primary for a verified address', () => {
  expect(verifiedEmail([address('a', 'unverified'), address('b', 'verified')], 'a')).toBe('b@example.com');
});

test('stores nothing when no address is verified', () => {
  expect(verifiedEmail([address('a', 'unverified'), address('b')], 'a')).toBeUndefined();
  expect(verifiedEmail(undefined, null)).toBeUndefined();
});
