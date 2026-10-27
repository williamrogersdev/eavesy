/** What the Mac reports after it sends a correction to the dictionary (`dictionary:learning`). */
export interface LearningEvent {
  status: string;
  message?: string;
  learned?: number;
  words?: { from: string; to: string }[] | null;
}

/** A short confirmation naming the word that was learned, or null when nothing new was saved. */
export function learnedLabel(event: LearningEvent): string | null {
  if (event.status !== 'saved') return null;
  const words = Array.isArray(event.words) ? event.words.filter((word) => word?.to?.trim()) : [];
  const count = Math.max(event.learned ?? 0, words.length);
  if (count === 0) return null;
  const first = words[0]?.to.trim();
  if (!first) return `Learned ${count} correction${count === 1 ? '' : 's'}`;
  return count > 1 ? `Added “${first}” +${count - 1}` : `Added “${first}”`;
}
