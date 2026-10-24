import type { MachineInventory, WorktreeStatus } from '@/lib/desktop/bridge';

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

const KEPT_LABEL: Record<Exclude<WorktreeStatus, 'stale'>, string> = {
  dirty: 'with changes or local files',
  unmerged: 'not merged',
  in_use: 'in use',
  locked: 'locked',
  missing: 'missing their folder',
};

/** "178 not merged, 13 with changes or local files": the worktrees Eavesy leaves alone, and why. */
export function keptSummary(statuses: WorktreeStatus[]): string {
  const counts = new Map<Exclude<WorktreeStatus, 'stale'>, number>();
  for (const status of statuses) if (status !== 'stale') counts.set(status, (counts.get(status) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([status, count]) => `${count} ${KEPT_LABEL[status]}`).join(', ');
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
