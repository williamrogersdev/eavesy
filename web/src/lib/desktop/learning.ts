/** What the Mac reports after it sends a correction to the dictionary (`dictionary:learning`). */
export interface LearningEvent {
  status: string;
  message?: string;
  learned?: number;
  /** `pending`: seen once, kept as a suggestion until it is made again or kept in Settings. */
  words?: { from: string; to: string; pending?: boolean }[] | null;
}

/** A short confirmation naming the word that was learned, or null when nothing new was saved. */
export function learnedLabel(event: LearningEvent): string | null {
  if (event.status !== 'saved') return null;
  const words = Array.isArray(event.words) ? event.words.filter((word) => word?.to?.trim()) : [];
  const count = Math.max(event.learned ?? 0, words.length);
  if (count === 0) return null;
  const first = words[0]?.to.trim();
  if (!first) return `Learned ${count} correction${count === 1 ? '' : 's'}`;
  const verb = words.every((word) => word.pending) ? 'Suggested' : 'Added';
  return count > 1 ? `${verb} “${first}” +${count - 1}` : `${verb} “${first}”`;
}
