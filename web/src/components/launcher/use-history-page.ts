import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelHistorySearch, loadRecordingPage, reloadRecordingPages, type RecordingPage } from '@/lib/launcher/data';
import { errMsg } from '@/lib/desktop/errors';
import type { HistoryFilter } from './history-model';

/** Server-side search covers the entire history, including unloaded pages. */
export function useHistoryPage(refresh: number, query: string, filter: HistoryFilter) {
  const [searchClient] = useState(() => crypto.randomUUID());
  const [page, setPage] = useState<RecordingPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const hasPage = useRef(false);
  const generation = useRef(0);
  const loadedPages = useRef(1);
  const selection = useRef({ query, filter });
  useEffect(() => {
    const request = ++generation.current;
    const changed = selection.current.query !== query || selection.current.filter !== filter;
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
        if (!disposed && generation.current === request) { hasPage.current = true; setPage(next); setError(null); }
      }).catch((reason: unknown) => {
        if (!disposed && generation.current === request) setError(errMsg(reason, 'Could not load captures'));
      }).finally(() => {
        if (!disposed && generation.current === request) { setLoading(false); setBusy(false); inFlight.current = false; }
      });
    }, query.trim() ? 150 : 0);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      void cancelHistorySearch({ client: searchClient, generation: request }).catch(() => undefined);
    };
  }, [refresh, query, filter, searchClient]);

  const loadMore = useCallback(async () => {
    if (!page || page.nextOffset === null || busy || inFlight.current) return;
    const request = generation.current;
    setLoading(true);
    setBusy(true);
    inFlight.current = true;
    try {
      const next = await loadRecordingPage(page.nextOffset, query, filter, { client: searchClient, generation: request });
      if (request !== generation.current) return;
      loadedPages.current += 1;
      setPage((previous) => {
        const rows = previous?.items ?? [];
        const known = new Set(rows.map((row) => row.id));
        return { ...next, items: [...rows, ...next.items.filter((row) => !known.has(row.id))] };
      });
      setError(null);
    } catch (reason) {
      if (request === generation.current) setError(errMsg(reason, 'Could not load captures'));
    } finally {
      if (request === generation.current) { setLoading(false); setBusy(false); inFlight.current = false; }
    }
  }, [page, query, filter, busy, searchClient]);
  return { page, error, loading, busy, loadMore };
}
