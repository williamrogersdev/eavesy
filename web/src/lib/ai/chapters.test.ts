import { describe, expect, test } from 'bun:test';
import { clock, parseClock, validateChapters } from './chapters';

const LONG = 20 * 60 * 1_000;

describe('chapter clock', () => {
  test('round-trips minutes and hours', () => {
    expect(clock(83_000)).toBe('01:23');
    expect(clock(3_723_000)).toBe('1:02:03');
    expect(parseClock('01:23')).toBe(83_000);
    expect(parseClock('[1:02:03]')).toBe(3_723_000);
    expect(parseClock('soon')).toBeNull();
  });
});

describe('validateChapters', () => {
  const lines = [2_000, 65_000, 300_000, 610_000];

  test('snaps starts to real lines and pins the first to the first line', () => {
    expect(
      validateChapters(
        [
          { start: '00:00', title: 'Intro' },
          { start: '05:03', title: '  "Budget review" ' },
          { start: '10:05', title: '## Hiring' },
        ],
        lines,
        LONG,
      ),
    ).toEqual([
      { startMs: 2_000, title: 'Intro' },
      { startMs: 300_000, title: 'Budget review' },
      { startMs: 610_000, title: 'Hiring' },
    ]);
  });

  test('drops malformed entries, duplicates, and sorts', () => {
    expect(
      validateChapters(
        [
          { start: '10:10', title: 'Later' },
          { start: 'nope', title: 'Bad' },
          { start: '00:01', title: '' },
          { start: '00:02', title: 'First' },
          { start: '00:03', title: 'Same line again' },
          'junk',
        ],
        lines,
        LONG,
      ),
    ).toEqual([
      { startMs: 2_000, title: 'First' },
      { startMs: 610_000, title: 'Later' },
    ]);
  });

  test('short meetings get none', () => {
    expect(validateChapters([{ start: '00:00', title: 'Intro' }], lines, 60_000)).toEqual([]);
  });
});
