import { describe, expect, test } from 'bun:test';
import { categoryMeta } from './docs-meta';

const CATEGORIES = ['Getting started', 'Capturing', 'Transcripts and briefs', 'Your files', 'Agents', 'Account and data', 'Open source', 'Help'];

describe('categoryMeta', () => {
  const fallback = categoryMeta('Not a real category');

  test('gives every known category its own entry', () => {
    for (const category of CATEGORIES) expect(categoryMeta(category)).not.toBe(fallback);
    expect(new Set(CATEGORIES.map((category) => categoryMeta(category).blurb)).size).toBe(CATEGORIES.length);
  });

  test('falls back for unknown, differently cased or prototype names', () => {
    expect(fallback.blurb).toBe('Guides and reference for Eavesy.');
    for (const category of ['', 'help', 'toString', 'constructor', '__proto__']) expect(categoryMeta(category)).toBe(fallback);
  });

  test('every entry has an icon and a non-empty blurb', () => {
    for (const category of [...CATEGORIES, 'unknown']) {
      const meta = categoryMeta(category);
      expect(meta.icon).toBeDefined();
      expect(meta.blurb.trim().length).toBeGreaterThan(0);
    }
  });
});
