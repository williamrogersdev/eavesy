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
  entries: readonly (readonly [string, string])[],
): Translations {
  const next = { ...previous };
  for (const [id, text] of entries) {
    const source = sources.get(id);
    if (source !== undefined) next[id] = { source, text };
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

/**
 * Pages through the translate endpoint, which answers with every line
 * translated so far, until nothing remains. Throws when a page adds nothing
 * or the page budget runs out, so the caller can offer a retry.
 */
export async function requestTranslations({
  meetingId,
  target,
  signal,
  onPage,
  fetchImpl = fetch,
}: {
  meetingId: string;
  target: string;
  signal?: AbortSignal;
  onPage: (entries: [string, string][]) => void;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  let previousCount = -1;
  for (let page = 0; page < MAX_TRANSLATE_PAGES; page++) {
    const res = await fetchImpl(`/api/meetings/${meetingId}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: target }),
      signal,
    });
    if (!res.ok) throw new Error(translateErrorMessage(res.status));
    const value: unknown = await res.json();
    if (!value || typeof value !== 'object') throw new Error('Could not read the translation.');
    const data = value as { lines?: unknown; remaining?: unknown };
    if (!data.lines || typeof data.lines !== 'object' || Array.isArray(data.lines)) throw new Error('Could not read the translation.');
    const entries = Object.entries(data.lines).filter((pair): pair is [string, string] => typeof pair[1] === 'string');
    if (signal?.aborted) return;
    onPage(entries);
    if (data.remaining === 0) return;
    if (entries.length === previousCount) throw new Error('Translation stopped early. Choose the language again to retry.');
    previousCount = entries.length;
  }
  throw new Error('This meeting needs another pass. Choose the language again to continue.');
}
