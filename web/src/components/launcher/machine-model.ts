import type { MachineInventory, MachineWorktree, RepoPr, WorktreeDetail } from '@/lib/desktop/bridge';

type Leftover = MachineInventory['leftovers'][number];

/** Leftovers with the same program, shown as one row: 98 `git` fsmonitor daemons are one thing to decide. */
export interface LeftoverGroup {
  key: string;
  name: string;
  exe: string;
  processes: Leftover[];
  /** Processes in the group, counting each one's own helpers. */
  total: number;
  ports: number[];
}

export function groupLeftovers(leftovers: Leftover[]): LeftoverGroup[] {
  const groups = new Map<string, LeftoverGroup>();
  for (const leftover of leftovers) {
    const key = leftover.exe || leftover.name;
    const group = groups.get(key) ?? { key, name: leftover.name, exe: leftover.exe, processes: [], total: 0, ports: [] };
    group.processes.push(leftover);
    group.total += 1 + leftover.helpers;
    for (const port of leftover.ports) if (!group.ports.includes(port)) group.ports.push(port);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.ports.length - a.ports.length || b.total - a.total || a.name.localeCompare(b.name));
}

/** Which worktrees the list shows. */
export type WorktreeFilter = 'removable' | 'attention' | 'all';

/** The chip's colour: leaf for done, manila for in progress, warn for something to look at, the rest are quiet. */
export type ChipTone = 'ok' | 'busy' | 'warn' | 'quiet' | 'wait';

/** One worktree as the list draws it: the quick row, plus whatever the closer look, GitHub and `du` have said so far. */
export interface WorktreeView {
  path: string;
  repo: string;
  branch: string | null;
  /** The status is final (the closer look has answered, or it never needed one). */
  settled: boolean;
  chip: { label: string; tone: ChipTone };
  /** A second chip when there's more to say, like changes on unmerged work. */
  note: string | null;
  pr: RepoPr | null;
  /** Merged, clean, idle: what "Remove merged" takes. */
  removable: boolean;
  /** Changes git would lose, or work that isn't merged and has no open PR. */
  attention: boolean;
  /** The closer look has answered, so activity, changes and distance are real. */
  detailed: boolean;
  exists: boolean;
  lastActivityMs: number | null;
  changes: number;
  ahead: number | null;
  behind: number | null;
  base: string | null;
  /** Bytes; null when it couldn't be read, undefined while it's not been asked. */
  size: number | null | undefined;
}

/** The PR that says the most about a branch: an open one, else a merged one, else the latest closed. */
export function prFor(branch: string | null, prs: RepoPr[] | undefined): RepoPr | null {
  if (!branch || !prs) return null;
  const mine = prs.filter((pr) => pr.branch === branch);
  const rank = { open: 0, merged: 1, closed: 2 } as const;
  return mine.sort((a, b) => rank[a.state] - rank[b.state] || b.number - a.number)[0] ?? null;
}

/** `failed`: the closer look couldn't be made, so the first guess is all there is, and it isn't trusted. */
export function viewWorktree(row: MachineWorktree, detail: WorktreeDetail | undefined, prs: RepoPr[] | undefined, size: number | null | undefined, failed = false): WorktreeView {
  const status = detail?.status ?? row.status;
  const settled = row.settled || detail !== undefined || failed;
  const pr = prFor(row.branch, prs);
  const changes = detail?.changes ?? 0;
  const trusted = row.settled || detail !== undefined;
  let chip: WorktreeView['chip'];
  if (!trusted && failed) chip = { label: 'Couldn’t check', tone: 'quiet' };
  else if (!settled) chip = { label: 'Checking', tone: 'wait' };
  else if (status === 'missing') chip = { label: 'Folder gone', tone: 'quiet' };
  else if (status === 'locked') chip = { label: 'Locked', tone: 'quiet' };
  else if (status === 'in_use') chip = { label: 'In use', tone: 'busy' };
  else if (status === 'stale') chip = { label: 'Merged', tone: 'ok' };
  else if (status === 'dirty') chip = { label: changes > 0 ? 'Uncommitted changes' : 'Local files', tone: 'warn' };
  else if (pr?.state === 'open') chip = { label: `Open PR #${pr.number}`, tone: 'busy' };
  else chip = { label: 'Unmerged', tone: 'warn' };
  const note = trusted && changes > 0 && (status === 'unmerged' || status === 'in_use' || status === 'locked') ? 'Uncommitted changes' : null;
  const openPr = pr?.state === 'open';
  return {
    path: row.path,
    repo: row.repo,
    branch: row.branch,
    settled,
    chip,
    note,
    pr,
    removable: trusted && status === 'stale',
    attention: trusted && status !== 'in_use' && (status === 'dirty' || changes > 0 || (status === 'unmerged' && !openPr)),
    detailed: detail !== undefined,
    exists: status !== 'missing',
    lastActivityMs: detail?.last_activity_ms ?? null,
    changes,
    ahead: detail?.ahead ?? null,
    behind: detail?.behind ?? null,
    base: detail?.base ?? null,
    size,
  };
}

export function matchesFilter(view: WorktreeView, filter: WorktreeFilter): boolean {
  if (filter === 'removable') return view.removable;
  if (filter === 'attention') return view.attention;
  return true;
}

export function filterCounts(views: WorktreeView[]): Record<WorktreeFilter, number> {
  return { removable: views.filter((view) => view.removable).length, attention: views.filter((view) => view.attention).length, all: views.length };
}

export interface RepoGroup {
  repo: string;
  /** The folder's own name, for the heading. */
  name: string;
  views: WorktreeView[];
}

/** Worktrees under their repo, in the order the repos were first seen. */
export function groupByRepo(views: WorktreeView[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const view of views) {
    const group = groups.get(view.repo) ?? { repo: view.repo, name: view.repo.replace(/\/+$/, '').split('/').pop() || view.repo, views: [] };
    group.views.push(view);
    groups.set(view.repo, group);
  }
  return [...groups.values()];
}

/** "3 days ago": how long since something happened. Empty when it's not known. */
export function ageLabel(ms: number | null, now: number): string {
  if (ms === null) return '';
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/** "412 MB", "1.3 GB". */
export function formatSize(bytes: number): string {
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (bytes < 1024) return `${bytes} B`;
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The worktree's own folder name; the full path is in the row's tooltip. */
export function folderName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

/** The one line of small print under a worktree's branch, from what's known so far. Size has its own column. */
export function factsLine(view: WorktreeView, now: number): string {
  const distance = !view.removable && view.ahead !== null && view.behind !== null
    ? [view.ahead > 0 ? `${view.ahead} ahead` : null, view.behind > 0 ? `${view.behind} behind` : null].filter(Boolean).join(', ')
    : '';
  return [
    folderName(view.path),
    view.lastActivityMs !== null ? `active ${ageLabel(view.lastActivityMs, now)}` : null,
    distance || null,
    view.changes > 0 ? plural(view.changes, 'changed file', 'changed files') : null,
  ].filter(Boolean).join(' · ');
}

/** What the top of This Mac says: the one sentence you came for, and what's behind it. */
export function overview({ removable, processes, checking, bytes, measuring = false, worktrees }: {
  removable: number;
  processes: number;
  checking: number;
  /** Known size of the removable worktrees. */
  bytes: number;
  /** Some removable worktrees' sizes aren't in yet, so `bytes` is a floor. */
  measuring?: boolean;
  worktrees: number;
}): { headline: string; detail: string } {
  const parts = [
    removable > 0 ? plural(removable, 'worktree', 'worktrees') : null,
    processes > 0 ? `${plural(processes, 'leftover process', 'leftover processes')}` : null,
  ].filter(Boolean);
  const still = checking > 0 ? `Still checking ${plural(checking, 'worktree', 'worktrees')}.` : null;
  if (parts.length === 0) {
    return {
      headline: checking > 0 ? 'Looking closer…' : 'All tidy.',
      detail: [checking > 0 ? null : `${plural(worktrees, 'worktree', 'worktrees')}, nothing left over.`, still].filter(Boolean).join(' '),
    };
  }
  return {
    headline: `${parts.join(' and ')} can go.`,
    detail: [bytes > 0 ? `Frees ${measuring ? 'at least' : 'about'} ${formatSize(bytes)}.` : null, still].filter(Boolean).join(' '),
  };
}

/** The selection bar: "2 worktrees and 98 processes selected". */
export function selectionLabel(worktrees: number, processes: number): string {
  return `${[
    worktrees > 0 ? plural(worktrees, 'worktree', 'worktrees') : null,
    processes > 0 ? plural(processes, 'process', 'processes') : null,
  ].filter(Boolean).join(' and ')} selected`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The confirm button's words: exactly what it does. */
export function cleanLabel(worktrees: number, processes: number): string {
  const parts = [
    worktrees > 0 ? `remove ${plural(worktrees, 'worktree', 'worktrees')}` : null,
    processes > 0 ? `stop ${plural(processes, 'process', 'processes')}` : null,
  ].filter(Boolean).join(' and ');
  return parts.charAt(0).toUpperCase() + parts.slice(1);
}

/** "node (pid 4191) and the 2 processes it started", for the confirm card. */
export function stopWhat(group: LeftoverGroup): string {
  const [only] = group.processes;
  if (group.processes.length > 1 || !only) return `${group.total} ${group.name} processes`;
  const helpers = only.helpers === 0 ? '' : ` and the ${plural(only.helpers, 'process', 'processes')} it started`;
  return `${group.name} (pid ${only.pid})${helpers}`;
}

/** `~/…` for paths in your home folder. */
export function shortPath(path: string | null, home: string | null): string {
  if (!path) return '';
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** The home folder, guessed from the repos (they're under ~/Developer). */
export function homeOf(inventory: MachineInventory): string | null {
  const match = inventory.repos.map((repo) => /^(\/Users\/[^/]+)\//.exec(repo)?.[1]).find(Boolean);
  return match ?? null;
}
