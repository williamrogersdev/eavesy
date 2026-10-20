import { useCallback, useEffect, useRef, useState } from 'react';
import { loadRecordingPage, reloadRecordingPages, type RecordingPage } from '@/lib/launcher/data';
import { errMsg } from '@/lib/desktop/errors';
import type { HistoryFilter } from './history-model';

/** Server-side search covers the entire history, including unloaded pages. */
export function useHistoryPage(refresh: number, query: string, filter: HistoryFilter) {
  const [page, setPage] = useState<RecordingPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const loadedPages = useRef(1);
  const selection = useRef({ query, filter });
  useEffect(() => {
    const request = ++generation.current;
    if (selection.current.query !== query || selection.current.filter !== filter) {
      selection.current = { query, filter };
      loadedPages.current = 1;
    }
    const pages = loadedPages.current;
    let disposed = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void reloadRecordingPages(pages, query, filter).then((next) => {
        if (!disposed && generation.current === request) { setPage(next); setError(null); }
      }).catch((reason: unknown) => {
        if (!disposed && generation.current === request) setError(errMsg(reason, 'Could not load captures'));
      }).finally(() => {
        if (!disposed && generation.current === request) setLoading(false);
      });
    }, query.trim() ? 150 : 0);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [refresh, query, filter]);

  const loadMore = useCallback(async () => {
    if (!page || page.nextOffset === null || loading) return;
    const request = generation.current;
    setLoading(true);
    try {
      const next = await loadRecordingPage(page.nextOffset, query, filter);
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
      if (request === generation.current) setLoading(false);
    }
  }, [page, query, filter, loading]);
  return { page, error, loading, loadMore };
}
