import { isPlainWords, type LearnedCorrection } from '@/lib/dictionary/learning';

/**
 * How alike, 0–1, the words heard and a dictionary term must be for a rewrite
 * to have put the term in their place: the on-device speller's bar.
 */
const LIKENESS = 0.6;
/** Heard words more than this many times longer or shorter than the term are a different word. */
const LENGTH_RATIO = 1.75;
/**
 * Short words share letters by chance ("just" and "rust" score 0.75), so a
 * sound-alike that starts with another letter must be closer than that
 * ("konvex" for "convex" is 0.83).
 */
const OTHER_START_LIKENESS = 0.8;

function soundsLike(heard: string, key: string): boolean {
  const score = likeness(heard, key);
  return score >= (heard[0] === key[0] ? LIKENESS : OTHER_START_LIKENESS);
}

const NUMBERS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};

const wordsOf = (text: string) => text.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? [];
/** As said: "one DB" is "1db", "re packify" is "repackify". */
const spoken = (words: readonly string[]) => words.map((word) => NUMBERS[word] ?? word).join('');

/** Characters in common, in order, against both lengths (0–1). Matches `Speller.likeness`. */
export function likeness(a: string, b: string): number {
  if (!a || !b || Math.max(a.length, b.length) > LENGTH_RATIO * Math.min(a.length, b.length)) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const current = [0];
    for (let j = 0; j < b.length; j++) current.push(x === b[j] ? previous[j] + 1 : Math.max(previous[j + 1], current[j]));
    previous = current;
  }
  return (2 * previous[b.length]) / (a.length + b.length);
}

function count(text: string, term: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return text.match(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'))?.length ?? 0;
}

/** Runs of heard words that sound like `term`, none sharing a word: how many times it may have been said. */
function soundAlikes(heard: readonly string[], term: string): number {
  const key = spoken(wordsOf(term));
  const span = Math.max(1, wordsOf(term).length) + 1;
  let found = 0;
  for (let i = 0; i < heard.length; ) {
    let matched = 0;
    for (let n = 1; n <= span && i + n <= heard.length; n++) {
      if (soundsLike(spoken(heard.slice(i, i + n)), key)) { matched = n; break; }
    }
    if (matched) found++;
    i += matched || 1;
  }
  return found;
}

/**
 * Dictionary terms a rewrite wrote more often than the speaker could have said
 * them. A recognizer only mishears a word as something that sounds like it, so
 * each extra "Repackify" must stand where the heard words sound like it ("re
 * packify", "repack of"), or where a confirmed fix's words were heard. A term
 * the model dropped in over unrelated words ("we'll check" → "Repackify") is
 * the dictionary taking over, and the rewrite is not used.
 *
 * Everyday words in the dictionary ("box", "design") are left out: a rewrite
 * may use those freely.
 */
export function inventedTerms(
  said: string,
  candidate: string,
  terms: readonly string[],
  corrections: readonly LearnedCorrection[] = [],
): string[] {
  const heard = wordsOf(said);
  const seen = new Set<string>();
  const invented: string[] = [];
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, ' ').trim();
    const key = term.toLocaleLowerCase('en');
    if (!term || seen.has(key) || wordsOf(term).length === 0 || isPlainWords(term)) continue;
    seen.add(key);
    const extra = count(candidate, term) - count(said, term);
    if (extra <= 0) continue;
    const fixed = corrections
      .filter((fix) => fix.to.trim().toLocaleLowerCase('en') === key && wordsOf(fix.from).length > 0)
      .reduce((sum, fix) => sum + count(said, fix.from), 0);
    // Heard as itself counts among the sound-alikes, and was already in `said`'s own count.
    if (extra > fixed + Math.max(0, soundAlikes(heard, term) - count(said, term))) invented.push(term);
  }
  return invented;
}
