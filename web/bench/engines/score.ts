export interface Turn {
  speaker: string | null;
  text: string;
}

export interface WordErrors {
  errors: number;
  refWords: number;
  hypWords: number;
  substitutions: number;
  deletions: number;
  insertions: number;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function spelled(token: string): string[] {
  if (!/^\d{1,2}$/.test(token)) return [token];
  const n = Number(token);
  if (n < 20) return [ONES[n]];
  return n % 10 === 0 ? [TENS[n / 10]] : [TENS[Math.floor(n / 10)], ONES[n % 10]];
}

/** Lowercase words without punctuation, apostrophes or hyphens, with 0 to 99 spelled out, so "5" and "five" match. */
export function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d)[:.,](\d)/g, '$1 $2')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .flatMap(spelled);
}

/** Edit distance over words, two rows at a time so an hour-long recording needs kilobytes, not a full table. */
export function wordErrors(ref: readonly string[], hyp: readonly string[]): WordErrors {
  const cols = hyp.length + 1;
  const row = () => ({ cost: new Uint32Array(cols), sub: new Uint32Array(cols), del: new Uint32Array(cols), ins: new Uint32Array(cols) });
  let prev = row();
  let next = row();
  for (let j = 0; j < cols; j += 1) {
    prev.cost[j] = j;
    prev.ins[j] = j;
  }
  for (let i = 1; i <= ref.length; i += 1) {
    next.cost[0] = i;
    next.sub[0] = 0;
    next.del[0] = i;
    next.ins[0] = 0;
    for (let j = 1; j < cols; j += 1) {
      const same = ref[i - 1] === hyp[j - 1];
      const diagonal = prev.cost[j - 1] + (same ? 0 : 1);
      const deletion = prev.cost[j] + 1;
      const insertion = next.cost[j - 1] + 1;
      if (diagonal <= deletion && diagonal <= insertion) {
        next.cost[j] = diagonal;
        next.sub[j] = prev.sub[j - 1] + (same ? 0 : 1);
        next.del[j] = prev.del[j - 1];
        next.ins[j] = prev.ins[j - 1];
      } else if (deletion <= insertion) {
        next.cost[j] = deletion;
        next.sub[j] = prev.sub[j];
        next.del[j] = prev.del[j] + 1;
        next.ins[j] = prev.ins[j];
      } else {
        next.cost[j] = insertion;
        next.sub[j] = next.sub[j - 1];
        next.del[j] = next.del[j - 1];
        next.ins[j] = next.ins[j - 1] + 1;
      }
    }
    [prev, next] = [next, prev];
  }
  const last = cols - 1;
  return { errors: prev.cost[last], refWords: ref.length, hypWords: hyp.length, substitutions: prev.sub[last], deletions: prev.del[last], insertions: prev.ins[last] };
}

function bySpeaker(turns: readonly Turn[]): string[][] {
  const grouped = new Map<string, string[]>();
  for (const turn of turns) {
    const key = turn.speaker ?? '';
    grouped.set(key, [...(grouped.get(key) ?? []), ...words(turn.text)]);
  }
  return [...grouped.values()].filter((group) => group.length > 0);
}

/**
 * Concatenated minimum-permutation WER: each reference speaker's words are
 * matched to one recognized speaker's words, picking the pairing with the
 * fewest errors. Words given to a speaker nobody is paired with all count.
 */
export function cpErrors(ref: readonly Turn[], hyp: readonly Turn[]): WordErrors & { refSpeakers: number; hypSpeakers: number } {
  const refs = bySpeaker(ref);
  const hyps = bySpeaker(hyp);
  // Recognized speakers are bits of a 32-bit mask. Capping them at 12 keeps the
  // memo to 2^12 masks per reference speaker; references name only a handful.
  if (hyps.length > 12) throw new Error(`too many recognized speakers to pair: ${hyps.length}`);
  const pair = refs.map((r) => hyps.map((h) => wordErrors(r, h)));
  const memo = new Map<string, { errors: number; picks: number[] }>();
  const best = (i: number, used: number): { errors: number; picks: number[] } => {
    const key = `${i}:${used}`;
    const known = memo.get(key);
    if (known) return known;
    let result: { errors: number; picks: number[] };
    if (i === refs.length) {
      const errors = hyps.reduce((sum, h, j) => sum + (used & (1 << j) ? 0 : h.length), 0);
      result = { errors, picks: [] };
    } else {
      const rest = best(i + 1, used);
      result = { errors: refs[i].length + rest.errors, picks: [-1, ...rest.picks] };
      for (let j = 0; j < hyps.length; j += 1) {
        if (used & (1 << j)) continue;
        const next = best(i + 1, used | (1 << j));
        const errors = pair[i][j].errors + next.errors;
        if (errors < result.errors) result = { errors, picks: [j, ...next.picks] };
      }
    }
    memo.set(key, result);
    return result;
  };
  const { picks } = best(0, 0);
  const total = { errors: 0, refWords: 0, hypWords: 0, substitutions: 0, deletions: 0, insertions: 0 };
  const paired = new Set<number>();
  refs.forEach((r, i) => {
    const j = picks[i];
    const part = j >= 0 ? pair[i][j] : wordErrors(r, []);
    if (j >= 0) paired.add(j);
    for (const k of Object.keys(total) as (keyof WordErrors)[]) total[k] += part[k];
  });
  hyps.forEach((h, j) => {
    if (paired.has(j)) return;
    total.errors += h.length;
    total.insertions += h.length;
    total.hypWords += h.length;
  });
  return { ...total, refSpeakers: refs.length, hypSpeakers: hyps.length };
}

/** Plain lines, or `Name: words` on every line for a speaker-labelled reference. */
export function parseReference(text: string): Turn[] {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const labelled = lines.length > 0 && lines.every((line) => /^[^:]{1,40}:\s/.test(line));
  return lines.map((line) => {
    if (!labelled) return { speaker: null, text: line };
    const at = line.indexOf(':');
    return { speaker: line.slice(0, at).trim(), text: line.slice(at + 1).trim() };
  });
}
