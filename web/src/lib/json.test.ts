import { describe, expect, test } from 'bun:test';
import { isRecord, optionalNumber, optionalString } from './json';

describe('JSON guards', () => {
  test('isRecord accepts plain objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    for (const value of [null, undefined, [], [1], 'x', '', 0, 1, true]) expect(isRecord(value)).toBe(false);
  });

  test('optionalString keeps strings, including empty ones', () => {
    expect(optionalString('hi')).toBe('hi');
    expect(optionalString('')).toBe('');
    for (const value of [null, undefined, 0, 1, true, {}, [], ['a']]) expect(optionalString(value)).toBeUndefined();
  });

  test('optionalNumber keeps finite numbers only', () => {
    for (const value of [0, -0, -3, 1.5, Number.MAX_SAFE_INTEGER]) expect(optionalNumber(value)).toBe(value);
    for (const value of [NaN, Infinity, -Infinity, '1', '', null, undefined, true, {}, []]) expect(optionalNumber(value)).toBeUndefined();
  });
});
