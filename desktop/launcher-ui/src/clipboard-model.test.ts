import { describe, expect, test } from 'bun:test';
import { dayLabel, facts, groupByDay, keep, pasteLabel, size, step, type ClipDetail } from './clipboard-model';

const NOON = new Date(2026, 10, 12, 12, 0).getTime();
const HOUR = 3_600_000;

describe('day headings', () => {
  test('today, yesterday, then the date', () => {
    expect(dayLabel(NOON - HOUR, NOON)).toBe('Today');
    expect(dayLabel(NOON - 13 * HOUR, NOON)).toBe('Yesterday');
    expect(dayLabel(NOON - 72 * HOUR, NOON)).not.toMatch(/Today|Yesterday|2026/);
    // Another year says which.
    expect(dayLabel(new Date(2025, 11, 30, 12).getTime(), NOON)).toContain('2025');
  });

  test('rows stay in order under one heading per day', () => {
    const groups = groupByDay([NOON - HOUR, NOON - 2 * HOUR, NOON - 20 * HOUR], (ms) => ms, NOON);
    expect(groups.map((group) => [group.label, group.rows.length])).toEqual([['Today', 2], ['Yesterday', 1]]);
  });
});

describe('arrow keys', () => {
  test('a list moves up and down and stops at its ends', () => {
    expect(step(0, 'ArrowDown', 3, 1)).toBe(1);
    expect(step(2, 'ArrowDown', 3, 1)).toBe(2);
    expect(step(0, 'ArrowUp', 3, 1)).toBe(0);
    expect(step(1, 'ArrowRight', 3, 1)).toBe(1);
  });

  test('a grid moves by row and stays on its row sideways', () => {
    expect(step(1, 'ArrowDown', 9, 3)).toBe(4);
    expect(step(4, 'ArrowUp', 9, 3)).toBe(1);
    expect(step(2, 'ArrowRight', 9, 3)).toBe(2);
    expect(step(3, 'ArrowLeft', 9, 3)).toBe(3);
    expect(step(3, 'ArrowRight', 9, 3)).toBe(4);
  });

  test('down onto a short last row lands on its last item', () => {
    expect(step(2, 'ArrowDown', 4, 3)).toBe(3);
    expect(step(3, 'ArrowDown', 4, 3)).toBe(3);
  });

  test('nothing selected picks the first; nothing to select is -1', () => {
    expect(step(-1, 'ArrowDown', 3, 1)).toBe(0);
    expect(step(0, 'ArrowDown', 0, 1)).toBe(-1);
  });
});

test('the selection survives a refresh, or moves to what took its place', () => {
  expect(keep([1, 2, 3], 2, 1)).toBe(2);
  expect(keep([1, 3], 2, 1)).toBe(3);
  // Removed from the end: the one before it.
  expect(keep([1, 2], 3, 2)).toBe(2);
  expect(keep([1], 2, 1)).toBe(1);
  expect(keep([], 2, 1)).toBeNull();
  expect(keep([5, 6], null, -1)).toBe(5);
});

test('facts say where, when and how big', () => {
  const text: ClipDetail = { id: 1, kind: 'text', text: 'hi there', source: 'Safari', firstMs: NOON - HOUR, lastMs: NOON - HOUR, times: 3, width: 0, height: 0, chars: 8, words: 2, bytes: 8, image: null };
  const rows = facts(text, NOON);
  expect(rows[0]).toEqual(['Copied from', 'Safari']);
  expect(rows[1][1]).toMatch(/^Today at .+ · 3 times$/);
  expect(rows[2]).toEqual(['Size', '8 characters · 2 words']);
  const image = facts({ ...text, kind: 'image', source: null, times: 1, width: 800, height: 600, bytes: 204_800 }, NOON);
  expect(image.map(([label]) => label)).toEqual(['Copied', 'Size']);
  expect(image[1][1]).toBe('800 × 600 · 200 KB');
});

test('sizes and the paste button read plainly', () => {
  expect(size(512)).toBe('512 B');
  expect(size(3 * 1024 * 1024)).toBe('3.0 MB');
  expect(pasteLabel('Claude')).toBe('Paste to Claude');
  expect(pasteLabel(null)).toBe('Paste');
});
