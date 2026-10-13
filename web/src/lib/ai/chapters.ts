export interface Chapter {
  startMs: number;
  title: string;
}

export const MIN_CHAPTER_MEETING_MS = 3 * 60 * 1_000;
const MAX_CHAPTERS = 20;
const MAX_TITLE = 80;

export const CHAPTERS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['start', 'title'],
    properties: { start: { type: 'string' }, title: { type: 'string' } },
  },
} as const;

export const CHAPTER_INSTRUCTIONS = `Chapters: divide the meeting into chapters, roughly one per 5-10 minutes of discussion, between 2 and 12. Each chapter's "start" is copied exactly from the [mm:ss] or [h:mm:ss] timestamp of the line where it begins, and the first chapter starts at the first line. Titles are 2-6 words in the transcript's language. Return an empty list for meetings under three minutes.`;

export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

export function parseClock(text: string): number | null {
  const match = text.trim().replace(/^\[|\]$/g, '').match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, h, m, s] = match;
  return ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1_000;
}

export function validateChapters(proposed: unknown, lineStartsMs: number[], meetingMs: number): Chapter[] {
  if (meetingMs < MIN_CHAPTER_MEETING_MS || lineStartsMs.length === 0 || !Array.isArray(proposed)) return [];
  const starts = [...lineStartsMs].sort((a, b) => a - b);
  const snap = (ms: number) =>
    starts.reduce((best, start) => (Math.abs(start - ms) < Math.abs(best - ms) ? start : best), starts[0]);

  const chapters = new Map<number, string>();
  for (const item of proposed) {
    if (typeof item !== 'object' || item === null) continue;
    const { start, title } = item as { start?: unknown; title?: unknown };
    if (typeof start !== 'string' || typeof title !== 'string') continue;
    const ms = parseClock(start);
    const cleaned = title
      .replace(/\s+/g, ' ')
      .replace(/^["'*#\s]+|["'*#\s]+$/g, '')
      .slice(0, MAX_TITLE)
      .trim();
    if (ms === null || !cleaned) continue;
    const snapped = snap(ms);
    if (!chapters.has(snapped)) chapters.set(snapped, cleaned);
  }
  const sorted = [...chapters.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, MAX_CHAPTERS)
    .map(([startMs, title]) => ({ startMs, title }));
  if (sorted.length > 0) sorted[0] = { ...sorted[0], startMs: starts[0] };
  return sorted;
}
