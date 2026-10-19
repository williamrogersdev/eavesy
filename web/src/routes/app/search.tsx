import { createFileRoute } from '@tanstack/react-router';
import { Link } from '@/components/ui/app-link';
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { AppAlert, AppEmptyState, AppPage, AppPageHeader } from '@/components/ui/app-page';
import { isRecord } from '@/lib/json';

export const Route = createFileRoute('/app/search')({
  component: SearchPage,
});

function SearchPage() {
  const [q, setQ] = useState(() =>
    typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('q') ?? '') : '',
  );
  const [items, setItems] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const runQuery = useCallback(async (query: string) => {
    const normalized = query.trim();
    if (!normalized) {
      setItems([]);
      setHasSearched(false);
      return;
    }
    setLoading(true);
    setHasSearched(true);
    setError(null);
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(normalized)}`);
      if (!r.ok) throw new Error(`Search failed (${r.status})`);
      setItems(parseSearchItems(await r.json()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('q');
    if (!initial) return;
    const t = window.setTimeout(() => {
      void runQuery(initial);
    }, 0);
    return () => window.clearTimeout(t);
  }, [runQuery]);

  const run = (e: React.FormEvent) => {
    e.preventDefault();
    void runQuery(q);
  };

  return (
    <AppPage width="compact">
      <AppPageHeader
        title="Search"
        description="Search by meaning across your transcripts and dictations."
      />

      <form onSubmit={run} role="search" className="relative">
        <label htmlFor="semantic-search" className="sr-only">Search recordings and dictations</label>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ev-ink-2" />
        <input
          id="semantic-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="What did Sarah say about the launch in May?"
          autoFocus
          className="h-10 w-full rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper pl-9 pr-9 text-sm outline-none focus:border-ev-slate focus:shadow-[var(--ev-focus)]"
        />
        {loading ? (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-ev-ink-2" />
        ) : null}
      </form>

      {error ? <AppAlert>{error}</AppAlert> : null}

      {!loading && hasSearched && !error && items.length === 0 ? (
        <AppEmptyState
          icon={<Search />}
          title="No matching context"
          description="Try a broader topic, a person's name, or a phrase that describes the decision you remember."
        />
      ) : null}

      <ul aria-live="polite" className="flex flex-col divide-y divide-ev-line">
        {items.map((item, i) => (
          <li key={item.kind === 'meeting' ? item.meeting.id : `dictation-${i}`}>
            {item.kind === 'meeting' ? (
              <Link
                href={`/app/meetings/${item.meeting.id}`}
                className="-mx-2 block rounded-[var(--ev-r-ctl)] px-2 py-3 transition hover:bg-[var(--ev-hover)]"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium">{item.meeting.title}</span>
                  <span className="shrink-0 text-xs text-ev-ink-2">
                    {new Date(item.meeting.startedAt).toLocaleDateString()}
                  </span>
                </div>
                {item.excerpt ? (
                  <p className="mt-1 line-clamp-2 text-sm text-ev-ink-2">{item.excerpt}</p>
                ) : null}
              </Link>
            ) : (
              <div className="py-3">
                <div className="text-xs text-ev-ink-2">Dictation</div>
                <p className="mt-1 line-clamp-3 text-sm">{item.excerpt}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </AppPage>
  );
}

interface SearchMeeting {
  kind: 'meeting';
  excerpt?: string;
  meeting: { id: string; title: string; startedAt: number };
}

interface SearchDictation {
  kind: 'dictation';
  excerpt?: string;
}

type SearchItem = SearchMeeting | SearchDictation;

function parseSearchItems(value: unknown): SearchItem[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  return value.items.flatMap((item): SearchItem[] => {
    if (!isRecord(item)) return [];
    const excerpt = typeof item.excerpt === 'string' ? item.excerpt : undefined;
    if (item.kind === 'dictation') return [{ kind: 'dictation', excerpt }];
    if (item.kind !== 'meeting' || !isRecord(item.meeting)) return [];
    const meeting = item.meeting;
    if (
      typeof meeting.id !== 'string' ||
      typeof meeting.title !== 'string' ||
      typeof meeting.startedAt !== 'number'
    ) {
      return [];
    }
    return [{
      kind: 'meeting',
      excerpt,
      meeting: { id: meeting.id, title: meeting.title, startedAt: meeting.startedAt },
    }];
  });
}
