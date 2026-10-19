import { describe, expect, test } from 'bun:test';
import {
  dominantLanguage,
  isNotesLanguage,
  isTranscriptionLanguage,
  languageName,
  languagesFromLocales,
  normalizeSpokenLanguages,
  notesLanguageRule,
  retryLanguage,
  spokenLanguages,
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

describe('retryLanguage with the languages the user speaks', () => {
  const spoken = ['en', 'es'];

  test('a fairly sure detection outside them is steered to the meeting, else their first', () => {
    expect(retryLanguage({ setting: 'auto', detected: 'cy', probability: 0.72, established: 'en', spoken })).toBe('en');
    expect(retryLanguage({ setting: 'auto', detected: 'gl', probability: 0.8, established: 'es', spoken })).toBe('es');
    expect(retryLanguage({ setting: 'auto', detected: 'nl', probability: 0.7, established: null, spoken })).toBe('en');
  });

  test('a near-certain other language, or one of theirs, is kept', () => {
    expect(retryLanguage({ setting: 'auto', detected: 'de', probability: 0.97, established: 'en', spoken })).toBeUndefined();
    expect(retryLanguage({ setting: 'auto', detected: 'es', probability: 0.7, established: null, spoken })).toBeUndefined();
  });

  test('a meeting that has been in another language all along is left there', () => {
    expect(retryLanguage({ setting: 'auto', detected: 'de', probability: 0.7, established: 'de', spoken })).toBeUndefined();
    expect(retryLanguage({ setting: 'auto', detected: 'nl', probability: 0.7, established: 'de', spoken })).toBe('de');
    expect(retryLanguage({ setting: 'auto', detected: 'nl', probability: 0.9, established: 'de', spoken })).toBeUndefined();
  });
});

describe('spoken languages', () => {
  test('keeps offered languages once, in order, up to five', () => {
    expect(normalizeSpokenLanguages(['ES', 'en', 'es', 'auto', 'klingon', 3, 'fr', 'de', 'it', 'pt'])).toEqual([
      'es',
      'en',
      'fr',
      'de',
      'it',
    ]);
  });

  test('falls back to a fixed language from before, else none', () => {
    expect(spokenLanguages({ spokenLanguagesJson: '["fr","en"]', defaultLanguage: 'auto' })).toEqual(['fr', 'en']);
    expect(spokenLanguages({ spokenLanguagesJson: null, defaultLanguage: 'de' })).toEqual(['de']);
    expect(spokenLanguages({ spokenLanguagesJson: 'nope', defaultLanguage: 'auto' })).toEqual([]);
  });

  test('reads browser locales', () => {
    expect(languagesFromLocales(['en-GB', 'en-US', 'es-419', 'nb-NO', 'xx'])).toEqual(['en', 'es', 'no']);
  });
});
