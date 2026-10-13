export type TimelineSource = 'audio' | 'screen';

export interface AudioSegmentInput {
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string | null;
}

export interface VisualEntryInput {
  atMs: number;
  text: string;
  captureId?: string | null;
}

export interface TimelineEntry {
  source: TimelineSource;
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
  captureId?: string;
}

export function mergeTimeline(opts: {
  audioSegments?: AudioSegmentInput[];
  visualEntries?: VisualEntryInput[];
}): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const seg of opts.audioSegments ?? []) {
    const text = seg.text.trim();
    if (!text) continue;
    entries.push({
      source: 'audio',
      startMs: seg.startMs,
      endMs: seg.endMs,
      text,
      speakerId: seg.speakerId ?? undefined,
    });
  }

  for (const v of opts.visualEntries ?? []) {
    const text = v.text.trim();
    if (!text) continue;
    entries.push({
      source: 'screen',
      startMs: v.atMs,
      endMs: v.atMs,
      text,
      captureId: v.captureId ?? undefined,
    });
  }

  entries.sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    if (a.source !== b.source) return a.source === 'screen' ? -1 : 1;
    return a.endMs - b.endMs;
  });

  return entries;
}

function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function renderTimeline(entries: TimelineEntry[]): string {
  return entries
    .map((e) => {
      const ts = `[${formatClock(e.startMs)}]`;
      if (e.source === 'screen') return `${ts} (screen) ${e.text}`;
      const who = e.speakerId ? `${e.speakerId}: ` : '';
      return `${ts} ${who}${e.text}`;
    })
    .join('\n');
}
