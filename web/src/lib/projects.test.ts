import { describe, expect, test } from 'bun:test';
import { cleanList, combinedContext, matchProject, whisperPrompt, WHISPER_PROMPT_MAX_CHARS } from './projects';

const eavesy = { name: 'eavesy', match: [] as string[] };
const desktop = { name: 'Desktop app', match: ['eavesy-desktop'] };
const pallet = { name: 'pallet-site', match: ['repackify'] };

describe('matchProject', () => {
  test('matches the name as a whole word in the window title', () => {
    expect(matchProject([eavesy, pallet], { app: 'Cursor', title: 'summarize.ts — eavesy' })).toBe(eavesy);
  });

  test('does not match inside another word', () => {
    expect(matchProject([eavesy], { app: 'Cursor', title: 'eavesydrop — notes' })).toBeNull();
  });

  test('the longest matching term wins', () => {
    expect(matchProject([eavesy, desktop], { app: 'Terminal', title: '~/code/eavesy-desktop' })).toBe(desktop);
  });

  test('uses match terms instead of the name when set', () => {
    expect(matchProject([pallet], { app: 'Code', title: 'repackify/api' })).toBe(pallet);
    expect(matchProject([pallet], { app: 'Code', title: 'pallet-site' })).toBeNull();
  });

  test('falls back to the app name, and handles no window', () => {
    expect(matchProject([{ name: 'Figma', match: [] }], { app: 'Figma', title: null })?.name).toBe('Figma');
    expect(matchProject([eavesy], null)).toBeNull();
    expect(matchProject([eavesy], { app: null, title: '  ' })).toBeNull();
  });
});

describe('whisperPrompt', () => {
  test('puts terms and people first, then the note', () => {
    expect(whisperPrompt('Weekly sync.', { vocabulary: ['Tauri', 'D1'], people: 'Maya (design), Alex' })).toBe(
      'Tauri, D1, Maya, Alex. Weekly sync.',
    );
  });

  test('stays inside the Whisper prompt budget', () => {
    const vocabulary = Array.from({ length: 200 }, (_, index) => `term${index}`);
    expect(whisperPrompt('x'.repeat(2_000), { vocabulary, people: null })!.length).toBeLessThanOrEqual(
      WHISPER_PROMPT_MAX_CHARS + 2,
    );
  });

  test('is undefined with nothing to say', () => {
    expect(whisperPrompt(null, null)).toBeUndefined();
    expect(whisperPrompt('  ', { vocabulary: [], people: null })).toBeUndefined();
  });
});

test('cleanList trims and drops duplicates regardless of case', () => {
  expect(cleanList([' Tauri ', 'tauri', '', 'D1'])).toEqual(['Tauri', 'D1']);
});

test('combinedContext joins the project and the note', () => {
  const project = { id: 'p', name: 'eavesy', about: 'Mac recorder.', vocabulary: ['D1'], people: null, match: [] };
  expect(combinedContext('Focus on sync.', project)).toBe(
    'Project: eavesy\nAbout: Mac recorder.\nTerms (spell exactly like this): D1\n\nFocus on sync.',
  );
  expect(combinedContext(null, null)).toBeNull();
});
