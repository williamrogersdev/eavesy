import { describe, expect, test } from 'bun:test';
import { clampLimit } from './clamp-limit';

describe('clampLimit', () => {
  test('uses the fallback for missing or unusable values', () => {
    expect(clampLimit(null, 10, 25)).toBe(10);
    expect(clampLimit(undefined, 10, 25)).toBe(10);
    expect(clampLimit('', 10, 25)).toBe(10);
    expect(clampLimit('abc', 10, 25)).toBe(10);
    expect(clampLimit('0', 10, 25)).toBe(10);
    expect(clampLimit('-1', 10, 25)).toBe(10);
    expect(clampLimit('Infinity', 10, 25)).toBe(10);
  });

  test('caps at the maximum and rounds down', () => {
    expect(clampLimit('500', 10, 25)).toBe(25);
    expect(clampLimit('7.9', 10, 25)).toBe(7);
    expect(clampLimit('1', 10, 25)).toBe(1);
  });
});
