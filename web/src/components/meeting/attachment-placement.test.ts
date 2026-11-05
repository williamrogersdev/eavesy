import { describe, expect, test } from 'bun:test';
import { placeAttachments } from './attachment-placement';

const lines = [{ startMs: 1_000 }, { startMs: 5_000 }, { startMs: 9_000 }];
const at = (offsetMs: number) => ({ offsetMs, id: String(offsetMs) });

describe('placing pictures in the transcript', () => {
  test('each goes after the line being spoken when it was taken', () => {
    const placed = placeAttachments(lines, [at(9_500), at(5_000), at(200), at(6_000)]);
    expect(placed.get(-1)?.map((a) => a.offsetMs)).toEqual([200]);
    expect(placed.get(0)).toBeUndefined();
    expect(placed.get(1)?.map((a) => a.offsetMs)).toEqual([5_000, 6_000]);
    expect(placed.get(2)?.map((a) => a.offsetMs)).toEqual([9_500]);
  });

  test('with no transcript yet, all wait before it', () => {
    expect(placeAttachments([], [at(3), at(1)]).get(-1)?.map((a) => a.offsetMs)).toEqual([1, 3]);
  });
});
