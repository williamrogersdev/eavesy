import { describe, expect, test } from 'bun:test';
import { mergeTimeline, renderTimeline } from './timeline';

describe('mergeTimeline', () => {
  test('interleaves audio and screen entries by time', () => {
    const merged = mergeTimeline({
      audioSegments: [
        { startMs: 5000, endMs: 7000, text: 'so the total is forty-eight twenty', speakerId: 'speaker_0' },
        { startMs: 1000, endMs: 2000, text: 'let me pull up checkout' },
      ],
      visualEntries: [{ atMs: 3000, text: 'Checkout — Total $48.20', captureId: 'cap_1' }],
    });

    expect(merged.map((e) => e.source)).toEqual(['audio', 'screen', 'audio']);
    expect(merged.map((e) => e.startMs)).toEqual([1000, 3000, 5000]);
    expect(merged[1].captureId).toBe('cap_1');
    expect(merged[2].speakerId).toBe('speaker_0');
  });

  test('drops empty/whitespace-only entries', () => {
    const merged = mergeTimeline({
      audioSegments: [{ startMs: 0, endMs: 10, text: '   ' }],
      visualEntries: [{ atMs: 0, text: '' }],
    });
    expect(merged).toHaveLength(0);
  });

  test('screen context sorts before audio at the same instant', () => {
    const merged = mergeTimeline({
      audioSegments: [{ startMs: 2000, endMs: 2500, text: 'see this error' }],
      visualEntries: [{ atMs: 2000, text: 'TypeError: undefined' }],
    });
    expect(merged.map((e) => e.source)).toEqual(['screen', 'audio']);
  });

  test('handles missing inputs', () => {
    expect(mergeTimeline({})).toEqual([]);
  });
});

describe('renderTimeline', () => {
  test('tags screen lines and attributes speakers', () => {
    const out = renderTimeline(
      mergeTimeline({
        audioSegments: [{ startMs: 65000, endMs: 67000, text: 'looks good', speakerId: 'speaker_1' }],
        visualEntries: [{ atMs: 3000, text: 'Build passed' }],
      }),
    );
    expect(out).toBe('[0:03] (screen) Build passed\n[1:05] speaker_1: looks good');
  });

  test('formats hours past the 60-minute mark', () => {
    const out = renderTimeline(mergeTimeline({ audioSegments: [{ startMs: 3_661_000, endMs: 3_662_000, text: 'still here' }] }));
    expect(out).toBe('[1:01:01] still here');
  });
});
