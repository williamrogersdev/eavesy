import { describe, expect, test } from 'bun:test';
import { splitKeys } from './kbd';
import { draftAfterSave, noteText, shouldCollapse } from './composer';

describe('splitKeys', () => {
  test('splits modifier glyphs from the key name', () => {
    expect(splitKeys('⌘⇧Space')).toEqual(['⌘', '⇧', 'Space']);
    expect(splitKeys('⌘V')).toEqual(['⌘', 'V']);
    expect(splitKeys('fn')).toEqual(['fn']);
    expect(splitKeys(['⌃', '/'])).toEqual(['⌃', '/']);
  });
});

describe('composer text', () => {
  test('collapses long or many-line pastes only', () => {
    expect(shouldCollapse('a short note')).toBe(false);
    expect(shouldCollapse('x'.repeat(281))).toBe(true);
    expect(shouldCollapse('1\n2\n3\n4\n5\n6\n7')).toBe(true);
  });

  test('joins the typed draft and the collapsed paste', () => {
    expect(noteText('  intro ', 'pasted body\n')).toBe('intro\n\npasted body');
    expect(noteText('', null)).toBe('');
    expect(noteText('just typed', null)).toBe('just typed');
  });

  test('keeps only what changed while a save was in flight', () => {
    expect(draftAfterSave('buy milk', 'buy milk')).toBe('');
    expect(draftAfterSave('buy milk and eggs', 'buy milk')).toBe('and eggs');
    // The saved text itself was edited: leave it to the user.
    expect(draftAfterSave('buy oat milk', 'buy milk')).toBe('buy oat milk');
    expect(draftAfterSave('', 'buy milk')).toBe('');
  });
});
