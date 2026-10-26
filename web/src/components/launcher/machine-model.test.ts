import { describe, expect, test } from 'bun:test';
import type { MachineWorktree, RepoPr, WorktreeDetail } from '@/lib/desktop/bridge';
import { ageLabel, cleanLabel, factsLine, filterCounts, formatSize, groupByRepo, groupLeftovers, homeOf, matchesFilter, prFor, overview, selectionLabel, shortPath, stopWhat, viewWorktree } from './machine-model';

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

  const row = (path: string, status: MachineWorktree['status'], settled: boolean, branch: string | null = path.split('/').pop() ?? null): MachineWorktree => ({ path, repo: '/Users/w/Developer/eavesy', branch, status, settled });
  const detail = (path: string, status: WorktreeDetail['status'], extra: Partial<WorktreeDetail> = {}): WorktreeDetail => ({
    path, status, merged_via: null, changes: 0, last_commit_ms: null, last_activity_ms: null, base: 'origin/main', ahead: null, behind: null, ...extra,
  });
  const pr = (number: number, state: RepoPr['state'], branch: string): RepoPr => ({ number, state, branch, url: `https://github.com/o/r/pull/${number}` });

  test('a row is checking until its closer look arrives, and can only be removed once it says merged', () => {
    const quick = row('/r/a', 'stale', false);
    const before = viewWorktree(quick, undefined, undefined, undefined);
    expect(before.chip).toEqual({ label: 'Checking', tone: 'wait' });
    expect(before.removable).toBe(false);
    const after = viewWorktree(quick, detail('/r/a', 'stale', { merged_via: 'squash' }), undefined, undefined);
    expect(after.chip).toEqual({ label: 'Merged', tone: 'ok' });
    expect(after.removable).toBe(true);
    // The quick guess was wrong: it had changes after all.
    const changed = viewWorktree(quick, detail('/r/a', 'dirty', { changes: 3 }), undefined, undefined);
    expect(changed.chip.label).toBe('Uncommitted changes');
    expect(changed.removable).toBe(false);
    expect(changed.attention).toBe(true);
    // A failed look is never trusted to remove.
    const gone = viewWorktree(quick, undefined, undefined, undefined, true);
    expect(gone.chip.label).toBe('Couldn’t check');
    expect(gone.removable).toBe(false);
  });

  test('settled rows need no closer look to be named', () => {
    expect(viewWorktree(row('/r/b', 'in_use', true), undefined, undefined, undefined).chip.label).toBe('In use');
    expect(viewWorktree(row('/r/c', 'locked', true), undefined, undefined, undefined).chip.label).toBe('Locked');
    expect(viewWorktree(row('/r/d', 'missing', true), undefined, undefined, undefined).exists).toBe(false);
  });

  test('unmerged work shows its open PR, and needs attention only without one', () => {
    const unmerged = row('/r/feat', 'unmerged', false, 'feat');
    const info = detail('/r/feat', 'unmerged', { changes: 2 });
    const plain = viewWorktree(unmerged, info, [], undefined);
    expect(plain.chip.label).toBe('Unmerged');
    expect(plain.note).toBe('Uncommitted changes');
    expect(plain.attention).toBe(true);
    const withPr = viewWorktree(unmerged, detail('/r/feat', 'unmerged'), [pr(7, 'closed', 'feat'), pr(9, 'open', 'feat')], undefined);
    expect(withPr.chip).toEqual({ label: 'Open PR #9', tone: 'busy' });
    expect(withPr.attention).toBe(false);
    expect(prFor('feat', [pr(1, 'closed', 'feat'), pr(2, 'merged', 'feat')])?.number).toBe(2);
    expect(prFor('feat', undefined)).toBeNull();
    expect(prFor(null, [pr(1, 'open', 'feat')])).toBeNull();
  });

  test('filters count and group by repo', () => {
    const views = [
      viewWorktree(row('/r/a', 'stale', false), detail('/r/a', 'stale'), undefined, undefined),
      viewWorktree(row('/r/b', 'unmerged', false), detail('/r/b', 'unmerged'), undefined, undefined),
      viewWorktree({ ...row('/q/c', 'in_use', true), repo: '/Users/w/Developer/other' }, undefined, undefined, undefined),
    ];
    expect(filterCounts(views)).toEqual({ removable: 1, attention: 1, all: 3 });
    expect(views.filter((view) => matchesFilter(view, 'removable')).map((view) => view.path)).toEqual(['/r/a']);
    expect(groupByRepo(views).map((group) => [group.name, group.views.length])).toEqual([['eavesy', 2], ['other', 1]]);
  });

  test('says how long ago and how big in plain numbers', () => {
    const now = 1_000_000_000_000;
    expect(ageLabel(null, now)).toBe('');
    expect(ageLabel(now - 20_000, now)).toBe('just now');
    expect(ageLabel(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(ageLabel(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(ageLabel(now - 30 * 3_600_000, now)).toBe('yesterday');
    expect(ageLabel(now - 4 * 86_400_000, now)).toBe('4 days ago');
    expect(ageLabel(now - 21 * 86_400_000, now)).toBe('3 weeks ago');
    expect(ageLabel(now - 100 * 86_400_000, now)).toBe('3 months ago');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(300 * 1024)).toBe('300 KB');
    expect(formatSize(412 * 1024 * 1024)).toBe('412 MB');
    expect(formatSize(1.3 * 1024 ** 3)).toBe('1.3 GB');
  });

  test('the small print only says what is known', () => {
    const now = 1_000_000_000_000;
    const bare = viewWorktree(row('/Users/w/Developer/eavesy/wt', 'unmerged', false), undefined, undefined, undefined);
    expect(factsLine(bare, now)).toBe('wt');
    const full = viewWorktree(row('/Users/w/Developer/eavesy/wt', 'unmerged', false), detail('/Users/w/Developer/eavesy/wt', 'unmerged', { last_activity_ms: now - 2 * 86_400_000, ahead: 2, behind: 14, changes: 1 }), undefined, 420 * 1024 * 1024);
    expect(factsLine(full, now)).toBe('wt · active 2 days ago · 2 ahead, 14 behind · 1 changed file');
    // A merged one's distance from main says nothing useful.
    const merged = viewWorktree(row('/r/m', 'stale', false), detail('/r/m', 'stale', { ahead: 3, behind: 40 }), undefined, null);
    expect(factsLine(merged, now)).toBe('m');
  });

  test('the overview says what can go, or that all is tidy', () => {
    expect(overview({ removable: 2, processes: 101, checking: 0, bytes: 1.8 * 1024 ** 3, worktrees: 8 }))
      .toEqual({ headline: '2 worktrees and 101 leftover processes can go.', detail: 'Frees about 1.8 GB.' });
    expect(overview({ removable: 1, processes: 0, checking: 3, bytes: 0, worktrees: 8 }))
      .toEqual({ headline: '1 worktree can go.', detail: 'Still checking 3 worktrees.' });
    expect(overview({ removable: 0, processes: 0, checking: 0, bytes: 0, worktrees: 8 }))
      .toEqual({ headline: 'All tidy.', detail: '8 worktrees, nothing left over.' });
    expect(overview({ removable: 0, processes: 0, checking: 2, bytes: 0, worktrees: 8 }).headline).toBe('Looking closer…');
    expect(selectionLabel(2, 98)).toBe('2 worktrees and 98 processes selected');
    expect(selectionLabel(0, 1)).toBe('1 process selected');
  });
});
