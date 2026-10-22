import { useCallback, useEffect, useRef, useState } from 'react';
import { createPrompt, deletePrompt, listPrompts, markPromptUsed, updatePrompt } from '@/lib/api/prompts';
import { errMsg } from '@/lib/desktop/bridge';
import type { SavedPrompt } from '@/lib/prompts';

/**
 * The account's saved prompts, loaded while `enabled` and again on each
 * `reloadKey` change (the panel bumps it when it opens, to pick up edits made
 * in Settings or on another Mac).
 */
export function useSavedPrompts(enabled: boolean, reloadKey: unknown = null) {
  const [prompts, setPrompts] = useState<SavedPrompt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!enabled) { setPrompts(null); return; }
    let live = true;
    void listPrompts()
      .then((items) => { if (live) { setPrompts(items); setError(null); } })
      .catch((e: unknown) => { if (live) setError(errMsg(e, 'Couldn’t load your prompts.')); });
    return () => { live = false; };
  }, [enabled, reloadKey]);

  const put = useCallback((prompt: SavedPrompt) => {
    if (!mounted.current) return;
    setPrompts((list) => {
      const rest = (list ?? []).filter((p) => p.id !== prompt.id);
      return [...rest, prompt].sort((a, b) => a.name.localeCompare(b.name));
    });
  }, []);

  const create = useCallback(async (fields: { name: string; body: string }) => {
    setError(null);
    try { const prompt = await createPrompt(fields); put(prompt); return prompt; }
    catch (e) { if (mounted.current) setError(errMsg(e, 'Couldn’t save the prompt.')); return null; }
  }, [put]);

  const update = useCallback(async (id: string, fields: { name?: string; body?: string }) => {
    setError(null);
    try { const prompt = await updatePrompt(id, fields); put(prompt); return prompt; }
    catch (e) { if (mounted.current) setError(errMsg(e, 'Couldn’t save the prompt.')); return null; }
  }, [put]);

  const remove = useCallback(async (id: string) => {
    setError(null);
    const before = prompts;
    setPrompts((list) => list?.filter((p) => p.id !== id) ?? list);
    try { await deletePrompt(id); }
    catch (e) { if (mounted.current) { setPrompts(before); setError(errMsg(e, 'Couldn’t delete the prompt.')); } }
  }, [prompts]);

  /** Counts a paste. Best effort: a missed count only changes the order. */
  const used = useCallback((id: string) => {
    void markPromptUsed(id).then(put, () => undefined);
  }, [put]);

  return { prompts, error, create, update, remove, used };
}

export type SavedPromptsState = ReturnType<typeof useSavedPrompts>;
