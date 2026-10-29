import { describe, expect, it } from 'bun:test';
import { wordDiff } from './text-diff';

const join = (parts: ReturnType<typeof wordDiff>, keep: 'before' | 'after') =>
  parts.filter((p) => p.type === 'same' || p.type === (keep === 'before' ? 'del' : 'add')).map((p) => p.text).join('');

describe('wordDiff', () => {
  it('marks only the changed words', () => {
    expect(wordDiff('Reveiw the PR and fix it.', 'Review the PR and fix it.')).toEqual([
      { type: 'del', text: 'Reveiw ' },
      { type: 'add', text: 'Review ' },
      { type: 'same', text: 'the PR and fix it.' },
    ]);
  });

  it('gives back both texts exactly, whitespace included', () => {
    const before = 'Search every ticket.\n\nThen debug {{details}} first.';
    const after = 'Search every open ticket.\nThen debug {{details}} first, and report back.';
    const parts = wordDiff(before, after);
    expect(join(parts, 'before')).toBe(before);
    expect(join(parts, 'after')).toBe(after);
  });

  it('handles empty and identical texts', () => {
    expect(wordDiff('', 'New')).toEqual([{ type: 'add', text: 'New' }]);
    expect(wordDiff('Same text', 'Same text')).toEqual([{ type: 'same', text: 'Same text' }]);
  });

  it('shows a huge rewrite as one replaced block instead of comparing every pair', () => {
    const before = Array.from({ length: 2_000 }, (_, i) => `a${i}`).join(' ');
    const after = Array.from({ length: 2_000 }, (_, i) => `b${i}`).join(' ');
    const parts = wordDiff(before, after);
    expect(parts.map((p) => p.type)).toEqual(['del', 'add']);
  });
});
