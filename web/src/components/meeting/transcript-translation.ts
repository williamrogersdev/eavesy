import type { TranscriptLine } from './transcript-player';

/** Each request translates a few hundred lines; a long meeting takes a few. */
const MAX_TRANSLATE_PAGES = 20;

export type Translations = Record<string, { source: string; text: string }>;

/** The languages heard in these lines, most spoken first. */
export function spokenLanguages(lines: readonly TranscriptLine[]): string[] {
  const weight = new Map<string, number>();
  for (const line of lines) {
    if (line.language) weight.set(line.language, (weight.get(line.language) ?? 0) + line.text.length);
  }
  return [...weight].sort((a, b) => b[1] - a[1]).map(([language]) => language);
}

/** Adds a page of translations, each kept with the text it was made from. */
export function mergeTranslations(
  previous: Translations,
  sources: ReadonlyMap<string, string>,
  entries: readonly [string, unknown][],
): Translations {
  const next = { ...previous };
  for (const [id, text] of entries) {
    const source = sources.get(id);
    if (source !== undefined && typeof text === 'string') next[id] = { source, text };
  }
  return next;
}

/** The translation to show for a line, or undefined to show the original. */
export function translationFor(done: Translations, line: TranscriptLine): string | undefined {
  const entry = done[line.id];
  if (!entry || entry.source !== line.text || !entry.text.trim() || entry.text === line.text) return undefined;
  return entry.text;
}

export function translateErrorMessage(status: number): string {
  return status === 429 ? 'Translation limit reached for today.' : 'Could not translate.';
}

/** What the Translate button does: hide, or show and fetch any lines not tried yet. */
export function toggleTranslation(showing: boolean, untried: number): { showing: boolean; load: boolean } {
  return showing ? { showing: false, load: false } : { showing: true, load: untried > 0 };
}

/** Pages through the translate endpoint until it has nothing left or stops making progress. */
export async function requestTranslations({
  meetingId,
  target,
  onPage,
  fetchImpl = fetch,
}: {
  meetingId: string;
  target: string;
  onPage: (entries: [string, unknown][]) => void;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  let previousCount = -1;
  for (let page = 0; page < MAX_TRANSLATE_PAGES; page++) {
    const res = await fetchImpl(`/api/meetings/${meetingId}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: target }),
    });
    if (!res.ok) throw new Error(translateErrorMessage(res.status));
    const body: unknown = await res.json();
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const entries = typeof record.lines === 'object' && record.lines !== null ? Object.entries(record.lines) : [];
    onPage(entries);
    const remaining = typeof record.remaining === 'number' ? record.remaining : 0;
    if (remaining === 0 || entries.length === previousCount) break;
    previousCount = entries.length;
  }
}
