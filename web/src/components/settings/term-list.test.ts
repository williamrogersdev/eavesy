import { describe, expect, test } from 'bun:test';
import { addTerms, keyDraft, typeDraft } from './term-list';

describe('term input parsing', () => {
  test('a comma commits the draft and clears it', () => {
    expect(typeDraft(['D1'], 'Tauri,', 10)).toEqual({ list: ['D1', 'Tauri'], draft: '' });
  });

  test('pasting several comma-separated terms adds each one, skipping duplicates', () => {
    expect(typeDraft(['D1'], ' wrangler , d1, Tauri,', 10)).toEqual({ list: ['D1', 'wrangler', 'Tauri'], draft: '' });
  });

  test('a lone comma adds nothing and is dropped from the draft', () => {
    expect(typeDraft([], ',', 10)).toEqual({ list: null, draft: '' });
  });

  test('typing without a comma only updates the draft', () => {
    expect(typeDraft(['D1'], 'Tau', 10)).toEqual({ list: null, draft: 'Tau' });
  });

  test('Enter commits the draft and is handled', () => {
    expect(keyDraft(['D1'], 'Tauri', 'Enter', 10)).toEqual({ list: ['D1', 'Tauri'], draft: '', handled: true });
  });

  test('Enter on a blank draft keeps the list', () => {
    expect(keyDraft(['D1'], '  ', 'Enter', 10)).toEqual({ list: null, draft: '  ', handled: true });
  });

  test('Backspace in an empty draft removes the last term', () => {
    expect(keyDraft(['D1', 'Tauri'], '', 'Backspace', 10)).toEqual({ list: ['D1'], draft: '', handled: false });
  });

  test('Backspace while typing only edits the draft', () => {
    expect(keyDraft(['D1', 'Tauri'], 'wr', 'Backspace', 10).list).toBeNull();
    expect(keyDraft([], '', 'Backspace', 10).list).toBeNull();
  });

  test('the list stops at the limit', () => {
    expect(addTerms(['a', 'b'], 'c, d', 3)).toEqual(['a', 'b', 'c']);
  });

  test('a commit after the list already changed builds on the latest list', () => {
    const afterSuggestion = ['D1', 'Tauri'];
    expect(addTerms(afterSuggestion, 'wrangler', 10)).toEqual(['D1', 'Tauri', 'wrangler']);
  });
});
