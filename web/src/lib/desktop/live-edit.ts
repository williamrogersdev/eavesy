/** User corrections win conflicts; untouched recognition can still settle or grow. */
export interface TranscriptEdit { source: string; text: string }
interface Patch { start: number; end: number; text: string }
const tokens = (text: string) => text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];

function changes(base: string[], next: string[]): Patch[] {
  let prefix = 0;
  while (prefix < base.length && prefix < next.length && base[prefix] === next[prefix]) prefix++;
  let end = base.length, nextEnd = next.length;
  let suffix = 0;
  while (end - suffix > prefix && nextEnd - suffix > prefix && base[end - suffix - 1] === next[nextEnd - suffix - 1]) suffix++;
  // A lone trailing period must not anchor to the end of a newer sentence.
  if (suffix >= 8 || base.length === next.length) { end -= suffix; nextEnd -= suffix; }
  const n = end - prefix, m = nextEnd - prefix;
  if (!n && !m) return [];
  // Bound work for very large replacements; retaining a user's correction is
  // preferable to blocking typing while trying to resolve an ambiguous rewrite.
  if (!n || !m || n * m > 1_000_000) return [{ start: prefix, end, text: next.slice(prefix, nextEnd).join('') }];
  const width = m + 1;
  const distance = new Uint32Array((n + 1) * width);
  for (let i = 0; i <= n; i++) distance[i * width + m] = n - i;
  for (let j = 0; j <= m; j++) distance[n * width + j] = m - j;
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    distance[i * width + j] = base[prefix + i] === next[prefix + j]
      ? distance[(i + 1) * width + j + 1]
      : 1 + Math.min(distance[(i + 1) * width + j + 1], distance[(i + 1) * width + j], distance[i * width + j + 1]);
  }
  const result: Patch[] = [];
  let i = 0, j = 0, patch: Patch | null = null;
  while (i < n || j < m) {
    if (i < n && j < m && base[prefix + i] === next[prefix + j]) {
      if (patch) { result.push(patch); patch = null; }
      i++; j++;
    } else {
      patch ??= { start: prefix + i, end: prefix + i, text: '' };
      if (i < n && j < m && distance[(i + 1) * width + j + 1] <= Math.min(distance[(i + 1) * width + j], distance[i * width + j + 1])) {
        patch.text += next[prefix + j++]; patch.end = prefix + ++i;
      } else if (j < m && (i === n || distance[i * width + j + 1] < distance[(i + 1) * width + j])) patch.text += next[prefix + j++];
      else { i++; patch.end = prefix + i; }
    }
  }
  if (patch) result.push(patch);
  return result;
}

function overlaps(a: Patch, b: Patch): boolean {
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

export function mergeTranscript(edit: TranscriptEdit, incoming: string): string {
  if (incoming === edit.source || incoming === edit.text) return edit.text;
  if (edit.text === edit.source) return incoming;
  const base = tokens(edit.source);
  const user = changes(base, tokens(edit.text));
  const speech = changes(base, tokens(incoming)).flatMap(patch => {
    if (user.some(own => overlaps(patch, own))) return [];
    const sameInsertion = user.find(own => own.start === own.end && patch.start === patch.end && own.start === patch.start);
    if (sameInsertion) {
      if (sameInsertion.text.startsWith(patch.text)) return [];
      if (patch.text.startsWith(sameInsertion.text)) return [{ ...patch, text: patch.text.slice(sameInsertion.text.length) }];
    }
    return [patch];
  });
  const patches = [...user, ...speech].sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0, text = '';
  for (const patch of patches) {
    text += base.slice(cursor, patch.start).join('') + patch.text;
    cursor = patch.end;
  }
  return text + base.slice(cursor).join('');
}
