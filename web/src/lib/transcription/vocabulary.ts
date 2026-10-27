/** Kept per account. Each recognizer takes the newest that fit: Whisper a prompt's worth, the Mac 100. */
export const MAX_VOCABULARY_TERMS = 500;
export const MAX_TERM_LENGTH = 60;
/**
 * Whisper reads about 224 tokens of prompt and keeps the end of a longer one.
 * The budget is in characters, about 200 tokens of English; dense jargon or
 * other scripts tokenize longer, and then only the start of the context goes.
 * The words get up to `MAX_GLOSSARY_CHARS` of that, whole words only, and the
 * meeting's context whatever is left.
 */
const MAX_PROMPT_CHARS = 800;
const MAX_GLOSSARY_CHARS = 500;

/**
 * The app's own name. Every recognizer is told it ahead of the user's words,
 * so no cap can push it out, and nobody has to add it themselves.
 */
export const BUILT_IN_TERMS: readonly string[] = ['Eavesy'];

/**
 * How recognizers mishear the name. Only spellings that are no English word,
 * so "easy", "eves" and "Evie" are never touched. A neighbouring dot, slash,
 * at-sign or dash means a domain, path or handle, which is left as written.
 */
const MISHEARD_NAME =
  /(?<![\p{L}\p{N}@/._-])(?:eavesy|evesy|eavsy|eevesy|eevsy|eavesey|eavsey|eavesie|evesie|eevesie)(?![\p{L}\p{N}@/_-]|\.[\p{L}\p{N}])/giu;

/** The app's name spelled right wherever a recognizer clearly misheard it. */
export function fixBuiltInTerms(text: string): string {
  return text.replace(MISHEARD_NAME, BUILT_IN_TERMS[0]);
}

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
 * Whisper's `initial_prompt`: the meeting's context, then the built-in terms
 * and the user's words. Whisper keeps the end of a prompt that runs long, so
 * the words go last; the built-in terms lead them, so the budget never drops them.
 */
export function whisperPrompt(opts: {
  contextBlurb?: string | null;
  vocabulary?: readonly string[];
}): string | undefined {
  const words: string[] = [];
  let glossaryChars = 1;
  for (const word of normalizeVocabulary([...BUILT_IN_TERMS, ...(opts.vocabulary ?? [])])) {
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
