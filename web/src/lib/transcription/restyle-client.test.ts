import { describe, expect, test } from 'bun:test';
import { MAX_RESTYLE_CHARS, requestRestyle, restyledText } from './restyle-client';

describe('restyledText', () => {
  test('a rewrite comes back as its text', () => {
    expect(restyledText({ text: 'Hey, remember to send it!', polished: true })).toBe('Hey, remember to send it!');
  });

  test('words the server could not rewrite are an error, not a new version', () => {
    expect(() => restyledText({ text: 'the same words', polished: false })).toThrow('Couldn’t rewrite it in that tone');
    expect(() => restyledText({ text: 'the same words', polished: false, reason: 'too_long' })).toThrow('Too long to rewrite here');
    expect(() => restyledText({ text: '  ' })).toThrow();
    expect(() => restyledText(null)).toThrow();
  });
});

test('words past the limit are refused before asking the server', async () => {
  await expect(requestRestyle('r1', 'a'.repeat(MAX_RESTYLE_CHARS + 1), 'friendly', false)).rejects.toThrow('Too long to rewrite here');
});
