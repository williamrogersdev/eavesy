import { describe, expect, test } from 'bun:test';
import { dictationStyle, withoutSwearing } from './dictation-style';

describe('withoutSwearing', () => {
  test('drops swear words and tidies the gaps', () => {
    expect(withoutSwearing('What the fuck, this shit is broken again.')).toBe('What, this is broken again.');
    expect(withoutSwearing('Fucking ship it.')).toBe('Ship it.');
  });
  test('leaves ordinary words alone', () => {
    expect(withoutSwearing('Pass the class assessment to Cassandra.')).toBe('Pass the class assessment to Cassandra.');
    expect(withoutSwearing('Move the assets to the shell script, hello Michelle.')).toBe('Move the assets to the shell script, hello Michelle.');
  });
  test('keeps paragraphs and lists', () => {
    expect(withoutSwearing('Fix the shit login.\n\n1. Add a damn test.\n2. Ship it.')).toBe('Fix the login.\n\n1. Add a test.\n2. Ship it.');
  });
  test('keeps the word before a swear word', () => {
    expect(withoutSwearing('Fix the damn build.')).toBe('Fix the build.');
    expect(withoutSwearing('What the hell happened, wtf.')).toBe('What happened.');
  });
});

test('unknown styles fall back to the natural one', () => {
  expect(dictationStyle('concise')).toBe('concise');
  expect(dictationStyle('prompt')).toBe('natural');
  expect(dictationStyle('pirate')).toBe('natural');
  expect(dictationStyle(null)).toBe('natural');
});
