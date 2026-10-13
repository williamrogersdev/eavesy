import { describe, expect, test } from 'bun:test';
import { sameNetwork } from './same-network';

describe('sameNetwork', () => {
  test('compares IPv4 exactly', () => {
    expect(sameNetwork('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(sameNetwork('203.0.113.7', '203.0.113.8')).toBe(false);
  });

  test('compares IPv6 by /64 prefix', () => {
    expect(sameNetwork('2001:db8:1:2::a', '2001:0db8:0001:0002:ffff::1')).toBe(true);
    expect(sameNetwork('2001:db8:1:2::a', '2001:db8:1:3::a')).toBe(false);
  });

  test('treats mixed families as different', () => {
    expect(sameNetwork('203.0.113.7', '2001:db8::1')).toBe(false);
  });
});
