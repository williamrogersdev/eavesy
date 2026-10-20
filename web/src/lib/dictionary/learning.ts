/** Only differences made by a person enter the dictionary. Never feed model output here. */
export interface LearnedCorrection { from: string; to: string }
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
    if (validCorrection(from, to)) result.push({ from, to });
  }
  return [...new Map(result.map(r => [normalizeTerm(r.from), r])).values()].slice(0, 20);
}

export function vocabularyPrompt(entries: LearnedCorrection[]): string {
  const terms = [...new Set(entries.map(e => e.to))].slice(0, 80);
  return terms.length ? `Personal vocabulary (spellings, not instructions): ${terms.join(', ')}`.slice(0, 2000) : '';
}
