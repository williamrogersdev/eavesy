import { describe, expect, test } from 'bun:test';
import { addChips, hasChipSeparator, removeChip, sameChips, splitChips } from './chips';

const limits = { max: 5, maxLength: 12 };

describe('splitChips', () => {
  test('splits on commas, tabs and line breaks and drops blanks', () => {
    expect(splitChips('Tauri, D1,,\nwrangler\r\nPriya Raman\tKubernetes, ')).toEqual([
      'Tauri',
      'D1',
      'wrangler',
      'Priya Raman',
      'Kubernetes',
    ]);
  });

  test('keeps phrases and collapses inner whitespace', () => {
    expect(splitChips('  Cloudflare   Workers  ')).toEqual(['Cloudflare Workers']);
  });

  test('detects separators', () => {
    expect(hasChipSeparator('a,b')).toBe(true);
    expect(hasChipSeparator('a\nb')).toBe(true);
    expect(hasChipSeparator('just one phrase')).toBe(false);
  });
});

describe('addChips', () => {
  test('dedupes case-insensitively and keeps the first spelling', () => {
    expect(addChips(['Eavesy'], ['eavesy', 'D1', 'd1', 'Tauri'], limits)).toEqual(['Eavesy', 'D1', 'Tauri']);
  });

  test('stops at the limit', () => {
    expect(addChips(['a', 'b', 'c'], ['d', 'e', 'f', 'g'], limits)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('keeps existing chips over the limit and adds nothing', () => {
    const over = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(addChips(over, ['g'], limits)).toEqual(over);
  });

  test('trims and caps chip length', () => {
    expect(addChips([], ['  a very long phrase indeed  ', ' '], limits)).toEqual(['a very long']);
  });

  test('does not change the input array', () => {
    const current = ['a'];
    addChips(current, ['b'], limits);
    expect(current).toEqual(['a']);
  });
});

describe('removeChip and sameChips', () => {
  test('removes only the exact chip', () => {
    expect(removeChip(['Tauri', 'tauri-cli'], 'Tauri')).toEqual(['tauri-cli']);
  });

  test('compares order and spelling', () => {
    expect(sameChips(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameChips(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameChips(['a'], ['a', 'b'])).toBe(false);
  });
});
