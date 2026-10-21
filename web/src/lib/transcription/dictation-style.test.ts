import { describe, expect, test } from 'bun:test';
import { dictationStyle, withoutSwearing } from './dictation-style';

describe('withoutSwearing', () => {
  test('drops swear words and tidies the gaps', () => {
    expect(withoutSwearing('What the fuck, this shit is broken again.')).toBe('What, this is broken again.');
    expect(withoutSwearing('Fucking ship it.')).toBe('Ship it.');
  });
  test('leaves ordinary words alone', () => {
    expect(withoutSwearing('Pass the class assessment to Cassandra.')).toBe('Pass the class assessment to Cassandra.');
  });
});

test('unknown styles fall back to the natural one', () => {
  expect(dictationStyle('concise')).toBe('concise');
  expect(dictationStyle('prompt')).toBe('natural');
  expect(dictationStyle('pirate')).toBe('natural');
  expect(dictationStyle(null)).toBe('natural');
});
