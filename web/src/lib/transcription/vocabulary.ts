/** More than this many words stops helping the recognizers. */
export const MAX_VOCABULARY_TERMS = 100;
export const MAX_TERM_LENGTH = 60;
/**
 * Whisper reads about 224 tokens of prompt and keeps the end of a longer one.
 * The words get up to `MAX_GLOSSARY_CHARS` of that, whole words only, and the
 * meeting's context whatever is left.
 */
const MAX_PROMPT_CHARS = 800;
const MAX_GLOSSARY_CHARS = 500;

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
  const words: string[] = [];
  let glossaryChars = 1;
  for (const word of normalizeVocabulary(opts.vocabulary ?? [])) {
    const added = word.length + (words.length > 0 ? 2 : 0);
    if (glossaryChars + added > MAX_GLOSSARY_CHARS) break;
    words.push(word);
    glossaryChars += added;
  }
  const glossary = words.length > 0 ? `${words.join(', ')}.` : '';
  const room = MAX_PROMPT_CHARS - (glossary ? glossary.length + 1 : 0);
  const context = opts.contextBlurb?.trim().slice(0, room).trim();
  return [context, glossary].filter(Boolean).join(' ') || undefined;
}
