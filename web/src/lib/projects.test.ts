import { describe, expect, test } from 'bun:test';
import { cleanList, combinedContext, matchProject, PROJECT_LIMITS, projectTerms, projectWords, wordsToFields } from './projects';

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

test('combinedContext adds the user\'s custom words after the project', () => {
  expect(combinedContext('Standup.', null, ['Kubernetes'])).toBe('More terms (spell exactly like this): Kubernetes\n\nStandup.');
  expect(combinedContext(null, null, [])).toBeNull();
});

test('projectTerms lists the vocabulary, then the names in the people line', () => {
  expect(projectTerms({ vocabulary: ['Tauri', 'D1'], people: 'Maya (design), Alex' })).toEqual(['Tauri', 'D1', 'Maya', 'Alex']);
  expect(projectTerms(null)).toEqual([]);
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

test('projectWords merges the people line into the words without duplicates', () => {
  expect(projectWords({ vocabulary: ['Tauri', 'Maya'], people: 'maya (design), Alex' })).toEqual(['Tauri', 'Maya', 'Alex']);
  expect(projectWords({ vocabulary: [], people: null })).toEqual([]);
});

test('wordsToFields stores words as vocabulary and clears the people line', () => {
  expect(wordsToFields(['Tauri', 'tauri', 'Alex'])).toEqual({ vocabulary: ['Tauri', 'Alex'], people: null });
});

test('wordsToFields keeps words past the vocabulary limit in the people line', () => {
  const words = Array.from({ length: PROJECT_LIMITS.vocabulary + 2 }, (_, index) => `w${index}`);
  const fields = wordsToFields(words);
  expect(fields.vocabulary).toHaveLength(PROJECT_LIMITS.vocabulary);
  expect(fields.people).toBe(`w${PROJECT_LIMITS.vocabulary}, w${PROJECT_LIMITS.vocabulary + 1}`);
  expect(projectWords(fields)).toEqual(words);
});
