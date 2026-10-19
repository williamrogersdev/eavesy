import { describe, expect, test } from 'bun:test';
import { isTranscriptionLanguage, whisperLanguage } from './language';

describe('transcription language', () => {
  test('auto sends no language, a missing one keeps English', () => {
    expect(whisperLanguage('auto')).toBeUndefined();
    expect(whisperLanguage(' FR ')).toBe('fr');
    expect(whisperLanguage(undefined)).toBe('en');
    expect(whisperLanguage('')).toBe('en');
  });

  test('only offered languages can be saved', () => {
    expect(isTranscriptionLanguage('auto')).toBe(true);
    expect(isTranscriptionLanguage('ja')).toBe(true);
    expect(isTranscriptionLanguage('klingon')).toBe(false);
  });
});
