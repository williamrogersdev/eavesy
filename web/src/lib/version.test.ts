import { describe, expect, test } from 'bun:test';
import { compareVersions } from './version';

describe('compareVersions', () => {
  test('orders by each numeric segment, not lexically', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.999.999')).toBeGreaterThan(0);
  });

  test('treats missing trailing segments as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0);
  });

  test('never reports garbage as newer', () => {
    expect(compareVersions('not-a-version', '0.1.0')).toBeLessThan(0);
    expect(compareVersions('', '0.0.1')).toBeLessThan(0);
    expect(compareVersions('0.1.0', 'not-a-version')).toBeGreaterThan(0);
  });
});
