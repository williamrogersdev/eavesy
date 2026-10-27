'use client';

import { RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cleanMachine, getMachineInventory, type MachineInventory, type MachineOutcome } from '@/lib/desktop/bridge';
import { errMsg } from '@/lib/desktop/errors';
import { Button, Card, IconButton } from './ui';
import { cleanLabel, folderName, groupLeftovers, homeOf, overview, selectionLabel, shortPath, stopWhat } from './machine-model';
import { Pick, WorktreeManager, useWorktreeViews } from './worktree-manager';

const OWNER = {
  leftover: { label: 'Left over', tone: 'warn' },
  session: { label: 'Running session', tone: 'busy' },
  other: null,
} as const;

/**
 * What agent sessions left on this Mac: worktrees (merged ones can go),
 * processes whose session ended, and the ports your processes hold. The top
 * says what can go and cleans it up in one go; the lists below are for
 * picking. It only reads until you confirm, and the confirm lists exactly
 * what goes.
 */
export function MachineSettings({ active }: { active: boolean }) {
  const [inventory, setInventory] = useState<MachineInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<Set<string>>(new Set());
  const [groups, setGroups] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [outcomes, setOutcomes] = useState<MachineOutcome[] | null>(null);
  /** Changes on every full look, so the worktree list starts its closer look over. */
  const [token, setToken] = useState(0);
  const confirmRef = useRef<HTMLDivElement>(null);
  const goRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setInventory(await getMachineInventory());
      setToken((current) => current + 1);
      setWorktrees(new Set());
      setGroups(new Set());
      setConfirming(false);
    } catch (err) {
      setError(errMsg(err, 'Couldn’t look at this Mac.'));
    } finally {
      setLoading(false);
    }
  }, []);
  // Look once, the first time the section is opened; after that only on Refresh.
  useEffect(() => { if (active && !inventory && !loading && !error) void load(); }, [active, inventory, loading, error, load]);

  const { views, checking, wantSizes } = useWorktreeViews(inventory?.worktrees ?? EMPTY, token);
  const home = inventory ? homeOf(inventory) : null;
  const leftoverGroups = useMemo(() => groupLeftovers(inventory?.leftovers ?? []), [inventory]);
  const removable = views.filter((view) => view.removable);
  const chosenWorktrees = views.filter((view) => view.removable && worktrees.has(view.path));
  const chosenGroups = leftoverGroups.filter((group) => groups.has(group.key));
  const chosenProcesses = chosenGroups.flatMap((group) => group.processes);
  const processCount = chosenGroups.reduce((sum, group) => sum + group.total, 0);
  const anyChosen = chosenWorktrees.length > 0 || chosenProcesses.length > 0;
  const leftoverTotal = leftoverGroups.reduce((sum, group) => sum + group.total, 0);
  const summary = overview({
    removable: removable.length,
    processes: leftoverTotal,
    checking,
    bytes: removable.reduce((sum, view) => sum + (typeof view.size === 'number' ? view.size : 0), 0),
    measuring: removable.some((view) => view.exists && view.size === undefined),
    worktrees: views.length,
  });

  const toggle = (set: Set<string>, keys: string[], on: boolean) => {
    const next = new Set(set);
    for (const key of keys) if (on) next.add(key); else next.delete(key);
    return next;
  };

  /** Everything that can go, picked, with the confirm open. */
  const cleanUpAll = () => {
    setWorktrees(new Set(removable.map((view) => view.path)));
    setGroups(new Set(leftoverGroups.map((group) => group.key)));
    setOutcomes(null);
    setConfirming(true);
  };
  const clearChoice = () => {
    setWorktrees(new Set());
    setGroups(new Set());
    setConfirming(false);
  };
  // The confirm opens at the bottom of the pane; take focus to its button so the keyboard is there too.
  useEffect(() => {
    if (!confirming) return;
    confirmRef.current?.scrollIntoView({ block: 'nearest' });
    goRef.current?.focus();
  }, [confirming]);
  // Nothing left to confirm once the last pick is undone.
  useEffect(() => { if (!anyChosen) setConfirming(false); }, [anyChosen]);

  const clean = async () => {
    setCleaning(true);
    setError(null);
    try {
      const results = await cleanMachine(chosenWorktrees.map((w) => w.path), chosenProcesses.map(({ pid, started_us }) => ({ pid, started_us })));
      setOutcomes(results);
      // Take what went off the list instead of looking at the whole Mac again.
      const gone = new Set(results.filter((outcome) => outcome.ok).map((outcome) => outcome.target));
      setInventory((current) => current && {
        ...current,
        worktrees: current.worktrees.filter((w) => !gone.has(w.path)),
        leftovers: current.leftovers.filter((l) => !gone.has(String(l.pid))),
        ports: current.ports.filter((port) => !gone.has(String(port.pid))),
      });
      clearChoice();
    } catch (err) {
      setError(errMsg(err, 'Couldn’t clean up.'));
    } finally {
      setCleaning(false);
    }
  };

  const failed = outcomes?.filter((outcome) => !outcome.ok) ?? [];
  const restores = outcomes?.flatMap((outcome) => outcome.restore ? [outcome.restore] : []) ?? [];
  const pickedGroups = leftoverGroups.filter((group) => groups.has(group.key)).length;
  const somethingToClean = removable.length > 0 || leftoverGroups.length > 0;

  return (
    <div className="ev-mac">
      <section className="ev-mac-overview" aria-live="polite">
        <div className="ev-mac-summary">
          <h2 className="ev-mac-headline">{inventory ? summary.headline : loading ? 'Looking at this Mac…' : 'This Mac'}</h2>
          <p className="ev-set-hint">
            {inventory
              ? summary.detail || `Looked in ${inventory.repos.length} repos and your running Claude Code sessions.`
              : 'Worktrees and processes your agent sessions left behind. Nothing changes until you confirm.'}
          </p>
          {inventory && somethingToClean && (
            <p className="ev-set-hint ev-mac-ask"><Sparkles size={12} strokeWidth={1.75} aria-hidden /> You can also ask Eavesy to “clean up my Mac”.</p>
          )}
        </div>
        <div className="ev-mac-actions">
          <IconButton size={28} icon={RefreshCw} label={loading ? 'Looking…' : 'Look again'} disabled={loading || cleaning} onClick={() => void load()} />
          {inventory && somethingToClean && (
            <Button variant="primary" size="md" icon={Trash2} disabled={cleaning} onClick={cleanUpAll}>Clean up…</Button>
          )}
        </div>
      </section>

      {error && <p role="alert" className="ev-set-hint ev-mac-error">{error}</p>}
      {outcomes && (
        <div role="status" className="ev-machine-card">
          <p>{failed.length === 0 ? 'Done.' : `${outcomes.length - failed.length} done, ${failed.length} skipped.`}</p>
          {failed.map((outcome) => <p key={outcome.target} className="ev-set-hint">{shortPath(outcome.target, home)}: {outcome.message}</p>)}
          {restores.length > 0 && (
            <>
              <p className="ev-set-hint">Their branches are still in the repo. To bring one back, run its line in Terminal:</p>
              <ul className="ev-machine-list">{restores.map((line) => <li key={line}><code className="ev-machine-code">{line}</code></li>)}</ul>
            </>
          )}
        </div>
      )}

      {inventory && (
        <>
          <WorktreeManager
            views={views}
            checking={checking}
            wantSizes={wantSizes}
            home={home}
            selected={worktrees}
            busy={cleaning}
            onSelect={(paths, on) => setWorktrees((set) => toggle(set, paths, on))}
            onError={setError}
          />

          <Card title="Left over from ended sessions">
            {leftoverGroups.length === 0
              ? <p className="ev-set-hint">None. Processes show up here when the Claude Code session that started them has ended.</p>
              : (
                <ul className="ev-wt-list">
                  <li className="ev-wt-row ev-wt-head">
                    <span className="ev-wt-pick">
                      <Pick
                        checked={pickedGroups === leftoverGroups.length}
                        mixed={pickedGroups > 0 && pickedGroups < leftoverGroups.length}
                        disabled={cleaning}
                        label="Select every leftover process"
                        onChange={(on) => setGroups((set) => toggle(set, leftoverGroups.map((group) => group.key), on))}
                      />
                    </span>
                    <h4 className="ev-wt-repo">All</h4>
                    <span className="ev-wt-count">{leftoverTotal}</span>
                  </li>
                  {leftoverGroups.map((group) => {
                    const cwd = group.processes.length === 1 ? group.processes[0]?.cwd ?? null : null;
                    const facts = [
                      group.total > 1 ? `${group.total} processes` : `pid ${group.processes[0]?.pid}`,
                      group.ports.length ? `port ${group.ports.join(', ')}` : null,
                      cwd && cwd !== '/' ? folderName(cwd) : null,
                    ].filter(Boolean).join(' · ');
                    return (
                      <li key={group.key} className="ev-wt-row" data-picked={groups.has(group.key) || undefined}>
                        <span className="ev-wt-pick">
                          <Pick checked={groups.has(group.key)} disabled={cleaning} label={`Stop ${group.name}`} onChange={(on) => setGroups((set) => toggle(set, [group.key], on))} />
                        </span>
                        <div className="ev-wt-main" title={[group.exe, cwd ? shortPath(cwd, home) : null].filter(Boolean).join('\n')}>
                          <div className="ev-wt-line"><span className="ev-set-label ev-wt-branch">{group.name}</span></div>
                          <div className="ev-set-hint ev-wt-facts">{facts}</div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            {inventory.zombies.length > 0 && <p className="ev-set-hint">{inventory.zombies.length} finished processes are waiting for their parent to collect them. They use no memory and can’t be stopped.</p>}
          </Card>

          <Card title="Listening ports">
            {inventory.ports.length === 0
              ? <p className="ev-set-hint">None of your processes are listening.</p>
              : (
                <ul className="ev-wt-list">
                  {inventory.ports.map((port) => {
                    const owner = OWNER[port.owner];
                    const where = port.cwd && port.cwd !== '/' ? folderName(port.cwd) : null;
                    return (
                      <li key={`${port.port}-${port.pid}`} className="ev-wt-row ev-port-row">
                        <span className="ev-port-num">{port.port}</span>
                        <div className="ev-wt-main" title={port.cwd ? shortPath(port.cwd, home) : undefined}>
                          <div className="ev-wt-line">
                            <span className="ev-set-label ev-wt-branch">{port.name}</span>
                            {owner && <span className="ev-wt-chip" data-tone={owner.tone}>{owner.label}</span>}
                          </div>
                          {where && <div className="ev-set-hint ev-wt-facts">{where}</div>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
          </Card>
        </>
      )}

      {inventory && anyChosen && (
        <div ref={confirmRef} className="ev-mac-bar" role="region" aria-label={confirming ? 'Confirm clean up' : 'Selection'}>
          {confirming && (
            <div className="ev-mac-confirm">
              <p className="ev-set-label">This will:</p>
              <ul className="ev-machine-list">
                {chosenWorktrees.map((w) => <li key={w.path}>Remove the worktree {shortPath(w.path, home)} with <code>git worktree remove</code>. Its branch stays.</li>)}
                {chosenGroups.map((group) => <li key={group.key}>Ask {stopWhat(group)} to stop.</li>)}
              </ul>
              <p className="ev-set-hint">Each one is checked again first, and anything that changed is skipped. Build output like node_modules goes with a worktree; one with changes or local files such as .env is never offered.</p>
            </div>
          )}
          <div className="ev-mac-bar-row">
            <span className="ev-set-label ev-mac-bar-label">{confirming ? 'Go ahead?' : selectionLabel(chosenWorktrees.length, processCount)}</span>
            <div className="ev-mac-bar-actions">
              <Button variant="ghost" size="sm" disabled={cleaning} onClick={confirming ? () => setConfirming(false) : clearChoice}>{confirming ? 'Back' : 'Clear'}</Button>
              {confirming
                ? <Button ref={goRef} variant="primary" size="sm" icon={Trash2} loading={cleaning} onClick={() => void clean()}>{cleanLabel(chosenWorktrees.length, processCount)}</Button>
                : <Button variant="primary" size="sm" onClick={() => { setOutcomes(null); setConfirming(true); }}>Clean up…</Button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const EMPTY: MachineInventory['worktrees'] = [];
