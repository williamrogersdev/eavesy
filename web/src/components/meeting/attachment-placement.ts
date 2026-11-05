/**
 * Where each picture sits in the transcript: after the last line that started
 * at or before it. Key -1 holds the ones taken before the first line.
 * `lines` and `attachments` need not be sorted; each group keeps time order.
 */
export function placeAttachments<A extends { offsetMs: number }>(
  lines: readonly { startMs: number }[],
  attachments: readonly A[],
): Map<number, A[]> {
  const order = lines.map((line, index) => ({ startMs: line.startMs, index })).sort((a, b) => a.startMs - b.startMs);
  const placed = new Map<number, A[]>();
  for (const attachment of [...attachments].sort((a, b) => a.offsetMs - b.offsetMs)) {
    let at = -1;
    for (const line of order) {
      if (line.startMs > attachment.offsetMs) break;
      at = line.index;
    }
    placed.set(at, [...(placed.get(at) ?? []), attachment]);
  }
  return placed;
}
