import { describe, expect, test } from 'bun:test';
import { parseByteRange } from './byte-range';

describe('parseByteRange', () => {
  test('open, closed and suffix ranges', () => {
    expect(parseByteRange('bytes=0-', 1000)).toEqual({ offset: 0, length: 1000 });
    expect(parseByteRange('bytes=100-199', 1000)).toEqual({ offset: 100, length: 100 });
    expect(parseByteRange('bytes=-200', 1000)).toEqual({ offset: 800, length: 200 });
    expect(parseByteRange('bytes=900-5000', 1000)).toEqual({ offset: 900, length: 100 });
  });

  test('no header or multi-range means the whole file', () => {
    expect(parseByteRange(null, 1000)).toBeNull();
    expect(parseByteRange('bytes=0-1,5-9', 1000)).toBeNull();
  });

  test('out of range is unsatisfiable', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 1000)).toBe('unsatisfiable');
  });
});
