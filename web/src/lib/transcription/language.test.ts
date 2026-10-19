import { describe, expect, test } from 'bun:test';
import {
  dominantLanguage,
  isNotesLanguage,
  isTranscriptionLanguage,
  languageName,
  notesLanguageRule,
  retryLanguage,
  whisperLanguage,
} from './language';

describe('transcription language', () => {
  test('auto or a missing setting lets Whisper detect, a fixed one is sent', () => {
    expect(whisperLanguage('auto')).toBeUndefined();
    expect(whisperLanguage(undefined)).toBeUndefined();
    expect(whisperLanguage('')).toBeUndefined();
    expect(whisperLanguage(' FR ')).toBe('fr');
  });

  test('only offered languages can be saved', () => {
    expect(isTranscriptionLanguage('auto')).toBe(true);
    expect(isTranscriptionLanguage('ja')).toBe(true);
    expect(isTranscriptionLanguage('yue')).toBe(true);
    expect(isTranscriptionLanguage('klingon')).toBe(false);
    expect(isNotesLanguage('auto')).toBe(false);
    expect(isNotesLanguage('es')).toBe(true);
  });

  test('names come from the list, then from Intl', () => {
    expect(languageName('es')).toBe('Spanish');
    expect(languageName('cy')).toBe('Welsh');
    expect(languageName(null)).toBe('');
  });
});

describe('retryLanguage', () => {
  const base = { setting: 'auto', established: 'es' };

  test('an unsure detection that disagrees with the meeting is retried in its language', () => {
    expect(retryLanguage({ ...base, detected: 'gl', probability: 0.41 })).toBe('es');
  });

  test('a confident switch of language is kept', () => {
    expect(retryLanguage({ ...base, detected: 'en', probability: 0.93 })).toBeUndefined();
    expect(retryLanguage({ ...base, detected: 'pt', probability: undefined })).toBeUndefined();
  });

  test('nothing to retry when it agrees, has no history, or the language is fixed', () => {
    expect(retryLanguage({ ...base, detected: 'es', probability: 0.3 })).toBeUndefined();
    expect(retryLanguage({ ...base, established: null, detected: 'gl', probability: 0.3 })).toBeUndefined();
    expect(retryLanguage({ setting: 'en', established: 'es', detected: 'gl', probability: 0.3 })).toBeUndefined();
  });
});

describe('dominantLanguage', () => {
  test('weighs languages by how much was said in them', () => {
    expect(
      dominantLanguage([
        { language: 'en', text: 'ok' },
        { language: 'en', text: 'yes' },
        { language: 'es', text: 'Vamos a revisar el presupuesto del trimestre' },
        { language: null, text: 'ignored' },
      ]),
    ).toBe('es');
    expect(dominantLanguage([])).toBeUndefined();
  });
});

describe('notesLanguageRule', () => {
  test('names the chosen language, or keeps the meeting’s own', () => {
    expect(notesLanguageRule('en')).toContain('in English, translating');
    expect(notesLanguageRule(null)).toContain('language most of the meeting was spoken in');
    expect(notesLanguageRule('auto')).toContain('language most of the meeting was spoken in');
  });
});
