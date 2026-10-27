import { describe, expect, test } from 'bun:test';
import {
  MAX_VOCABULARY_TERMS,
  fixBuiltInTerms,
  normalizeVocabulary,
  parseVocabulary,
  vocabularyFromText,
  whisperPrompt,
} from './vocabulary';

describe('custom vocabulary', () => {
  test('splits lines and commas, trims, and drops repeats whatever their case', () => {
    expect(vocabularyFromText('Eavesy\n  Priya Raman , eavesy,\n\nKubernetes')).toEqual([
      'Eavesy',
      'Priya Raman',
      'Kubernetes',
    ]);
  });

  test('caps how many words and how long each one is', () => {
    const many = Array.from({ length: MAX_VOCABULARY_TERMS + 50 }, (_, i) => `word${i}`);
    expect(normalizeVocabulary(many)).toHaveLength(MAX_VOCABULARY_TERMS);
    expect(normalizeVocabulary(['x'.repeat(200)])[0]).toHaveLength(60);
  });

  test('reads stored JSON and ignores anything malformed', () => {
    expect(parseVocabulary('["Tauri", 3, "Tauri"]')).toEqual(['Tauri']);
    expect(parseVocabulary('{"a":1}')).toEqual([]);
    expect(parseVocabulary('not json')).toEqual([]);
    expect(parseVocabulary(null)).toEqual([]);
  });

  test('prompts Whisper with the context first and the words last', () => {
    expect(whisperPrompt({ contextBlurb: 'Launch review.', vocabulary: ['Eavesy', 'Priya'] })).toBe(
      'Launch review. Eavesy, Priya.',
    );
    expect(whisperPrompt({ vocabulary: ['Eavesy'] })).toBe('Eavesy.');
    expect(whisperPrompt({ contextBlurb: '  ' })).toBe('Eavesy.');
    expect(whisperPrompt({ contextBlurb: 'Standup.', vocabulary: ['Priya'] })).toBe('Standup. Eavesy, Priya.');
    expect(whisperPrompt({ contextBlurb: 'x'.repeat(2_000), vocabulary: ['Eavesy'] })?.endsWith(' Eavesy.')).toBe(true);
  });
});

describe('custom vocabulary in the Whisper prompt', () => {
  test('keeps the glossary to whole words within its budget and leaves room for context', () => {
    const words = Array.from({ length: 100 }, (_, i) => `Term${String(i).padStart(2, '0')}-${'x'.repeat(50)}`);
    const prompt = whisperPrompt({ contextBlurb: 'c'.repeat(2_000), vocabulary: words }) ?? '';
    expect(prompt.length).toBeLessThanOrEqual(800);
    expect(prompt.endsWith('.')).toBe(true);
    expect(prompt.startsWith('c')).toBe(true);
    const glossary = prompt.slice(prompt.lastIndexOf('c') + 2, -1).split(', ');
    expect(glossary[0]).toBe('Eavesy');
    expect(glossary.slice(1).every((word) => words.includes(word))).toBe(true);
  });

  test('always names the app, however many words the user has', () => {
    const words = Array.from({ length: 500 }, (_, i) => `word${i}`);
    expect(whisperPrompt({ vocabulary: words })?.startsWith('Eavesy, word0,')).toBe(true);
    expect(whisperPrompt({ vocabulary: ['eavesy', 'Priya'] })).toBe('Eavesy, Priya.');
  });
});

describe('the app name as recognizers mishear it', () => {
  test('is spelled right', () => {
    expect(fixBuiltInTerms('I dictated it in Evesy.')).toBe('I dictated it in Eavesy.');
    expect(fixBuiltInTerms("eavsy's notes, EEVESY and Eavesie")).toBe("Eavesy's notes, Eavesy and Eavesy");
    expect(fixBuiltInTerms('Hey evesy, open eavesy')).toBe('Hey Eavesy, open Eavesy');
  });

  test('never touches real words, longer words, domains or handles', () => {
    for (const text of ['That was easy.', 'On the eves of it.', 'Evie said yes.', 'Evesham', 'eavesy.com', 'evesy.app/login', '@evesy', 'my-evesy', 'Eavesdrop']) {
      expect(fixBuiltInTerms(text)).toBe(text);
    }
    expect(fixBuiltInTerms('I use Evesy.')).toBe('I use Eavesy.');
  });
});
