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
/**
 * Word pairs the alignment may compare, after the shared start and end are
 * set aside: about 1,400 words each way, or nine minutes of speech. Past it
 * the check counts terms over the whole text instead of place by place.
 */
const MAX_ALIGN_CELLS = 2_000_000;

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

function soundsLike(heard: string, key: string): boolean {
  return likeness(heard, key) >= (heard[0] === key[0] ? LIKENESS : OTHER_START_LIKENESS);
}

/** How many times `phrase` stands as whole words in `text`, any case: "pool" is not in "carpool". */
export function count(text: string, phrase: string): number {
  if (!phrase.trim()) return 0;
  const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return text.match(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'))?.length ?? 0;
}

type Span = [start: number, end: number];

/** Runs of `words`, none sharing a word, that `matches`, longest first at each start. */
function runs(words: readonly string[], longest: number, matches: (run: readonly string[]) => boolean): Span[] {
  const found: Span[] = [];
  for (let i = 0; i < words.length; ) {
    let end = 0;
    for (let n = Math.min(longest, words.length - i); n >= 1 && !end; n--) if (matches(words.slice(i, i + n))) end = i + n;
    if (end) found.push([i, end]);
    i = end || i + 1;
  }
  return found;
}

/** Where the term itself is written: "Gaylord Boxes", "gaylord boxes", "One DB" for "1db". */
const writtenAs = (words: readonly string[], key: string, length: number) =>
  runs(words, length + 1, (run) => spoken(run) === key);

/** Where the heard words sound like the term: "repack of", "re packify", "konvex". */
const soundAlikes = (words: readonly string[], key: string, length: number) =>
  runs(words, length + 1, (run) => soundsLike(spoken(run), key));

/** A stretch the rewrite changed: heard words `heard` became written words `written`. */
interface Change { heard: Span; written: Span }

/**
 * The stretches where the rewrite's words differ from what was heard, in
 * order, from the longest run of words the two share. Null when the texts are
 * too long to compare word by word.
 */
function changes(heard: readonly string[], written: readonly string[]): Change[] | null {
  let lead = 0;
  while (lead < heard.length && lead < written.length && heard[lead] === written[lead]) lead++;
  let tail = 0;
  while (tail < heard.length - lead && tail < written.length - lead && heard[heard.length - 1 - tail] === written[written.length - 1 - tail]) tail++;
  const a = heard.slice(lead, heard.length - tail), b = written.slice(lead, written.length - tail);
  if ((a.length + 1) * (b.length + 1) > MAX_ALIGN_CELLS) return null;
  // Longest common run of words, filled from the end so it reads forwards.
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out: Change[] = [];
  let i = 0, j = 0, fromI = 0, fromJ = 0;
  const close = () => {
    if (i > fromI || j > fromJ) out.push({ heard: [lead + fromI, lead + i], written: [lead + fromJ, lead + j] });
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      close();
      i++; j++;
      fromI = i; fromJ = j;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  i = a.length; j = b.length;
  close();
  return out;
}

/**
 * Dictionary terms a rewrite wrote where the speaker didn't say them. A
 * recognizer only mishears a word as something that sounds like it, so each
 * "Repackify" the rewrite adds must stand where it changed heard words that
 * sound like it ("re packify", "repack of") or a confirmed fix's words. One
 * dropped in over unrelated words ("we'll check" → "Repackify"), or over
 * words that sound like it somewhere else, is the dictionary taking over, and
 * the rewrite is not used.
 *
 * Everyday words in the dictionary ("code", "notes") are left out, and so are
 * terms with fewer than two letters or digits ("C#"): the words alone can't
 * tell those apart.
 */
export function inventedTerms(
  said: string,
  candidate: string,
  terms: readonly string[],
  corrections: readonly LearnedCorrection[] = [],
): string[] {
  const heard = wordsOf(said), written = wordsOf(candidate);
  let changed: Change[] | null | undefined;
  const seen = new Set<string>();
  const invented: string[] = [];
  for (const term of terms) {
    const length = wordsOf(term).length;
    const key = spoken(wordsOf(term));
    if (key.length < 2 || seen.has(key) || isPlainWords(term)) continue;
    seen.add(key);
    const placed = writtenAs(written, key, length);
    if (placed.length <= writtenAs(heard, key, length).length) continue;
    const fixes = corrections
      .filter((fix) => spoken(wordsOf(fix.to)) === key)
      .map((fix) => wordsOf(fix.from))
      .filter((words) => words.length > 0);
    const funded = (words: readonly string[]) =>
      soundAlikes(words, key, length).length
      + fixes.reduce((sum, from) => sum + runs(words, from.length, (run) => run.length === from.length && run.every((word, k) => word === from[k])).length, 0);

    changed ??= changes(heard, written);
    if (!changed) {
      // Too long to place: the whole text must have said it as often.
      if (placed.length > funded(heard)) invented.push(term);
      continue;
    }
    // Each change can hold as many of the term as its heard words sound like it.
    const used = new Map<Change, number>();
    const inChange = (span: Span) =>
      changed!.find((change) => span[0] < change.written[1] && span[1] > change.written[0]);
    for (const span of placed) {
      const change = inChange(span);
      if (!change) continue; // Kept word for word from what was heard.
      const room = funded(heard.slice(change.heard[0], change.heard[1]));
      const taken = used.get(change) ?? 0;
      if (taken >= room) {
        invented.push(term);
        break;
      }
      used.set(change, taken + 1);
    }
  }
  return invented;
}
