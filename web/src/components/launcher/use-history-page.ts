import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelHistorySearch, loadRecordingPage, reloadRecordingPages, type RecordingPage } from '@/lib/launcher/data';
import { errMsg } from '@/lib/desktop/errors';
import { reuseRows, type HistoryFilter } from './history-model';

/** Many native events can land at once (a sync, a cloud refine): they share one reload. */
export const REFRESH_DEBOUNCE_MS = 250;
/** Typing in search waits a beat before asking the native history. */
export const SEARCH_DEBOUNCE_MS = 150;

/** Why the history is reloading, which decides how long it waits first. */
export type ReloadCause = 'initial' | 'selection' | 'refresh' | 'wake';

export function reloadDelay(cause: ReloadCause, query: string): number {
  if (cause === 'refresh') return REFRESH_DEBOUNCE_MS;
  if (cause === 'selection') return query.trim() ? SEARCH_DEBOUNCE_MS : 0;
  return 0;
}

/** A reloaded page, keeping the previous row objects (and the page itself) where nothing changed. */
export function mergePage(previous: RecordingPage | null, next: RecordingPage): RecordingPage {
  if (!previous) return next;
  const items = reuseRows(previous.items, next.items);
  const counts = previous.counts;
  const sameCounts = (Object.keys(next.counts) as (keyof RecordingPage['counts'])[]).every((key) => counts[key] === next.counts[key]);
  if (items === previous.items && sameCounts && previous.nextOffset === next.nextOffset) return previous;
  return { ...next, items, counts: sameCounts ? previous.counts : next.counts };
}

/** Appends a further page, skipping rows already shown. */
export function appendPage(previous: RecordingPage | null, next: RecordingPage): RecordingPage {
  const rows = previous?.items ?? [];
  const known = new Set(rows.map((row) => row.id));
  return { ...next, items: [...rows, ...next.items.filter((row) => !known.has(row.id))] };
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * Server-side search covers the entire history, including unloaded pages.
 * `refresh` bumps on every native "recordings changed" event; those reloads are
 * debounced and wait while the panel is hidden. `openKey` bumps each time the
 * panel opens, which catches up on anything skipped meanwhile.
 */
export function useHistoryPage(refresh: number, query: string, filter: HistoryFilter, openKey: unknown = null) {
  const [searchClient] = useState(() => crypto.randomUUID());
  const [page, setPage] = useState<RecordingPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped to reload now: Try again, or catching up after the panel was hidden.
  const [wake, setWake] = useState(0);
  const inFlight = useRef(false);
  const hasPage = useRef(false);
  const generation = useRef(0);
  const loadedPages = useRef(1);
  const selection = useRef({ query, filter });
  const seen = useRef<{ refresh: number; wake: number } | null>(null);
  // A refresh arrived while hidden and was skipped.
  const stale = useRef(false);

  useEffect(() => {
    const changed = selection.current.query !== query || selection.current.filter !== filter;
    const previous = seen.current;
    seen.current = { refresh, wake };
    const cause: ReloadCause = previous === null ? 'initial'
      : changed ? 'selection'
        : wake !== previous.wake ? 'wake'
          : 'refresh';
    if (cause === 'refresh' && hidden()) {
      // Nobody can see it: reload once the panel is back instead. Whatever was in
      // flight was just cancelled, so its result (or its cancellation) is ignored.
      generation.current++;
      stale.current = true;
      inFlight.current = false;
      setLoading(false);
      setBusy(false);
      return;
    }
    stale.current = false;
    const request = ++generation.current;
    if (changed) {
      selection.current = { query, filter };
      loadedPages.current = 1;
    }
    const pages = loadedPages.current;
    let disposed = false;
    setLoading(!hasPage.current || changed);
    setBusy(true);
    inFlight.current = true;
    const timer = window.setTimeout(() => {
      void reloadRecordingPages(pages, query, filter, { client: searchClient, generation: request }).then((next) => {
        if (disposed || generation.current !== request) return;
        hasPage.current = true;
        // A new search shows its own rows; a refresh keeps the rows that didn't change.
        setPage((current) => (changed ? next : mergePage(current, next)));
        setError(null);
      }).catch((reason: unknown) => {
        if (!disposed && generation.current === request) setError(errMsg(reason, 'Couldn’t load captures'));
      }).finally(() => {
        if (!disposed && generation.current === request) { setLoading(false); setBusy(false); inFlight.current = false; }
      });
    }, reloadDelay(cause, query));
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      void cancelHistorySearch({ client: searchClient, generation: request }).catch(() => undefined);
    };
  }, [refresh, query, filter, searchClient, wake]);

  // Catch up on refreshes skipped while hidden: when the page shows again, or the panel opens.
  useEffect(() => {
    const onVisible = () => { if (!hidden() && stale.current) setWake((n) => n + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  useEffect(() => {
    if (stale.current) setWake((n) => n + 1);
  }, [openKey]);

  const retry = useCallback(() => setWake((n) => n + 1), []);

  const loadMore = useCallback(async () => {
    if (!page || page.nextOffset === null || busy || inFlight.current) return;
    const request = generation.current;
    const asked = selection.current;
    setLoading(true);
    setBusy(true);
    inFlight.current = true;
    // Counted now, so a refresh that lands meanwhile reloads this page too.
    loadedPages.current += 1;
    try {
      const next = await loadRecordingPage(page.nextOffset, query, filter, { client: searchClient, generation: request });
      // Another search replaced this one: its rows don't belong here.
      if (selection.current !== asked) return;
      // Only a refresh overtook it: show the rows now, the refresh brings them up to date.
      setPage((previous) => appendPage(previous, next));
      setError(null);
    } catch (reason) {
      // A real failure takes the page back; one cancelled by a refresh is reloaded by that refresh.
      if (request === generation.current) {
        loadedPages.current = Math.max(1, loadedPages.current - 1);
        setError(errMsg(reason, 'Couldn’t load captures'));
      }
    } finally {
      if (request === generation.current) { setLoading(false); setBusy(false); inFlight.current = false; }
    }
  }, [page, query, filter, busy, searchClient]);
  return { page, error, loading, busy, loadMore, retry };
}
