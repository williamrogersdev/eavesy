import { describe, expect, test } from 'bun:test';
import { formatDate, readingTimeMinutes } from './format';

const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');

describe('readingTimeMinutes', () => {
  test('is at least one minute', () => {
    expect(readingTimeMinutes('')).toBe(1);
    expect(readingTimeMinutes('   \n\t ')).toBe(1);
    expect(readingTimeMinutes('one')).toBe(1);
  });

  test('counts 220 words a minute and returns whole minutes', () => {
    expect(readingTimeMinutes(words(220))).toBe(1);
    expect(readingTimeMinutes(words(440))).toBe(2);
    expect(readingTimeMinutes(words(1100))).toBe(5);
    expect(Number.isInteger(readingTimeMinutes(words(333)))).toBe(true);
  });

  test('splits on any run of whitespace', () => {
    expect(readingTimeMinutes(`  ${words(440).replaceAll(' ', ' \n\t ')}  `)).toBe(2);
  });
});

describe('formatDate', () => {
  test('renders a long US date in UTC', () => {
    expect(formatDate('2026-06-01T00:00:00Z')).toBe('June 1, 2026');
    expect(formatDate('2026-06-01T23:30:00Z')).toBe('June 1, 2026');
    expect(formatDate('2026-12-31')).toBe('December 31, 2026');
  });
});
