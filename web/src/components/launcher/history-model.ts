import { score } from '@/lib/launcher/filter';
import type { Recording } from '@/lib/launcher/types';

/** Turns a stored transcript (markdown with timestamps) into plain text. */
export function plainTranscript(text: string): string {
  return text.replace(/^# [^\n]*\n+(?:## Transcript\n+)?/, '')
    .replace(/^\*\*\[\d{2}:\d{2}:\d{2}\] ([^\n]*?):\*\* /gm, '$1: ')
    .replace(/^\[\d{2}:\d{2}:\d{2}\] /gm, '').trim();
}

export type HistoryFilter = 'all' | 'voice' | 'meetings' | 'screens' | 'notes';

/**
 * Whether focus arriving in the search field opens it from an icon into a
 * field. Asked for ("/") or moved there from another control (Tab, a closing
 * filter menu) opens it; the panel's quiet focus on open and the window
 * getting focus back (nothing to come from) leave it an icon until you type.
 */
export function searchFocusOpens({ asked, quiet, fromElement }: { asked: boolean; quiet: boolean; fromElement: boolean }): boolean {
  return asked || (!quiet && fromElement);
}

export const FILTERS: { value: HistoryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'voice', label: 'Voice' },
  { value: 'meetings', label: 'Meetings' },
  { value: 'screens', label: 'Screens' },
  { value: 'notes', label: 'Notes' },
];

/** How each source reads in the panel, and which filter shows it. The one table for both. */
const SOURCE_KIND: Record<Recording['source'], { label: string; filter: Exclude<HistoryFilter, 'all'> }> = {
  mic: { label: 'Voice note', filter: 'voice' },
  dictation: { label: 'Voice note', filter: 'voice' },
  both: { label: 'Meeting', filter: 'meetings' },
  system: { label: 'Meeting', filter: 'meetings' },
  screen: { label: 'Video', filter: 'screens' },
  screenshot: { label: 'Screenshot', filter: 'screens' },
  image: { label: 'Image', filter: 'screens' },
  note: { label: 'Note', filter: 'notes' },
  upload: { label: 'Upload', filter: 'voice' },
};

export function filterOf(rec: Recording): Exclude<HistoryFilter, 'all'> {
  if (rec.source === 'upload') return rec.hasVideo ? 'screens' : 'voice';
  return (SOURCE_KIND[rec.source] ?? SOURCE_KIND.mic).filter;
}

/** The kind label on a row's meta line ("Voice note", "Meeting"); an upload shows its title. */
export function kindLabel(rec: Recording): string {
  if (rec.source === 'upload') return rec.title || 'Upload';
  return (SOURCE_KIND[rec.source] ?? SOURCE_KIND.mic).label;
}

/** Newest first, narrowed by chip and search (title + transcript). */
export function visibleRecordings(recordings: Recording[], filter: HistoryFilter, query: string): Recording[] {
  const q = query.trim();
  return recordings
    .filter((rec) => filter === 'all' || filterOf(rec) === filter)
    .filter((rec) => !q || score(q, rec.title, `${plainTranscript(rec.transcript ?? '')} ${rec.summary ?? ''}`) >= 0)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function countByFilter(recordings: Recording[]): Record<HistoryFilter, number> {
  const counts: Record<HistoryFilter, number> = { all: recordings.length, voice: 0, meetings: 0, screens: 0, notes: 0 };
  for (const rec of recordings) counts[filterOf(rec)] += 1;
  return counts;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today", "Yesterday", a weekday within the last week, then "Mar 4" (with the year when it isn't this one). */
export function dayLabel(ms: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const date = new Date(ms);
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface DayGroup { label: string; items: Recording[] }

/** Consecutive recordings of the same day, keeping their order. */
export function groupByDay(recordings: Recording[], now: number): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const rec of recordings) {
    const label = dayLabel(rec.startedAt, now);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(rec);
    else groups.push({ label, items: [rec] });
  }
  return groups;
}

/** Splits text around case-insensitive matches of the query, for highlighting. */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text, hit: false }];
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .split(new RegExp(`(${escaped})`, 'gi'))
    .filter((part) => part !== '')
    .map((part) => ({ text: part, hit: part.toLowerCase() === q.toLowerCase() }));
}

export function clock(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * What the history area shows. Until the first page arrives it is loading (search
 * and an empty list, never the empty mascot), and a failed load is never "empty".
 */
export type HistoryView = 'loading' | 'empty' | 'list';
export function historyView(page: { counts: { all: number } } | null, error: string | null, live: boolean): HistoryView {
  if (live) return 'list';
  if (page === null) return error ? 'list' : 'loading';
  return page.counts.all === 0 && !error ? 'empty' : 'list';
}

/** Whether two rows carry the same data, field by field (every Recording field is flat). */
export function sameRecording(a: Recording, b: Recording): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Recording>;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/**
 * Keeps the previous object for every row whose data didn't change, so memoized
 * rows skip re-rendering after a refresh. Returns `previous` itself when nothing changed.
 */
export function reuseRows(previous: readonly Recording[], next: Recording[]): Recording[] {
  if (previous.length === 0) return next;
  const old = new Map(previous.map((row) => [row.id, row]));
  let changed = previous.length !== next.length;
  const rows = next.map((row, index) => {
    const kept = old.get(row.id);
    const out = kept && sameRecording(kept, row) ? kept : row;
    if (out !== previous[index]) changed = true;
    return out;
  });
  return changed ? rows : (previous as Recording[]);
}
