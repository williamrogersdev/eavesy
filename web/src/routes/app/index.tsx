import { createFileRoute } from '@tanstack/react-router';
import { ChevronDown, Laptop, Mic, Search, Video, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Bubble, Button, Chip, Mascot, Menu } from '@/components/launcher/ui';
import { KindIcon, kindOf } from '@/components/library/kind';
import { Link } from '@/components/ui/app-link';
import { AppAlert, AppPage, appButton } from '@/components/ui/app-page';
import { type LibItem, type LibVariant, useLibraryItems } from '@/lib/api/use-library';
import { cn, formatDuration } from '@/lib/utils';

type Filter = 'all' | 'voice' | 'meeting' | 'screens';

const FILTERS: { value: Filter; label: string; match: (v: LibVariant) => boolean }[] = [
  { value: 'all', label: 'All', match: () => true },
  { value: 'voice', label: 'Voice notes', match: (v) => v === 'voice' || v === 'audio' },
  { value: 'meeting', label: 'Meetings', match: (v) => v === 'meeting' },
  { value: 'screens', label: 'Screens', match: (v) => v === 'screenshot' || v === 'screen' || v === 'video' || v === 'image' },
];

export const Route = createFileRoute('/app/')({
  validateSearch: (search: Record<string, unknown>): { filter?: Filter; device?: string } => ({
    ...(FILTERS.some((f) => f.value === search.filter && f.value !== 'all') ? { filter: search.filter as Filter } : {}),
    ...(typeof search.device === 'string' && search.device ? { device: search.device } : {}),
  }),
  component: LibraryPage,
});

function LibraryPage() {
  const { items, loading, error, hasOlder, loadingOlder, loadOlder } = useLibraryItems();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const filter: Filter = search.filter ?? 'all';
  const device = search.device;
  const [query, setQuery] = useState('');

  const setSearch = (next: { filter?: Filter; device?: string }) =>
    void navigate({
      search: {
        ...(next.filter && next.filter !== 'all' ? { filter: next.filter } : {}),
        ...(next.device ? { device: next.device } : {}),
      },
      replace: true,
    });

  const devices = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) if (item.device) counts.set(item.device, (counts.get(item.device) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  const normalized = query.trim().toLowerCase();
  const visible = items.filter(
    (item) =>
      FILTERS.find((f) => f.value === filter)!.match(item.variant) &&
      (!device || item.device === device) &&
      (!normalized ||
        item.title.toLowerCase().includes(normalized) ||
        item.subtitle?.toLowerCase().includes(normalized)),
  );
  const countFor = (f: (typeof FILTERS)[number]) =>
    items.filter((i) => f.match(i.variant) && (!device || i.device === device)).length;

  const empty = !loading && !error && items.length === 0;

  return (
    <AppPage width="reading" className="gap-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-round text-[26px] font-extrabold tracking-tight text-ev-ink">Library</h1>
          {!loading && items.length > 0 ? (
            <p className="mt-0.5 font-round text-[13px] font-semibold text-ev-ink-2">
              {items.length}
              {hasOlder ? '+' : ''} {items.length === 1 ? 'item' : 'items'}
              {devices.length > 0 ? ` from ${devices.length} ${devices.length === 1 ? 'place' : 'places'}` : ''}
            </p>
          ) : null}
        </div>
        <Link href="/app/record" className={appButton('primary')}>
          <Mic className="h-4 w-4" /> New recording
        </Link>
      </header>

      <nav className="flex gap-3 text-sm"><Link href="/app/import" className={appButton('secondary')}>Import recordings</Link><Link href="/app/memory" className={appButton('secondary')}>Ask your library</Link></nav>

      {!empty ? (
        <div className="flex flex-col gap-2.5">
          <label className="flex h-9 items-center gap-2 rounded-[var(--ev-r-ctl)] bg-ev-well px-3 text-ev-ink-3 focus-within:bg-ev-raised focus-within:shadow-[var(--ev-focus)]">
            <Search size={15} strokeWidth={1.75} aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by title"
              aria-label="Filter library by title"
              className="h-full min-w-0 flex-1 bg-transparent font-round text-[13.5px] text-ev-ink outline-none placeholder:text-ev-ink-3"
            />
            {query ? (
              <button type="button" aria-label="Clear filter" onClick={() => setQuery('')} className="grid h-6 w-6 place-items-center rounded-full hover:bg-[var(--ev-hover)]">
                <X size={13} strokeWidth={2} />
              </button>
            ) : null}
          </label>

          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {FILTERS.map((f) => (
              <Chip
                key={f.value}
                selected={filter === f.value}
                count={countFor(f)}
                onClick={() => setSearch({ filter: f.value, device })}
              >
                {f.label}
              </Chip>
            ))}
            {devices.length > 1 ? (
              <>
                <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-ev-line" />
                <Menu
                  align="start"
                  trigger={
                    <button type="button" className="ev-chip shrink-0" aria-pressed={Boolean(device)}>
                      <Laptop size={13} strokeWidth={1.75} aria-hidden />
                      {device ?? 'All devices'}
                      <ChevronDown size={12} strokeWidth={2} aria-hidden />
                    </button>
                  }
                  items={[
                    { label: 'All devices', onSelect: () => setSearch({ filter }) },
                    'separator',
                    ...devices.map(([name, n]) => ({
                      id: name,
                      label: `${name} · ${n}`,
                      icon: Laptop,
                      onSelect: () => setSearch({ filter, device: name }),
                    })),
                  ]}
                />
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? <AppAlert>Couldn&apos;t load your library: {error.message}</AppAlert> : null}

      {loading ? (
        <LoadingRows />
      ) : empty ? (
        <EmptyLibrary />
      ) : visible.length === 0 ? (
        <p className="py-10 text-center font-round text-sm font-semibold text-ev-ink-2">
          {normalized ? `Nothing matches “${query.trim()}”.` : 'Nothing here with these filters.'}
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {groupByDay(visible).map(([day, group]) => (
            <section key={day} aria-label={day}>
              <h2 className="sticky top-0 z-[1] -mx-2 bg-[color-mix(in_srgb,var(--ev-paper)_92%,transparent)] px-2 py-1.5 font-round text-xs font-bold text-ev-ink-2 backdrop-blur">
                {day}
              </h2>
              <ul className="relative">
                <span aria-hidden className="absolute bottom-5 left-[22px] top-5 border-l border-dotted border-ev-line-strong" />
                {group.map((item) => (
                  <li key={`${item.kind}-${item.id}`}>
                    <LibraryRow item={item} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {!loading && hasOlder && !normalized ? (
        <div className="flex justify-center pt-2">
          <Button variant="outline" loading={loadingOlder} onClick={loadOlder}>
            Show older
          </Button>
        </div>
      ) : null}
    </AppPage>
  );
}

function LibraryRow({ item }: { item: LibItem }) {
  const kind = kindOf(item.variant);
  const working = item.kind === 'meeting' && item.status && !['complete', 'failed'].includes(item.status);
  const failed = item.kind === 'meeting' && item.status === 'failed';
  return (
    <Link
      href={item.href}
      className="group relative flex gap-3 rounded-[var(--ev-r-pop)] px-2 py-2.5 transition-colors hover:bg-[var(--ev-hover)]"
    >
      <span className="relative mt-px grid h-[28px] w-[28px] shrink-0 place-items-center rounded-full bg-ev-paper text-ev-ink-2 shadow-[0_0_0_1px_var(--ev-line)] group-hover:text-ev-coat">
        {working ? <Mascot size={20} state="thinking" /> : <KindIcon item={item} size={15} />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-round text-[14.5px] font-bold text-ev-ink">{item.title}</span>
          <span className="shrink-0 font-round text-[12px] tabular-nums text-ev-ink-3">
            {new Date(item.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
          </span>
        </span>
        {item.subtitle ? (
          <span className="mt-0.5 line-clamp-2 text-[13.5px] leading-5 text-ev-ink-2">{item.subtitle}</span>
        ) : null}
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-round text-[12px] font-semibold text-ev-ink-2">
          <span>{item.platform ?? kind.label}</span>
          {item.durationSec ? (
            <span className="tabular-nums text-ev-ink-3">{formatDuration(item.durationSec * 1000)}</span>
          ) : null}
          {item.device ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-ev-well px-2 py-0.5 text-ev-ink-2">
              <Laptop size={11} strokeWidth={2} aria-hidden />
              {item.device}
            </span>
          ) : null}
          {working ? <span className="text-ev-coat">Writing it down…</span> : null}
          {failed ? <span className="text-ev-warn-ink">Didn&apos;t finish</span> : null}
        </span>
      </span>

      {item.thumbUrl ? (
        <span className="hidden h-[58px] w-[92px] shrink-0 overflow-hidden rounded-[var(--ev-r-media)] bg-ev-well shadow-[0_0_0_1px_var(--ev-line),var(--ev-e-2)] sm:block">
          {item.mediaKind === 'video' ? (
            // A <video> per row would fetch every recording's metadata; the row
            // only needs to say it is a video.
            <span className="grid h-full w-full place-items-center text-ev-ink-3">
              <Video size={20} strokeWidth={1.75} aria-hidden />
            </span>
          ) : (
            <img
              src={item.thumbUrl}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
              onError={(e) => {
                e.currentTarget.style.visibility = 'hidden';
              }}
            />
          )}
        </span>
      ) : null}
    </Link>
  );
}

function LoadingRows() {
  return (
    <div aria-label="Loading library" className="flex flex-col gap-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex animate-pulse gap-3 px-2 py-2.5">
          <div className="h-7 w-7 rounded-full bg-ev-well" />
          <div className="flex-1">
            <div className="h-3.5 w-2/5 rounded-full bg-ev-well" />
            <div className="mt-2 h-3 w-3/4 rounded-full bg-ev-well" />
            <div className="mt-2 h-3 w-1/5 rounded-full bg-ev-well" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyLibrary() {
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <Bubble tail="bottom" className="mb-3">
        It&apos;s quiet up here. Record a voice note and I&apos;ll write it down.
      </Bubble>
      <Mascot size={72} state="idle" />
      <Link href="/app/record" className={cn(appButton('primary'), 'mt-6')}>
        <Mic className="h-4 w-4" /> New recording
      </Link>
    </div>
  );
}

function dayLabel(ms: number): string {
  const date = new Date(ms);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const sixDaysAgo = new Date();
  sixDaysAgo.setDate(today.getDate() - 6);
  if (date > sixDaysAgo) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

function groupByDay(items: LibItem[]): [string, LibItem[]][] {
  const groups = new Map<string, LibItem[]>();
  for (const item of items) {
    const day = dayLabel(item.createdAt);
    groups.set(day, [...(groups.get(day) ?? []), item]);
  }
  return [...groups];
}
