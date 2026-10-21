import type { LearnedCorrection } from './learning';

/** What can sit between the two sides of a pasted line; the first one in the line wins. */
const SEPARATORS = ['→', '->', '=>', '\t', '='];

/**
 * A pasted list of replacements, one per line: "heard → type", "heard -> type",
 * "heard = type" or a tab (from a spreadsheet). Commas and colons are left alone, since they turn up in ordinary phrases. Blank lines are ignored;
 * lines without both sides come back in `unread`.
 */
export function parseReplacements(text: string): { entries: LearnedCorrection[]; unread: string[] } {
  const entries: LearnedCorrection[] = [];
  const unread: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let at = -1;
    let separator = '';
    for (const candidate of SEPARATORS) {
      const index = line.indexOf(candidate);
      if (index !== -1 && (at === -1 || index < at || (index === at && candidate.length > separator.length))) { at = index; separator = candidate; }
    }
    const from = at > 0 ? line.slice(0, at).trim() : '';
    const to = at > 0 ? line.slice(at + separator.length).trim() : '';
    if (!from || !to) { unread.push(line); continue; }
    const key = from.toLocaleLowerCase();
    if (seen.has(key)) entries.splice(entries.findIndex((entry) => entry.from.toLocaleLowerCase() === key), 1);
    seen.add(key);
    entries.push({ from, to });
  }
  return { entries, unread };
}

/** Replacements one paste can add; the server takes no more in one request. */
export const MAX_BULK_REPLACEMENTS = 200;
