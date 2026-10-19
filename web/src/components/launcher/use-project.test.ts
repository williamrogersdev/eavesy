import { describe, expect, test } from 'bun:test';
import type { ProjectSummary } from '@/lib/api/projects';
import { readMode, resolveProject, writeMode } from './use-project';

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
