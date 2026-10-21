import { expect, test } from 'bun:test';
import { translationChunks, joinTranslatedChunks } from './use-inline-translation';

test('long note translation includes every character, including Unicode at chunk boundaries', () => {
  for (const source of [
    'First paragraph.\n\n'.repeat(900),
    'x'.repeat(3999) + '🙂' + 'y'.repeat(4100),
    'Without spaces'.repeat(700),
  ]) {
    const chunks = translationChunks(source);
    expect(chunks.join('')).toBe(source);
    expect(chunks.every(chunk => chunk.length <= 4000 && chunk.length > 0)).toBe(true);
    expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  }
});

test('translated chunk boundaries keep the source paragraph structure', () => {
  expect(joinTranslatedChunks(['first ', 'second'], [' Uno ', ' Dos '])).toBe('Uno Dos');
  expect(joinTranslatedChunks(['first\n\n', 'second'], [' Uno ', ' Dos '])).toBe('Uno\n\nDos');
  expect(joinTranslatedChunks(['unbroken', 'token'], [' Uno ', ' Dos '])).toBe('UnoDos');
});
