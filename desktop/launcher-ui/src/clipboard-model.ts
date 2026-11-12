// What the clipboard panel (clipboard.tsx) works out without the app: day
// headings, where the arrow keys go, and the words under a preview.

export type View = 'clipboard' | 'screenshots';
export type ClipKind = 'text' | 'link' | 'image' | 'file';

export interface Clip { id: number; kind: ClipKind; title: string; lastMs: number }
export interface ClipDetail {
  id: number; kind: ClipKind; text: string; source: string | null;
  firstMs: number; lastMs: number; times: number;
  width: number; height: number; chars: number; words: number; bytes: number;
  image: string | null;
}
export interface Shot { id: string; title: string; atMs: number }

const DAY = 86_400_000;
const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "Today", "Yesterday", then the date ("Mon 9 Nov"; with the year once it differs). */
export function dayLabel(ms: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Rows (newest first) under their day headings, in order. */
export function groupByDay<T>(rows: T[], at: (row: T) => number, now: number): { label: string; rows: T[] }[] {
  const groups: { label: string; rows: T[] }[] = [];
  for (const row of rows) {
    const label = dayLabel(at(row), now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.rows.push(row); else groups.push({ label, rows: [row] });
  }
  return groups;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** When something was copied: "Today at 2:41 PM". */
export function when(ms: number, now: number): string {
  return `${dayLabel(ms, now)} at ${clock(ms)}`;
}

/**
 * Where an arrow key takes the selection among `count` items laid out in
 * `columns` (1 for a list). Stops at the edges; with nothing selected, any
 * arrow picks the first item. -1 when there is nothing to select.
 */
export function step(index: number, key: string, count: number, columns: number): number {
  if (count <= 0) return -1;
  if (index < 0 || index >= count) return 0;
  const sideways = key === 'ArrowRight' || key === 'ArrowLeft';
  const delta = key === 'ArrowDown' ? columns : key === 'ArrowUp' ? -columns : key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  // A list has no sideways; in a grid, sideways stays on the row.
  if (sideways && (columns === 1 || Math.floor((index + delta) / columns) !== Math.floor(index / columns))) return index;
  const next = index + delta;
  if (next < 0) return index;
  // Down from the row above a short last row lands on its last item.
  if (next >= count) return delta === columns && Math.floor(index / columns) < Math.floor((count - 1) / columns) ? count - 1 : index;
  return next;
}

/** The item to select after the list changed: the same one if it's still there, else the one that took its place. */
export function keep(ids: (string | number)[], selected: string | number | null, previousIndex: number): string | number | null {
  if (ids.length === 0) return null;
  if (selected !== null && ids.includes(selected)) return selected;
  return ids[Math.min(Math.max(previousIndex, 0), ids.length - 1)];
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const count = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

/** The facts under a preview, as label and value. */
export function facts(detail: ClipDetail, now: number): [string, string][] {
  const rows: [string, string][] = [];
  if (detail.source) rows.push(['Copied from', detail.source]);
  rows.push(['Copied', detail.times > 1 ? `${when(detail.lastMs, now)} · ${detail.times} times` : when(detail.lastMs, now)]);
  if (detail.kind === 'image') rows.push(['Size', `${detail.width} × ${detail.height} · ${size(detail.bytes)}`]);
  else if (detail.kind !== 'file') rows.push(['Size', `${count(detail.chars, 'character')} · ${count(detail.words, 'word')}`]);
  return rows;
}

/** The footer's main action: "Paste to Claude", or just "Paste" when the app isn't known. */
export function pasteLabel(target: string | null): string {
  return target ? `Paste to ${target}` : 'Paste';
}
