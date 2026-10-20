import { describe, expect, test } from 'bun:test';
import type { ProjectSummary } from '@/lib/api/projects';
import { chooseProject, loadPicker, MANAGE, projectOptions } from './project-options';

const project = (id: string): ProjectSummary => ({
  id, name: `Project ${id}`, about: null, vocabulary: [], people: null, match: [], recordingCount: 0,
});

describe('project picker', () => {
  test('a stored project that no longer exists shows as Unknown project', () => {
    expect(projectOptions([project('a')], 'gone')).toEqual([
      { value: '', label: 'No project' },
      { value: 'gone', label: 'Unknown project' },
      { value: 'a', label: 'Project a' },
      { value: MANAGE, label: 'Manage projects…' },
    ]);
  });

  test('a known or empty project needs no placeholder', () => {
    expect(projectOptions([project('a')], 'a').map((option) => option.label)).not.toContain('Unknown project');
    expect(projectOptions([], null).map((option) => option.label)).toEqual(['No project', 'Create a project…']);
  });

  test('choosing No project clears the recording’s project', async () => {
    const calls: [string, string | null][] = [];
    const result = await chooseProject('m1', '', {
      manage: () => { throw new Error('should not manage'); },
      assign: async (meetingId, projectId) => { calls.push([meetingId, projectId]); },
    });
    expect(result).toBe('assigned');
    expect(calls).toEqual([['m1', null]]);
  });

  test('choosing manage opens settings without changing the recording', async () => {
    let managed = false;
    const result = await chooseProject('m1', MANAGE, {
      manage: () => { managed = true; },
      assign: () => Promise.reject(new Error('should not assign')),
    });
    expect(result).toBe('managed');
    expect(managed).toBe(true);
  });

  test('a failed load shows Projects unavailable', async () => {
    expect(await loadPicker(() => Promise.reject(new Error('Server returned status 500')))).toEqual({
      kind: 'unavailable',
      label: 'Projects unavailable',
    });
  });

  test('a cancelled load changes nothing', async () => {
    expect(await loadPicker(() => Promise.reject(new DOMException('aborted', 'AbortError')))).toBeNull();
  });

  test('a successful load is ready', async () => {
    expect(await loadPicker(async () => [project('a')])).toEqual({ kind: 'ready', projects: [project('a')] });
  });
});
