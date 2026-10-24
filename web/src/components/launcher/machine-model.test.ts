import { describe, expect, test } from 'bun:test';
import { cleanLabel, groupLeftovers, homeOf, keptSummary, shortPath, stopWhat } from './machine-model';

const leftover = (pid: number, name: string, exe: string, extra: { helpers?: number; ports?: number[] } = {}) => ({
  pid, started_us: pid * 10, name, exe, cwd: null, session_id: null, helpers: extra.helpers ?? 0, ports: extra.ports ?? [],
});

describe('machine model', () => {
  test('groups leftovers by program, ports first', () => {
    const groups = groupLeftovers([
      leftover(1, 'git', '/opt/homebrew/bin/git'),
      leftover(2, 'git', '/opt/homebrew/bin/git'),
      leftover(3, 'node', '/opt/homebrew/bin/node', { helpers: 2, ports: [5173] }),
    ]);
    expect(groups.map((g) => [g.name, g.total, g.ports])).toEqual([['node', 3, [5173]], ['git', 2, []]]);
    expect(groups[1]?.processes.map((p) => p.pid)).toEqual([1, 2]);
    expect(groups.map(stopWhat)).toEqual(['node (pid 3) and the 2 processes it started', '2 git processes']);
  });

  test('says why worktrees are kept, most first', () => {
    expect(keptSummary(['stale', 'unmerged', 'dirty', 'unmerged', 'in_use'])).toBe('2 not merged, 1 with changes or local files, 1 in use');
    expect(keptSummary(['stale'])).toBe('');
  });

  test('the confirm button names what it does', () => {
    expect(cleanLabel(3, 0)).toBe('Remove 3 worktrees');
    expect(cleanLabel(1, 1)).toBe('Remove 1 worktree and stop 1 process');
    expect(cleanLabel(0, 98)).toBe('Stop 98 processes');
  });

  test('shortens home paths', () => {
    const home = homeOf({ repos: ['/Users/w/Developer/eavesy'], worktrees: [], leftovers: [], zombies: [], ports: [] });
    expect(home).toBe('/Users/w');
    expect(shortPath('/Users/w/Developer/x', home)).toBe('~/Developer/x');
    expect(shortPath('/Users/wx/a', home)).toBe('/Users/wx/a');
    expect(shortPath(null, home)).toBe('');
  });
});
