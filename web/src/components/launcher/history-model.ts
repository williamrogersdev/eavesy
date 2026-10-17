import { score } from '@/lib/launcher/filter';
import type { Recording } from '@/lib/launcher/types';

/** Turns a stored transcript (markdown with timestamps) into plain text. */
export function plainTranscript(text: string): string {
  return text.replace(/^# [^\n]*\n+(?:## Transcript\n+)?/, '')
    .replace(/^\*\*\[\d{2}:\d{2}:\d{2}\] ([^\n]*?):\*\* /gm, '$1: ')
    .replace(/^\[\d{2}:\d{2}:\d{2}\] /gm, '').trim();
}

export type HistoryFilter = 'all' | 'voice' | 'meetings' | 'screens' | 'notes';

export const FILTERS: { value: HistoryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'voice', label: 'Voice' },
  { value: 'meetings', label: 'Meetings' },
  { value: 'screens', label: 'Screens' },
  { value: 'notes', label: 'Notes' },
];

export function filterOf(rec: Recording): Exclude<HistoryFilter, 'all'> {
  switch (rec.source) {
    case 'both':
    case 'system':
      return 'meetings';
    case 'screen':
    case 'screenshot':
    case 'image':
      return 'screens';
    case 'note':
      return 'notes';
    case 'upload':
      return rec.hasVideo ? 'screens' : 'voice';
    default:
      return 'voice';
  }
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
