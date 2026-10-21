import type { LearnedCorrection } from './learning';

/** What can sit between the two sides of a pasted line, tried in this order. */
const SEPARATORS = ['→', '->', '=>', '\t', '=', ':', ','];

/**
 * A pasted list of replacements, one per line: "heard → type", "heard -> type",
 * "heard = type", a tab (from a spreadsheet) and so on. Blank lines are ignored;
 * lines without both sides come back in `unread`.
 */
export function parseReplacements(text: string): { entries: LearnedCorrection[]; unread: string[] } {
  const entries: LearnedCorrection[] = [];
  const unread: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const separator = SEPARATORS.find((candidate) => line.includes(candidate));
    const at = separator ? line.indexOf(separator) : -1;
    const from = at > 0 ? line.slice(0, at).trim() : '';
    const to = separator && at > 0 ? line.slice(at + separator.length).trim() : '';
    if (!from || !to) { unread.push(line); continue; }
    const key = from.toLocaleLowerCase();
    if (seen.has(key)) entries.splice(entries.findIndex((entry) => entry.from.toLocaleLowerCase() === key), 1);
    seen.add(key);
    entries.push({ from, to });
  }
  return { entries, unread };
}
