import { describe, expect, test } from 'bun:test';
import { dictationStyle, effectiveDictation, requestedDictation, sameWriting, withoutSwearing, writingFrom, writtenWith } from './dictation-style';

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

describe('effectiveDictation', () => {
  const account = { dictationStyle: 'professional', dictationForAgents: false };
  test('uses the account without a project or overrides', () => {
    expect(effectiveDictation(account)).toEqual({ style: 'professional', forAgents: false });
    expect(effectiveDictation(account, { dictationStyle: null, dictationForAgents: null })).toEqual({ style: 'professional', forAgents: false });
  });
  test('a project overrides each setting on its own', () => {
    expect(effectiveDictation(account, { dictationForAgents: true })).toEqual({ style: 'professional', forAgents: true });
    expect(effectiveDictation(account, { dictationStyle: 'concise', dictationForAgents: false })).toEqual({ style: 'concise', forAgents: false });
  });
  test('defaults with no account', () => {
    expect(effectiveDictation(null)).toEqual({ style: 'natural', forAgents: false });
  });
});

test('a requested tone overrides the saved one, and only what was asked for', () => {
  const saved = { style: 'professional' as const, forAgents: true };
  expect(requestedDictation({}, saved)).toEqual(saved);
  expect(requestedDictation({ style: 'friendly' }, saved)).toEqual({ style: 'friendly', forAgents: true });
  expect(requestedDictation({ forAgents: false }, saved)).toEqual({ style: 'professional', forAgents: false });
});

describe('writtenWith', () => {
  const account = { dictationStyle: 'professional', dictationForAgents: true };
  test('is the saved choice, and names no project when the project has none of its own', () => {
    expect(writtenWith({}, account, null)).toEqual({ style: 'professional', forAgents: true, projectId: null });
    expect(writtenWith({}, account, { id: 'p1', dictationStyle: null, dictationForAgents: null })).toEqual({ style: 'professional', forAgents: true, projectId: null });
  });
  test('names the project that set its own tone, even for only one of the two', () => {
    expect(writtenWith({}, account, { id: 'p1', dictationStyle: 'concise', dictationForAgents: null })).toEqual({ style: 'concise', forAgents: true, projectId: 'p1' });
    expect(writtenWith({}, account, { id: 'p1', dictationStyle: null, dictationForAgents: false })).toEqual({ style: 'professional', forAgents: false, projectId: 'p1' });
  });
  test('a rewrite request is what the words are in', () => {
    expect(writtenWith({ style: 'friendly' }, account, null)).toEqual({ style: 'friendly', forAgents: true, projectId: null });
    expect(writtenWith({ forAgents: false }, null, null)).toEqual({ style: 'natural', forAgents: false, projectId: null });
  });
});

test('writingFrom reads a reply and rejects anything else', () => {
  expect(writingFrom({ style: 'concise', forAgents: true, projectId: 'p1' })).toEqual({ style: 'concise', forAgents: true, projectId: 'p1' });
  expect(writingFrom({ style: 'concise' })).toEqual({ style: 'concise', forAgents: false, projectId: null });
  expect(writingFrom({ style: 'pirate', forAgents: true })).toBeNull();
  expect(writingFrom(null)).toBeNull();
  expect(writingFrom('concise')).toBeNull();
});

test('sameWriting compares both halves', () => {
  expect(sameWriting({ style: 'natural', forAgents: false }, { style: 'natural', forAgents: false })).toBe(true);
  expect(sameWriting({ style: 'natural', forAgents: true }, { style: 'natural', forAgents: false })).toBe(false);
  expect(sameWriting({ style: 'concise', forAgents: false }, { style: 'natural', forAgents: false })).toBe(false);
});
