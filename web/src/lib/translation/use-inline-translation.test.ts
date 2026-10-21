import { expect, test } from 'bun:test';
import { translationChunks } from './use-inline-translation';

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
