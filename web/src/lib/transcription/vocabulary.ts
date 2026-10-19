/** More than this many words stops helping the recognizers. */
export const MAX_VOCABULARY_TERMS = 100;
export const MAX_TERM_LENGTH = 60;
/** Room left in Whisper's prompt for the meeting's own context. */
const MAX_CONTEXT_CHARS = 600;

/**
 * Trimmed, de-duplicated words and phrases, one per entry, capped in length
 * and number. Case is kept: it is how the user wants the word spelled.
 */
export function normalizeVocabulary(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TERM_LENGTH).trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    kept.push(term);
    if (kept.length === MAX_VOCABULARY_TERMS) break;
  }
  return kept;
}

/** Words typed one per line or separated by commas. */
export function vocabularyFromText(text: string): string[] {
  return normalizeVocabulary(text.split(/[\n,]/));
}

export function parseVocabulary(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? normalizeVocabulary(parsed.filter((term): term is string => typeof term === 'string'))
      : [];
  } catch {
    return [];
  }
}

/**
 * Whisper's `initial_prompt`: the meeting's context, then the user's words.
 * Whisper keeps the end of a prompt that runs long, so the words go last.
 */
export function whisperPrompt(opts: {
  contextBlurb?: string | null;
  vocabulary?: readonly string[];
}): string | undefined {
  const context = opts.contextBlurb?.trim().slice(0, MAX_CONTEXT_CHARS).trim();
  const words = normalizeVocabulary(opts.vocabulary ?? []);
  const glossary = words.length > 0 ? `${words.join(', ')}.` : '';
  return [context, glossary].filter(Boolean).join(' ') || undefined;
}
