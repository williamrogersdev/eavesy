import { cleanList } from '@/lib/projects';

/** The list with every comma-separated term in `raw` added, or null when `raw` has none. */
export function addTerms(list: readonly string[], raw: string, max: number): string[] | null {
  const terms = raw.split(',').map((term) => term.trim()).filter(Boolean);
  if (terms.length === 0) return null;
  return cleanList([...list, ...terms], max);
}

/** Typing a comma commits what came before it; anything else just updates the draft. */
export function typeDraft(list: readonly string[], text: string, max: number): { list: string[] | null; draft: string } {
  if (!text.endsWith(',')) return { list: null, draft: text };
  const next = addTerms(list, text, max);
  return { list: next, draft: next ? '' : text.slice(0, -1) };
}

/** Enter commits the draft; Backspace in an empty draft removes the last term. */
export function keyDraft(
  list: readonly string[],
  draft: string,
  key: string,
  max: number,
): { list: string[] | null; draft: string; handled: boolean } {
  if (key === 'Enter') {
    const next = addTerms(list, draft, max);
    return { list: next, draft: next ? '' : draft, handled: true };
  }
  if (key === 'Backspace' && !draft && list.length > 0) return { list: list.slice(0, -1), draft, handled: false };
  return { list: null, draft, handled: false };
}
