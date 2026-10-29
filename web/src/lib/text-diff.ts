/**
 * A word-level diff for previewing a rewrite before it's applied. Common start
 * and end are matched first; the middle is a longest-common-subsequence, or
 * one removed-and-added block when it is too big to compare cheaply.
 */

export interface DiffPart { type: 'same' | 'add' | 'del'; text: string }

/** Middles larger than this many word pairs are shown as one replaced block. */
const MAX_CELLS = 1_000_000;

/** Words with the whitespace after them, so joining the parts gives the text back. */
function tokens(text: string): string[] {
  return text.match(/\s+|[^\s]+\s*/g) ?? [];
}

function push(parts: DiffPart[], type: DiffPart['type'], text: string) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last?.type === type) last.text += text;
  else parts.push({ type, text });
}

export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const parts: DiffPart[] = [];
  push(parts, 'same', a.slice(0, start).join(''));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) {
    push(parts, 'del', midA.join(''));
    push(parts, 'add', midB.join(''));
  } else {
    // lcs[i][j]: the longest common run of midA[i..] and midB[j..].
    const width = midB.length + 1;
    const lcs = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        lcs[i * width + j] = midA[i] === midB[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) { push(parts, 'same', midA[i]); i++; j++; }
      else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) { push(parts, 'del', midA[i]); i++; }
      else { push(parts, 'add', midB[j]); j++; }
    }
    push(parts, 'del', midA.slice(i).join(''));
    push(parts, 'add', midB.slice(j).join(''));
  }
  push(parts, 'same', a.slice(endA).join(''));
  return parts;
}
