import { describe, expect, test } from 'bun:test';
import { applyTranscriptDelta, mergeRanges } from './live-transcript';

const line = (id: string, startMs: number, text = id) => ({ id, startMs, endMs: startMs + 1_000, text });

describe('live transcript deltas', () => {
  test('overlapping and touching ranges merge; separate ones stay apart', () => {
    expect(
      mergeRanges([
        { fromMs: 60_000, toMs: 123_000 },
        { fromMs: 0, toMs: 63_000 },
        { fromMs: 300_000, toMs: 363_000 },
      ]),
    ).toEqual([
      { fromMs: 0, toMs: 123_000 },
      { fromMs: 300_000, toMs: 363_000 },
    ]);
  });

  test('a delta replaces everything held inside its ranges and keeps time order', () => {
    const held = [line('a', 0), line('echo', 61_000), line('c', 200_000)];
    const next = applyTranscriptDelta(held, {
      ranges: [{ fromMs: 57_000, toMs: 123_000 }],
      lines: [line('b', 62_000), line('b2', 90_000)],
    });
    expect(next.map((l) => l.id)).toEqual(['a', 'b', 'b2', 'c']);
  });

  test('applying the same delta twice changes nothing', () => {
    const delta = { ranges: [{ fromMs: 0, toMs: 63_000 }], lines: [line('a', 1_000, 'Hello')] };
    const once = applyTranscriptDelta([], delta);
    expect(applyTranscriptDelta(once, delta)).toEqual(once);
  });

  test('an edited line moved out of its range is not duplicated', () => {
    const held = [line('a', 130_000)];
    const next = applyTranscriptDelta(held, { ranges: [{ fromMs: 0, toMs: 63_000 }], lines: [line('a', 2_000)] });
    expect(next).toEqual([line('a', 2_000)]);
  });
});
