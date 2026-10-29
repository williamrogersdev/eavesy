import { useCallback, useEffect, useRef, useState } from 'react';
import { listAgentFeedback, dismissAgentFeedback } from '@/lib/api/agent-feedback';
import type { AgentFeedback } from '@/lib/agent-feedback';
import { errMsg } from '@/lib/desktop/bridge';

/**
 * What agents reported over MCP that the user hasn't applied or dismissed,
 * loaded while `enabled`. `drop` takes reports off the list once handled.
 */
export function useAgentFeedback(enabled: boolean) {
  const [items, setItems] = useState<AgentFeedback[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // Best effort: without it, Settings simply shows no reports.
    void listAgentFeedback()
      .then((list) => { if (live) { setItems(list); setError(null); } })
      .catch(() => undefined);
    return () => { live = false; };
  }, [enabled, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const drop = useCallback((ids: readonly string[]) => {
    const gone = new Set(ids);
    setItems((list) => list.filter((item) => !gone.has(item.id)));
  }, []);

  const dismiss = useCallback(async (ids: string[]) => {
    setError(null);
    const removed = items.filter((item) => ids.includes(item.id));
    drop(ids);
    try { await dismissAgentFeedback(ids); }
    catch (e) {
      if (!mounted.current) return;
      setItems((list) => [...removed, ...list.filter((item) => !ids.includes(item.id))].sort((a, b) => b.createdAt - a.createdAt));
      setError(errMsg(e, 'Couldn’t dismiss that.'));
    }
  }, [items, drop]);

  return { items, error, setError, dismiss, drop, reload };
}

export type AgentFeedbackState = ReturnType<typeof useAgentFeedback>;
