'use client';

import { FolderOpen, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getRepoPrs, getWorktreeDetails, getWorktreeSize, openPr, openWorktree,
  type MachineWorktree, type RepoPr, type WorktreeDetail,
} from '@/lib/desktop/bridge';
import { errMsg } from '@/lib/desktop/errors';
import { Button, Card, Chip, IconButton } from './ui';
import {
  factsLine, filterCounts, groupByRepo, matchesFilter, removeMergedLabel, viewWorktree,
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

  /** Sizes of these, soonest first, replacing what was waiting. Each is read once. */
  const wantSizes = useCallback((paths: string[]) => {
    sizeQueue.current = paths.filter((path) => !sizeAsked.current.has(path));
    for (const path of sizeQueue.current) sizeAsked.current.add(path);
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

/**
 * Every worktree agent sessions left, by repo: what state it's in, when it was
 * last touched, how big it is, and a way to look at it. The list is on screen
 * after the quick pass; activity, size and pull requests fill in as they
 * arrive. Removing goes through the page's confirm card.
 */
export function WorktreeManager({ worktrees, token, home, selected, busy, onSelect, onRemove, onError }: {
  worktrees: MachineWorktree[];
  token: number;
  home: string | null;
  selected: Set<string>;
  busy: boolean;
  onSelect: (path: string, on: boolean) => void;
  /** Asks to remove these; the confirm card names them. */
  onRemove: (paths: string[]) => void;
  onError: (message: string) => void;
}) {
  const { details, failed, prs, sizes, wantSizes } = useWorktreeInfo(worktrees, token);
  const [filter, setFilter] = useState<WorktreeFilter>('all');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [details]);

  const views = useMemo(
    () => worktrees.map((row) => viewWorktree(row, details.get(row.path), prs.get(row.repo), sizes.get(row.path), failed.has(row.path))),
    [worktrees, details, prs, sizes, failed],
  );
  const counts = filterCounts(views);
  const shown = useMemo(() => views.filter((view) => matchesFilter(view, filter)), [views, filter]);
  const groups = useMemo(() => groupByRepo(shown), [shown]);
  const checking = views.filter((view) => !view.settled && !failed.has(view.path)).length;

  // Sizes for what's on screen, once its closer look is in.
  const wanted = shown.filter((view) => view.detailed && view.exists && view.size === undefined).map((view) => view.path);
  const wantedKey = wanted.join('\n');
  useEffect(() => { if (wantedKey) wantSizes(wantedKey.split('\n')); }, [wantedKey, wantSizes]);

  const act = (run: Promise<void>, fallback: string) => void run.catch((err: unknown) => onError(errMsg(err, fallback)));
  const removableAll = views.filter((view) => view.removable).map((view) => view.path);
  const picked = [...selected].filter((path) => views.some((view) => view.path === path && view.removable));

  const summary = [
    counts.removable > 0 ? `${counts.removable} can be removed` : null,
    counts.attention > 0 ? `${counts.attention} need a look` : null,
    `${counts.all} in total`,
  ].filter(Boolean).join(', ');

  return (
    <Card title="Worktrees">
      {worktrees.length === 0 ? <p className="ev-set-hint">None. Worktrees show up here when a repo in ~/Developer has one.</p> : (
        <>
          <div className="ev-wt-toolbar">
            <div className="ev-wt-filters" role="group" aria-label="Show">
              <Chip selected={filter === 'removable'} count={counts.removable} onClick={() => setFilter('removable')}>Removable</Chip>
              <Chip selected={filter === 'attention'} count={counts.attention} onClick={() => setFilter('attention')}>Needs attention</Chip>
              <Chip selected={filter === 'all'} count={counts.all} onClick={() => setFilter('all')}>All</Chip>
            </div>
            {picked.length > 0
              ? <Button variant="primary" size="sm" disabled={busy} onClick={() => onRemove(picked)}>{`Remove ${picked.length} selected…`}</Button>
              : removableAll.length > 0 && <Button variant="outline" size="sm" disabled={busy} onClick={() => onRemove(removableAll)}>{`${removeMergedLabel(removableAll.length)}…`}</Button>}
          </div>
          <p className="ev-set-hint ev-wt-summary" aria-live="polite">{checking > 0 ? `${summary}. Checking ${checking}…` : `${summary}.`}</p>

          {groups.length === 0 && <p className="ev-set-hint">{filter === 'removable' ? (checking > 0 ? 'Nothing yet. Still checking.' : 'None. A worktree shows up here once its branch is merged, it has no changes or local files, and no session is using it.') : 'Nothing needs a look.'}</p>}
          {groups.map((group) => {
            const removable = group.views.filter((view) => view.removable).map((view) => view.path);
            return (
              <section key={group.repo} className="ev-wt-group" aria-label={group.name}>
                <header className="ev-wt-head">
                  <h4 className="ev-wt-repo" title={group.repo}>{group.name}<span className="ev-wt-count">{group.views.length}</span></h4>
                  {removable.length > 0 && <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRemove(removable)}>{`${removeMergedLabel(removable.length)}…`}</Button>}
                </header>
                <ul className="ev-wt-list">
                  {group.views.map((view) => (
                    <li key={view.path} className="ev-wt-row" data-removable={view.removable || undefined}>
                      <span className="ev-wt-pick">
                        {view.removable && <input type="checkbox" className="ev-machine-check" checked={selected.has(view.path)} aria-label={`Remove ${view.path}`} onChange={(event) => onSelect(view.path, event.target.checked)} />}
                      </span>
                      <div className="ev-wt-main">
                        <div className="ev-wt-line">
                          <span className="ev-set-label ev-wt-branch">{view.branch ?? 'detached'}</span>
                          <Chipped view={view} onError={onError} />
                        </div>
                        <div className="ev-set-hint ev-wt-facts">
                          {factsLine(view, now, home)}
                          {view.exists && !view.detailed && !view.settled && <span className="ev-wt-skel" aria-hidden />}
                          {view.exists && view.detailed && view.size === undefined && <span className="ev-wt-skel ev-wt-skel-short" aria-hidden />}
                        </div>
                      </div>
                      {view.exists && (
                        <div className="ev-wt-actions">
                          <IconButton size={24} icon={FolderOpen} label="Show in Finder" onClick={() => act(openWorktree(view.path, 'reveal'), 'Couldn’t show it in Finder.')} />
                          <IconButton size={24} icon={SquareTerminal} label="Open in Terminal" onClick={() => act(openWorktree(view.path, 'terminal'), 'Couldn’t open Terminal.')} />
                        </div>
                      )}
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
