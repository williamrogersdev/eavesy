import { describe, expect, test } from 'bun:test';
import {
  MAX_VOCABULARY_TERMS,
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
    const many = Array.from({ length: 150 }, (_, i) => `word${i}`);
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
    expect(whisperPrompt({ contextBlurb: '  ' })).toBeUndefined();
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
    expect(glossary.every((word) => words.includes(word))).toBe(true);
  });
});
