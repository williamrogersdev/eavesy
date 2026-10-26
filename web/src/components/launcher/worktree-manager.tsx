'use client';

import { FolderOpen, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getRepoPrs, getWorktreeDetails, getWorktreeSize, openPr, openWorktree,
  type MachineWorktree, type RepoPr, type WorktreeDetail,
} from '@/lib/desktop/bridge';
import { errMsg } from '@/lib/desktop/errors';
import { Card, Chip, IconButton } from './ui';
import {
  factsLine, filterCounts, folderName, formatSize, groupByRepo, matchesFilter, shortPath, viewWorktree,
  type WorktreeFilter, type WorktreeView,
} from './machine-model';
import './machine.css';

/** Worktrees looked at together, and how many of those calls run at once. */
const BATCH = 12;
const DETAIL_WORKERS = 3;
/** `du` on node_modules is heavy, so only two run at a time. */
const SIZE_WORKERS = 2;

/**
 * What the closer look, GitHub and `du` have said about the worktrees so far.
 * Everything arrives after the list is already on screen and fills in rows as
 * it lands; a failure leaves a row as it was. `token` changes on every full
 * look, which starts over.
 */
function useWorktreeInfo(worktrees: MachineWorktree[], token: number) {
  const [details, setDetails] = useState<Map<string, WorktreeDetail>>(new Map());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [prs, setPrs] = useState<Map<string, RepoPr[]>>(new Map());
  const [sizes, setSizes] = useState<Map<string, number | null>>(new Map());
  const latest = useRef(worktrees);
  latest.current = worktrees;
  const generation = useRef(0);
  const sizeQueue = useRef<string[]>([]);
  const sizeAsked = useRef(new Set<string>());
  const sizeRunning = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    const live = () => generation.current === mine;
    setDetails(new Map());
    setFailed(new Set());
    setPrs(new Map());
    setSizes(new Map());
    sizeQueue.current = [];
    sizeAsked.current = new Set();
    sizeRunning.current = 0;

    const rows = latest.current.filter((row) => row.status !== 'missing');
    // Rows that look merged first: they're what you came to remove.
    const ordered = [...rows.filter((row) => !row.settled && row.status === 'stale'), ...rows.filter((row) => row.settled || row.status !== 'stale')];
    const batches: string[][] = [];
    for (let i = 0; i < ordered.length; i += BATCH) batches.push(ordered.slice(i, i + BATCH).map((row) => row.path));
    const work = async () => {
      for (let batch = batches.shift(); batch; batch = batches.shift()) {
        try {
          const found = await getWorktreeDetails(batch);
          if (!live()) return;
          const seen = new Set(found.map((detail) => detail.path));
          setDetails((current) => {
            const next = new Map(current);
            for (const detail of found) next.set(detail.path, detail);
            return next;
          });
          const missed = batch.filter((path) => !seen.has(path));
          if (missed.length > 0) setFailed((current) => new Set([...current, ...missed]));
        } catch {
          if (!live()) return;
          setFailed((current) => new Set([...current, ...batch]));
        }
      }
    };
    for (let i = 0; i < DETAIL_WORKERS; i++) void work();

    // Pull requests are a network call per repo; they only sharpen the chips.
    const repos = [...new Set(latest.current.map((row) => row.repo))];
    void (async () => {
      for (const repo of repos) {
        try {
          const found = await getRepoPrs(repo);
          if (!live()) return;
          setPrs((current) => new Map(current).set(repo, found.prs));
        } catch {
          // No PR state for this repo; its chips stay git-only.
        }
      }
    })();
    return () => { generation.current += 1; };
  }, [token]);

  const pump = useCallback((mine: number) => {
    while (sizeRunning.current < SIZE_WORKERS && sizeQueue.current.length > 0) {
      const path = sizeQueue.current.shift() as string;
      // Asked only once it starts, so a path dropped from the queue by a filter change is wanted again later.
      sizeAsked.current.add(path);
      sizeRunning.current += 1;
      void getWorktreeSize(path)
        .catch(() => null)
        .then((bytes) => {
          if (generation.current !== mine) return;
          setSizes((current) => new Map(current).set(path, bytes));
        })
        .finally(() => {
          if (generation.current !== mine) return;
          sizeRunning.current -= 1;
          pump(mine);
        });
    }
  }, []);

  /** Sizes of these, soonest first, replacing what was waiting. Each is read once, once it has started. */
  const wantSizes = useCallback((paths: string[]) => {
    sizeQueue.current = paths.filter((path) => !sizeAsked.current.has(path));
    pump(generation.current);
  }, [pump]);

  return { details, failed, prs, sizes, wantSizes };
}

function Chipped({ view, onError }: { view: WorktreeView; onError: (message: string) => void }) {
  const open = (url: string) => void openPr(url).catch((err: unknown) => onError(errMsg(err, 'Couldn’t open the pull request.')));
  const prInChip = view.pr?.state === 'open' && view.chip.label.startsWith('Open PR');
  return (
    <span className="ev-wt-chips">
      {prInChip && view.pr
        ? <button type="button" className="ev-wt-chip ev-wt-chip-link" data-tone={view.chip.tone} title="Open the pull request on GitHub" onClick={() => open(view.pr?.url ?? '')}>{view.chip.label}</button>
        : <span className="ev-wt-chip" data-tone={view.chip.tone}>{view.chip.label}</span>}
      {view.note && <span className="ev-wt-chip" data-tone="warn">{view.note}</span>}
      {view.pr && !prInChip && (
        <button type="button" className="ev-wt-chip ev-wt-chip-link" data-tone="quiet" title={`PR #${view.pr.number} is ${view.pr.state}. Open it on GitHub`} onClick={() => open(view.pr?.url ?? '')}>#{view.pr.number}</button>
      )}
    </span>
  );
}

/** A checkbox in the rows' left column. `mixed` draws the dash a repo's box shows when only some of it is picked. */
export function Pick({ checked, mixed = false, disabled = false, label, onChange }: {
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input ref={ref} type="checkbox" className="ev-machine-check" checked={checked} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.target.checked)} />;
}

/** The rows, with what the closer look, GitHub and `du` have said so far, and which still wait for it. */
export function useWorktreeViews(worktrees: MachineWorktree[], token: number) {
  const { details, failed, prs, sizes, wantSizes } = useWorktreeInfo(worktrees, token);
  const views = useMemo(
    () => worktrees.map((row) => viewWorktree(row, details.get(row.path), prs.get(row.repo), sizes.get(row.path), failed.has(row.path))),
    [worktrees, details, prs, sizes, failed],
  );
  const checking = views.filter((view) => !view.settled && !failed.has(view.path)).length;
  return { views, checking, wantSizes };
}

/**
 * Every worktree agent sessions left, by repo. Each row is one line of name
 * and state over one line of small print, with its size in a column of its
 * own so nothing shifts as sizes arrive. Removable rows have a box; a repo's
 * box picks all of its removable ones. Removing goes through the page's
 * selection bar.
 */
export function WorktreeManager({ views, checking, wantSizes, home, selected, busy, onSelect, onError }: {
  views: WorktreeView[];
  checking: number;
  wantSizes: (paths: string[]) => void;
  home: string | null;
  selected: Set<string>;
  busy: boolean;
  onSelect: (paths: string[], on: boolean) => void;
  onError: (message: string) => void;
}) {
  const [filter, setFilter] = useState<WorktreeFilter>('all');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [views]);

  const counts = filterCounts(views);
  const shown = useMemo(() => views.filter((view) => matchesFilter(view, filter)), [views, filter]);
  const groups = useMemo(() => groupByRepo(shown), [shown]);

  // Sizes for what's on screen, once its closer look is in.
  const wanted = shown.filter((view) => view.detailed && view.exists && view.size === undefined).map((view) => view.path);
  const wantedKey = wanted.join('\n');
  useEffect(() => { if (wantedKey) wantSizes(wantedKey.split('\n')); }, [wantedKey, wantSizes]);

  const act = (run: Promise<void>, fallback: string) => void run.catch((err: unknown) => onError(errMsg(err, fallback)));

  return (
    <Card title="Worktrees">
      {views.length === 0 ? <p className="ev-set-hint">None. Worktrees show up here when a repo in ~/Developer has one.</p> : (
        <>
          <div className="ev-wt-toolbar ev-wt-filters" role="group" aria-label="Show">
            <Chip selected={filter === 'all'} count={counts.all} onClick={() => setFilter('all')}>All</Chip>
            <Chip selected={filter === 'removable'} count={counts.removable} onClick={() => setFilter('removable')}>Can go</Chip>
            <Chip selected={filter === 'attention'} count={counts.attention} onClick={() => setFilter('attention')}>Needs a look</Chip>
          </div>

          {groups.length === 0 && <p className="ev-set-hint">{filter === 'removable' ? (checking > 0 ? 'Nothing yet. Still checking.' : 'None. A worktree can go once its branch is merged, it has no changes or local files, and no session is using it.') : 'Nothing needs a look.'}</p>}
          {groups.map((group) => {
            const removable = group.views.filter((view) => view.removable).map((view) => view.path);
            const picked = removable.filter((path) => selected.has(path)).length;
            return (
              <section key={group.repo} className="ev-wt-group" aria-label={group.name}>
                <header className="ev-wt-row ev-wt-head">
                  <span className="ev-wt-pick">
                    {removable.length > 0 && (
                      <Pick
                        checked={picked > 0 && picked === removable.length}
                        mixed={picked > 0 && picked < removable.length}
                        disabled={busy}
                        label={`Select the ${removable.length} that can go in ${group.name}`}
                        onChange={(on) => onSelect(removable, on)}
                      />
                    )}
                  </span>
                  <h4 className="ev-wt-repo" title={shortPath(group.repo, home)}>{group.name}</h4>
                  <span className="ev-wt-count">{removable.length > 0 ? `${removable.length} of ${group.views.length} can go` : group.views.length}</span>
                </header>
                <ul className="ev-wt-list">
                  {group.views.map((view) => (
                    <li key={view.path} className="ev-wt-row" data-picked={selected.has(view.path) || undefined}>
                      <span className="ev-wt-pick">
                        {view.removable && <Pick checked={selected.has(view.path)} disabled={busy} label={`Remove ${view.branch ?? folderName(view.path)}`} onChange={(on) => onSelect([view.path], on)} />}
                      </span>
                      <div className="ev-wt-main" title={shortPath(view.path, home)}>
                        <div className="ev-wt-line">
                          <span className="ev-set-label ev-wt-branch">{view.branch ?? 'detached'}</span>
                          <Chipped view={view} onError={onError} />
                        </div>
                        <div className="ev-set-hint ev-wt-facts">{factsLine(view, now)}</div>
                      </div>
                      <span className="ev-wt-size" aria-label={typeof view.size === 'number' ? `Size ${formatSize(view.size)}` : undefined}>
                        {typeof view.size === 'number' ? formatSize(view.size) : view.exists && view.size === undefined ? <span className="ev-wt-skel" aria-hidden /> : null}
                      </span>
                      <div className="ev-wt-actions">
                        {view.exists && (
                          <>
                            <IconButton size={24} icon={FolderOpen} label="Show in Finder" onClick={() => act(openWorktree(view.path, 'reveal'), 'Couldn’t show it in Finder.')} />
                            <IconButton size={24} icon={SquareTerminal} label="Open in Terminal" onClick={() => act(openWorktree(view.path, 'terminal'), 'Couldn’t open Terminal.')} />
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </Card>
  );
}
