import { expect, test } from 'bun:test';
import { MAX_RECENT_LANGUAGES, RECENT_LANGUAGES_KEY, findLanguages, loadRecentLanguages, rememberLanguage } from './hud-language';

test('with nothing typed, recent languages lead and nothing is repeated', () => {
  const list = findLanguages('', ['es', 'en']);
  expect(list.slice(0, 2)).toEqual(['es', 'en']);
  expect(new Set(list).size).toBe(list.length);
});

test('a few letters find a language, names that start with them first', () => {
  expect(findLanguages('spa')[0]).toBe('es');
  expect(findLanguages('SPANISH')[0]).toBe('es');
  expect(findLanguages('ger')[0]).toBe('de');
  expect(findLanguages('xyzzy')).toEqual([]);
});

test('a language code matches exactly', () => {
  expect(findLanguages('pt')[0]).toBe('pt');
});

test('among equal matches a recent language wins', () => {
  const plain = findLanguages('n');
  const withRecent = findLanguages('n', ['nl']);
  expect(withRecent.indexOf('nl')).toBeLessThanOrEqual(plain.indexOf('nl'));
});

test('recent languages read back from storage are valid and never repeated', () => {
  const store = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) } });
  store.set(RECENT_LANGUAGES_KEY, JSON.stringify(['es', 'es', 'klingon', 'en', 'es']));
  expect(loadRecentLanguages()).toEqual(['es', 'en']);
  store.set(RECENT_LANGUAGES_KEY, 'not json');
  expect(loadRecentLanguages()).toEqual([]);
});

test('remembering a language puts it first, once, and keeps the list short', () => {
  expect(rememberLanguage(['en', 'es'], 'es')).toEqual(['es', 'en']);
  expect(rememberLanguage(['en', 'es', 'fr', 'de'], 'it')).toHaveLength(MAX_RECENT_LANGUAGES);
  expect(rememberLanguage(['en', 'es', 'fr', 'de'], 'it')[0]).toBe('it');
});
