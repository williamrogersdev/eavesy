'use client';

import { RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cleanMachine, getMachineInventory, type MachineInventory, type MachineOutcome } from '@/lib/desktop/bridge';
import { errMsg } from '@/lib/desktop/errors';
import { Button, Card, Row } from './ui';
import { cleanLabel, groupLeftovers, homeOf, keptSummary, shortPath, stopWhat } from './machine-model';

const OWNER_LABEL = { leftover: 'Left over', session: 'Running session', other: '' } as const;

function Check({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return <input type="checkbox" className="ev-machine-check" checked={checked} aria-label={label} onChange={(event) => onChange(event.target.checked)} />;
}

/**
 * What agent sessions left on this Mac: worktrees whose work has landed,
 * processes whose session ended, and the ports your processes hold. It only
 * reads until you confirm; the confirm lists exactly what goes.
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setInventory(await getMachineInventory());
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

  const home = inventory ? homeOf(inventory) : null;
  const stale = useMemo(() => inventory?.worktrees.filter((w) => w.status === 'stale') ?? [], [inventory]);
  const kept = useMemo(() => keptSummary(inventory?.worktrees.map((w) => w.status) ?? []), [inventory]);
  const leftoverGroups = useMemo(() => groupLeftovers(inventory?.leftovers ?? []), [inventory]);
  const chosenProcesses = leftoverGroups.filter((group) => groups.has(group.key)).flatMap((group) => group.processes);
  const chosenWorktrees = stale.filter((w) => worktrees.has(w.path));
  const processCount = leftoverGroups.filter((group) => groups.has(group.key)).reduce((sum, group) => sum + group.total, 0);
  const nothingChosen = chosenWorktrees.length === 0 && chosenProcesses.length === 0;

  const toggle = (set: Set<string>, key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key); else next.delete(key);
    return next;
  };

  const clean = async () => {
    setCleaning(true);
    setError(null);
    try {
      const results = await cleanMachine(chosenWorktrees.map((w) => w.path), chosenProcesses.map(({ pid, started_us }) => ({ pid, started_us })));
      setOutcomes(results);
      await load();
    } catch (err) {
      setError(errMsg(err, 'Couldn’t clean up.'));
    } finally {
      setCleaning(false);
    }
  };

  const failed = outcomes?.filter((outcome) => !outcome.ok) ?? [];
  const restores = outcomes?.flatMap((outcome) => outcome.restore ? [outcome.restore] : []) ?? [];

  return (
    <>
      <div className="ev-machine-bar">
        <p className="ev-set-hint">
          {loading ? 'Looking at worktrees and processes…' : inventory ? `Looked in ${inventory.repos.length} repos in ~/Developer and your running Claude Code sessions.` : 'Nothing here changes until you confirm.'}
        </p>
        <Button variant="outline" size="sm" icon={RefreshCw} loading={loading} onClick={() => void load()}>Refresh</Button>
      </div>
      {error && <p role="alert" className="ev-set-hint mt-2 text-[var(--ev-warn-ink)]">{error}</p>}
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
          <Card title="Worktrees you can remove">
            {stale.length === 0
              ? <p className="ev-set-hint">None. A worktree shows up here once its branch is merged, it has no changes, and no session is using it.</p>
              : stale.map((w) => (
                <Row key={w.path} label={shortPath(w.path, home)} hint={w.branch ? `${w.branch}, merged` : 'merged'}>
                  <Check checked={worktrees.has(w.path)} label={`Remove ${w.path}`} onChange={(on) => setWorktrees((set) => toggle(set, w.path, on))} />
                </Row>
              ))}
            {stale.length > 1 && (
              <div className="ev-set-body">
                <Button variant="ghost" size="sm" onClick={() => setWorktrees(worktrees.size === stale.length ? new Set() : new Set(stale.map((w) => w.path)))}>
                  {worktrees.size === stale.length ? 'Select none' : `Select all ${stale.length}`}
                </Button>
              </div>
            )}
            {kept && <p className="ev-set-hint">Kept: {kept}.</p>}
          </Card>

          <Card title="Left over from ended sessions">
            {leftoverGroups.length === 0
              ? <p className="ev-set-hint">None. Processes show up here when the Claude Code session that started them has ended.</p>
              : leftoverGroups.map((group) => {
                const cwd = group.processes.length === 1 ? shortPath(group.processes[0]?.cwd ?? null, home) : null;
                const hint = [
                  group.total > 1 ? `${group.total} processes` : `pid ${group.processes[0]?.pid}`,
                  group.ports.length ? `port ${group.ports.join(', ')}` : null,
                  cwd || null,
                ].filter(Boolean).join(' · ');
                return (
                  <Row key={group.key} label={group.name} hint={hint}>
                    <Check checked={groups.has(group.key)} label={`Stop ${group.name}`} onChange={(on) => setGroups((set) => toggle(set, group.key, on))} />
                  </Row>
                );
              })}
            {inventory.zombies.length > 0 && <p className="ev-set-hint">{inventory.zombies.length} finished processes are waiting for their parent to collect them. They use no memory and can’t be stopped.</p>}
          </Card>

          <Card title="Listening ports">
            {inventory.ports.length === 0
              ? <p className="ev-set-hint">None of your processes are listening.</p>
              : inventory.ports.map((port) => (
                <Row key={`${port.port}-${port.pid}`} label={`${port.port}  ${port.name}`} hint={[OWNER_LABEL[port.owner], shortPath(port.cwd, home)].filter(Boolean).join(' · ') || undefined} />
              ))}
          </Card>

          <div className="ev-machine-confirm">
            {confirming ? (
              <div role="dialog" aria-label="Confirm clean up" className="ev-machine-card">
                <p className="ev-set-label">This will:</p>
                <ul className="ev-machine-list">
                  {chosenWorktrees.map((w) => <li key={w.path}>Remove the worktree {shortPath(w.path, home)} with <code>git worktree remove</code>. Its branch stays.</li>)}
                  {leftoverGroups.filter((group) => groups.has(group.key)).map((group) => (
                    <li key={group.key}>Ask {stopWhat(group)} to stop.</li>
                  ))}
                </ul>
                <p className="ev-set-hint">Each one is checked again first, and anything that changed is skipped. Git refuses a worktree with changes.</p>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
                  <Button variant="primary" size="sm" icon={Trash2} loading={cleaning} onClick={() => void clean()}>{cleanLabel(chosenWorktrees.length, processCount)}</Button>
                </div>
              </div>
            ) : (
              <Button variant="outline" size="sm" disabled={nothingChosen} onClick={() => { setOutcomes(null); setConfirming(true); }}>Clean up…</Button>
            )}
          </div>
        </>
      )}
    </>
  );
}
