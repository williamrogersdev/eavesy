import { useCallback, useEffect, useRef, useState } from 'react';
import { createPrompt, deletePrompt, listPrompts, markPromptUsed, suggestPrompts, updatePrompt } from '@/lib/api/prompts';
import { errMsg } from '@/lib/desktop/bridge';
import type { PromptSuggestion } from '@/lib/prompt-starters';
import type { SavedPrompt } from '@/lib/prompts';

/**
 * The account's saved prompts, loaded while `enabled` and again on each
 * `reloadKey` change (the panel bumps it when it opens, to pick up edits made
 * in Settings or on another Mac).
 */
export function useSavedPrompts(enabled: boolean, reloadKey: unknown = null) {
  const [prompts, setPrompts] = useState<SavedPrompt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Try again.
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!enabled) { setPrompts(null); return; }
    let live = true;
    void listPrompts()
      .then((items) => { if (live) { setPrompts(items); setError(null); } })
      .catch((e: unknown) => { if (live) setError(errMsg(e, 'Couldn’t load your prompts.')); });
    return () => { live = false; };
  }, [enabled, reloadKey, attempt]);

  const reload = useCallback(() => { setError(null); setAttempt((n) => n + 1); }, []);

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
    const removed = prompts?.find((p) => p.id === id);
    setPrompts((list) => list?.filter((p) => p.id !== id) ?? list);
    try { await deletePrompt(id); }
    catch (e) {
      // Put back just this prompt, so changes that landed meanwhile stay.
      if (removed) put(removed);
      if (mounted.current) setError(errMsg(e, 'Couldn’t delete the prompt.'));
    }
  }, [prompts, put]);

  /** Counts a paste. Best effort: a missed count only changes the order. */
  const used = useCallback((id: string) => {
    void markPromptUsed(id).then(put, () => undefined);
  }, [put]);

  return { prompts, error, create, update, remove, used, reload };
}

export type SavedPromptsState = ReturnType<typeof useSavedPrompts>;

/**
 * Prompts suggested from the account's dictations, asked for once, the first
 * time `active` is true (the Prompts page is on screen), so opening Settings
 * never costs a model call by itself. `personal` is null until it answers, and
 * empty when there's nothing to suggest or it couldn't be reached.
 */
export function usePromptSuggestions(active: boolean) {
  const [personal, setPersonal] = useState<PromptSuggestion[] | null>(null);
  const asked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active || asked.current) return;
    asked.current = true;
    // Kept even if the page is left meanwhile: it's shown the next time.
    void suggestPrompts()
      .then((items) => { if (mounted.current) setPersonal(items); })
      .catch(() => { if (mounted.current) setPersonal([]); });
  }, [active]);
  return { personal, loading: active && personal === null };
}
