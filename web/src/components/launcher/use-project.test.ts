import { describe, expect, test } from 'bun:test';
import type { ProjectSummary } from '@/lib/api/projects';
import { projectChoicePayload, readMode, resolveProject, writeMode } from './use-project';

const project = (id: string): ProjectSummary => ({
  id, name: id, about: null, vocabulary: [], people: null, match: [], recordingCount: 0,
});

describe('launcher project mode', () => {
  test('round-trips through storage and defaults to auto', () => {
    expect(readMode(writeMode('none'))).toBe('none');
    expect(readMode(writeMode({ pinned: 'p1' }))).toEqual({ pinned: 'p1' });
    expect(readMode(null)).toBe('auto');
    expect(readMode('pin:')).toBe('auto');
    expect(readMode('garbage')).toBe('auto');
  });

  test('a pin wins, none clears, and a deleted pin falls back to the detected project', () => {
    const projects = [project('a'), project('b')];
    const detected = projects[0];
    expect(resolveProject(projects, 'auto', detected)).toBe(detected);
    expect(resolveProject(projects, 'none', detected)).toBeNull();
    expect(resolveProject(projects, { pinned: 'b' }, detected)?.id).toBe('b');
    expect(resolveProject(projects, { pinned: 'gone' }, detected)).toBe(detected);
  });
});

describe('native project choice', () => {
  test('sends every project, with its name when it has no match terms', () => {
    const acme = { ...project('acme'), match: ['acme', 'ACME Corp'] };
    expect(projectChoicePayload(true, { pinned: 'acme' }, [project('a'), acme])).toEqual({
      follow: false,
      pinned: 'acme',
      projects: [{ id: 'a', terms: ['a'] }, { id: 'acme', terms: ['acme', 'ACME Corp'] }],
    });
  });
  test('an empty list is still sent, so a deleted last project is forgotten', () => {
    expect(projectChoicePayload(true, 'auto', [])).toEqual({ follow: true, pinned: null, projects: [] });
  });
  test('signed out clears the list and the pin', () => {
    expect(projectChoicePayload(false, { pinned: 'a' }, [project('a')])).toEqual({ follow: false, pinned: null, projects: [] });
  });
});
