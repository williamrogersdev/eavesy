import { createFileRoute } from '@tanstack/react-router';
import { Camera, Clock, Image as ImageIcon, Mic, Monitor, Video } from 'lucide-react';
import { Link } from '@/components/ui/app-link';
import { type LibItem, useLibraryItems } from '@/lib/api/use-library';
import { cn, formatDuration } from '@/lib/utils';
import { AppAlert, AppEmptyState, AppPage, AppPageHeader, appButton } from '@/components/ui/app-page';

type Tab = 'all' | 'meetings' | 'captures';

export const Route = createFileRoute('/app/')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    search.tab === 'meetings' || search.tab === 'captures' ? { tab: search.tab } : {},
  component: LibraryPage,
});

function LibraryPage() {
  const { items, loading, error } = useLibraryItems();
  const navigate = Route.useNavigate();
  const tab: Tab = Route.useSearch().tab ?? 'all';
  const setTab = (next: Tab) =>
    void navigate({ search: next === 'all' ? {} : { tab: next }, replace: true });

  const counts = {
    all: items.length,
    meetings: items.filter((i) => i.kind === 'meeting').length,
    captures: items.filter((i) => i.kind === 'capture').length,
  };

  const visible = items.filter((i) =>
    tab === 'all' ? true : tab === 'meetings' ? i.kind === 'meeting' : i.kind === 'capture',
  );

  return (
    <AppPage>
      <AppPageHeader title="Library" />

      <div role="tablist" aria-label="Filter library" className="flex max-w-full items-center gap-1 overflow-x-auto border-b border-border">
        <TabButton label="All" count={counts.all} active={tab === 'all'} onClick={() => setTab('all')} />
        <TabButton label="Recordings" count={counts.meetings} active={tab === 'meetings'} onClick={() => setTab('meetings')} />
        <TabButton label="Captures" count={counts.captures} active={tab === 'captures'} onClick={() => setTab('captures')} />
      </div>

      {error ? (
        <AppAlert>Couldn&apos;t load your library: {error.message}</AppAlert>
      ) : loading ? (
        <div aria-label="Loading library" className="flex flex-col gap-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex animate-pulse items-center gap-3 px-2 py-2">
              <div className="h-9 w-16 rounded bg-muted" />
              <div className="flex-1">
                <div className="h-3.5 w-1/3 rounded bg-muted" />
                <div className="mt-1.5 h-3 w-1/4 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState tab={tab} />
      ) : (
        <div className="flex flex-col gap-4">
          {groupByDay(visible).map(([day, group]) => (
            <section key={day}>
              <h2 className="mb-1 px-2 text-xs font-medium text-muted-foreground">{day}</h2>
              <ul className="flex flex-col">
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
    </AppPage>
  );
}

function dayLabel(ms: number): string {
  const date = new Date(ms);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

function groupByDay(items: LibItem[]): [string, LibItem[]][] {
  const groups = new Map<string, LibItem[]>();
  for (const item of [...items].sort((a, b) => b.createdAt - a.createdAt)) {
    const day = dayLabel(item.createdAt);
    groups.set(day, [...(groups.get(day) ?? []), item]);
  }
  return [...groups];
}

function TabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        '-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-sm transition',
        active ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}

function LibraryRow({ item }: { item: LibItem }) {
  const pending = item.kind === 'meeting' && item.status && item.status !== 'complete';
  return (
    <Link
      href={item.href}
      className="group flex items-center gap-3 rounded-md px-2 py-2 transition hover:bg-muted"
    >
      <span className="relative flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-muted text-muted-foreground">
        {item.thumbUrl ? (
          item.mediaKind === 'video' ? (
            <video src={item.thumbUrl} className="h-full w-full object-cover" muted preload="metadata" />
          ) : (
            <img src={item.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
          )
        ) : (
          <TypeIcon item={item} className="h-4 w-4" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{item.title}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {typeLabel(item)}
          <span aria-hidden>·</span>
          {new Date(item.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
          {item.durationSec ? (
            <>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{formatDuration(item.durationSec * 1000)}</span>
            </>
          ) : null}
          {pending ? (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1 text-accent">
                <Clock className="h-3 w-3" />
                {item.status === 'failed' ? 'failed' : 'processing'}
              </span>
            </>
          ) : null}
        </span>
      </span>
    </Link>
  );
}

function TypeIcon({ item, className }: { item: LibItem; className?: string }) {
  if (item.kind === 'meeting') return <Mic className={className} />;
  switch (item.captureMode) {
    case 'screenshot':
      return <Camera className={className} />;
    case 'webcam':
      return <Video className={className} />;
    case 'screen':
      return <Monitor className={className} />;
    case 'audio':
      return <Mic className={className} />;
    default:
      return <ImageIcon className={className} />;
  }
}

function typeLabel(item: LibItem): string {
  if (item.kind === 'meeting') return 'Recording';
  switch (item.captureMode) {
    case 'screenshot':
      return 'Screenshot';
    case 'webcam':
      return 'Video';
    case 'screen':
      return 'Screen';
    case 'audio':
      return 'Audio';
    default:
      return 'Capture';
  }
}

function EmptyState({ tab }: { tab: Tab }) {
  const captures = tab === 'captures';
  return (
    <AppEmptyState
      icon={captures ? <Camera /> : <Mic />}
      title={captures ? 'No captures yet' : 'Nothing here yet'}
      description={captures
        ? 'Take a screenshot or record your screen with the buttons at the top.'
        : 'Record a voice note or a meeting and Eavesy writes the transcript and brief.'}
      action={captures ? undefined : (
        <Link href="/app/record" className={appButton('primary')}>
          <Mic className="h-4 w-4" /> New recording
        </Link>
      )}
    />
  );
}
