/** A span of meeting time, in ms from the start of the recording. */
export interface TranscriptRange {
  fromMs: number;
  toMs: number;
}

export function mergeRanges(ranges: TranscriptRange[]): TranscriptRange[] {
  const sorted = [...ranges].sort((a, b) => a.fromMs - b.fromMs);
  const merged: TranscriptRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, range.toMs);
    else merged.push({ ...range });
  }
  return merged;
}

/** Whether a line belongs to a range. Server and clients must agree on this. */
export function inRange(line: { startMs: number; endMs: number }, range: TranscriptRange) {
  return line.endMs >= range.fromMs && line.startMs <= range.toMs;
}

/** Applies a delta to lines a client already holds, keeping them in time order. */
export function applyTranscriptDelta<L extends { id: string; startMs: number; endMs: number }>(
  held: L[],
  delta: { ranges: TranscriptRange[]; lines: L[] },
): L[] {
  if (delta.ranges.length === 0) return held;
  const kept = held.filter((line) => !delta.ranges.some((range) => inRange(line, range)));
  const incoming = new Set(delta.lines.map((line) => line.id));
  return [...kept.filter((line) => !incoming.has(line.id)), ...delta.lines].sort(
    (a, b) => a.startMs - b.startMs,
  );
}
