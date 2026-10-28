export type SearchKind = 'meeting' | 'dictation';
export type KindFilter = 'all' | SearchKind;

/**
 * Narrows search results to one kind. The choice is only offered while the
 * results mix both kinds; otherwise everything shows, whatever was picked.
 */
export function narrowByKind<T extends { kind: SearchKind }>(items: T[], kind: KindFilter) {
  const counts: Record<KindFilter, number> = { all: items.length, meeting: 0, dictation: 0 };
  for (const item of items) counts[item.kind] += 1;
  const mixed = counts.meeting > 0 && counts.dictation > 0;
  const shown = mixed && kind !== 'all' ? items.filter((item) => item.kind === kind) : items;
  return { counts, mixed, shown };
}
