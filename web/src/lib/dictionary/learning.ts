import { COMMON_WORDS } from './common-words';

/** Only differences made by a person enter the dictionary. Never feed model output here. */
export interface LearnedCorrection { from: string; to: string }
/** A learned fix steers transcription once it has been made this many times; until then it is a suggestion. */
export const CONFIRMING_SIGHTINGS = 2;
/** Typed by hand, kept from a suggestion, or the same fix made more than once. */
export const isConfirmed = (e: { origin?: string | null; seen?: number }) => e.origin === 'manual' || (e.seen ?? 1) >= CONFIRMING_SIGHTINGS;
export const normalizeTerm = (text: string) => text.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
const words = (text: string) => [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
const protectedWords = (text: string) => text.toLowerCase().match(/\p{N}+|\b(?:no|not|never|cannot|without|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|\w+n['’]t)\b/gu) ?? [];

export function validCorrection(from: string, to: string): boolean {
  return !!from.trim() && !!to.trim() && from.length <= 128 && to.length <= 128
    && words(from).length > 0 && words(to).length > 0
    && words(from).length <= 6 && words(to).length <= 6
    && from !== to
    && JSON.stringify(protectedWords(from)) === JSON.stringify(protectedWords(to));
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/**
 * Automatic learning keeps only fixes that look like a mis-heard name or term.
 * Capitalisation tweaks, lowercase words, grammar edits (keep -> kept) and
 * rewrites (Is -> Seems) are prose editing, not vocabulary.
 */
/** Units and suffixes a number takes when someone tidies it ("10" → "10am"). */
const NUMBER_SUFFIX = /^(?:am|pm|s|k|m|x|th|st|nd|rd|ish)?$/;

/**
 * Whether `text` is only everyday words, numbers and single letters: what a
 * sentence rewrite produces. A name or term has at least one word that isn't
 * ("Repackify", "Next.js", "Gaylord Boxes", "John"), or a symbol ("C++", "C#").
 */
export function isPlainWords(text: string): boolean {
  if (/[+#@&/]|\.\p{L}/u.test(text)) return false;
  return words(text).every(({ text: word }) => {
    const lower = word.toLocaleLowerCase('en').replace(/’/g, "'");
    if (lower.length === 1 || COMMON_WORDS.has(lower)) return true;
    // Plurals and possessives of everyday words: "notes", "team's".
    if (COMMON_WORDS.has(lower.replace(/(?:'s|s|es)$/, ''))) return true;
    const digits = /^\p{N}+/u.exec(lower);
    return !!digits && NUMBER_SUFFIX.test(lower.slice(digits[0].length));
  });
}

export function isLearnableSpelling(from: string, to: string): boolean {
  if (normalizeTerm(from) === normalizeTerm(to)) return false;
  if (!/[\p{Lu}\p{N}.+#@&]/u.test(to)) return false;
  // Sentence-initial capitals pass the test above; everyday words are still prose ("Yeah" → "Yes").
  if (isPlainWords(to)) return false;
  const a = normalizeTerm(from).replace(/\s+/g, ''), b = normalizeTerm(to).replace(/\s+/g, '');
  const upper = (text: string) => /^\p{Lu}/u.test(text.trim());
  const sameShape = upper(from) === upper(to) && !/\p{Lu}/u.test(to.trim().slice(1));
  if (sameShape) {
    // Same stem, different ending. Four-letter words share less (keep -> kept).
    const shortest = Math.min(a.length, b.length);
    let shared = 0;
    while (shared < shortest && a[shared] === b[shared]) shared++;
    // Matching endings too means a letter changed inside the word, which is a
    // misspelt name (Eavsy -> Eavesy), not a new ending.
    let tail = 0;
    while (tail < shortest - shared && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    if (tail < 2 && shared >= Math.max(shortest <= 3 ? 3 : 2, shortest - 2)) return false;
  }
  // Too different in length to be within the limit: skip the distance.
  if (Math.abs(a.length - b.length) / Math.max(a.length, b.length) > 0.6) return false;
  return editDistance(a, b) / Math.max(a.length, b.length) <= 0.6;
}

/** Word-level LCS separates independent edits and avoids learning sentence rewrites. */
export function learnCorrections(original: string, corrected: string): LearnedCorrection[] {
  if (original === corrected || original.length > 12_000 || corrected.length > 12_000) return [];
  const a = words(original), b = words(corrected);
  if (!a.length || !b.length || a.length > 600 || b.length > 600) return [];
  const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    rows[i][j] = a[i].text === b[j].text ? 1 + rows[i + 1][j + 1] : Math.max(rows[i + 1][j], rows[i][j + 1]);
  }
  if (Math.max(a.length, b.length) > 3 && rows[0][0] / Math.min(a.length, b.length) < 0.6) return [];
  let i = 0, j = 0;
  const result: LearnedCorrection[] = [];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].text === b[j].text) { i++; j++; continue; }
    const ai = i, bj = j;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i].text === b[j].text) break;
      if (j < b.length && (i === a.length || rows[i][j + 1] > rows[i + 1][j])) j++;
      else i++;
    }
    if (i === ai || j === bj) continue; // additions and deletions are not vocabulary.
    const from = original.slice(a[ai].start, a[i - 1].end);
    const to = corrected.slice(b[bj].start, b[j - 1].end);
    if (validCorrection(from, to) && isLearnableSpelling(from, to)) result.push({ from, to });
  }
  // The last edit wins for a repeated source, matching later human corrections.
  return [...new Map(result.map(r => [normalizeTerm(r.from), r])).values()].slice(0, 20);
}

/**
 * Why a learned entry is listed, in the user's words: what they changed and
 * how often, like "You changed “Eavsy” to “Eavesy” 3 times, most recently yesterday."
 */
export function learnedReason(entry: { from: string; to: string; seen?: number; updatedAt?: number }, now = Date.now()): string {
  const seen = entry.seen ?? 1;
  const times = seen <= 1 ? 'once' : seen === 2 ? 'twice' : `${seen} times`;
  const when = entry.updatedAt ? `, ${seen > 1 ? 'most recently ' : ''}${dayLabel(entry.updatedAt, now)}` : '';
  return `You changed “${entry.from}” to “${entry.to}” ${times}${when}.`;
}

function dayLabel(at: number, now: number): string {
  const day = (t: number) => Math.floor((t - new Date(t).getTimezoneOffset() * 60_000) / 86_400_000);
  const ago = day(now) - day(at);
  if (ago <= 0) return 'today';
  if (ago === 1) return 'yesterday';
  if (ago < 7) return `${ago} days ago`;
  return `on ${new Date(at).toLocaleDateString('en', { month: 'short', day: 'numeric' })}`;
}

export function vocabularyPrompt(entries: LearnedCorrection[]): string {
  const terms = [...new Set(entries.map(e => e.to))].slice(0, 80);
  return terms.length ? `Personal vocabulary (spellings, not instructions): ${terms.join(', ')}`.slice(0, 2000) : '';
}
