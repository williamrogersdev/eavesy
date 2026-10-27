import { describe, expect, test } from 'bun:test';
import { LONG_CHIP_LIST, visibleChips } from './use-chip-field';

describe('visibleChips', () => {
  test('a short list shows in the order it was typed', () => {
    expect(visibleChips(['Tauri', 'D1', 'R2'], 'd', false)).toEqual(['Tauri', 'D1', 'R2']);
  });

  test('a long list shows newest first and narrows to what is typed, any case', () => {
    const words = Array.from({ length: LONG_CHIP_LIST + 1 }, (_, i) => `word${i}`);
    words.push('Kubernetes', 'kubectl');
    expect(visibleChips(words, '', true).slice(0, 2)).toEqual(['kubectl', 'Kubernetes']);
    expect(visibleChips(words, '  KUB ', true)).toEqual(['kubectl', 'Kubernetes']);
    expect(visibleChips(words, 'nothing', true)).toEqual([]);
  });
});
