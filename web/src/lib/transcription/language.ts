/** The language setting that lets Whisper detect the spoken language itself. */
export const AUTO_LANGUAGE = 'auto';

/**
 * Below this Whisper is guessing: short or noisy clips, accented speech, and
 * near neighbours (Spanish and Galician, Norwegian and Danish) land here.
 */
export const CONFIDENT_DETECTION = 0.6;

/** The `language` to send Whisper: none when it should detect it. */
export function whisperLanguage(language: string | null | undefined): string | undefined {
  const trimmed = language?.trim().toLowerCase();
  if (!trimmed || trimmed === AUTO_LANGUAGE) return undefined;
  return trimmed;
}

/** The languages offered in Settings, as Whisper's ISO 639-1 codes. */
export const TRANSCRIPTION_LANGUAGES = [
  { code: AUTO_LANGUAGE, label: 'Detect automatically' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'sv', label: 'Swedish' },
  { code: 'da', label: 'Danish' },
  { code: 'no', label: 'Norwegian' },
  { code: 'fi', label: 'Finnish' },
  { code: 'pl', label: 'Polish' },
  { code: 'cs', label: 'Czech' },
  { code: 'sk', label: 'Slovak' },
  { code: 'hu', label: 'Hungarian' },
  { code: 'ro', label: 'Romanian' },
  { code: 'bg', label: 'Bulgarian' },
  { code: 'hr', label: 'Croatian' },
  { code: 'sr', label: 'Serbian' },
  { code: 'el', label: 'Greek' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'ru', label: 'Russian' },
  { code: 'ca', label: 'Catalan' },
  { code: 'tr', label: 'Turkish' },
  { code: 'he', label: 'Hebrew' },
  { code: 'ar', label: 'Arabic' },
  { code: 'fa', label: 'Persian' },
  { code: 'ur', label: 'Urdu' },
  { code: 'hi', label: 'Hindi' },
  { code: 'bn', label: 'Bengali' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'mr', label: 'Marathi' },
  { code: 'th', label: 'Thai' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ms', label: 'Malay' },
  { code: 'tl', label: 'Tagalog' },
  { code: 'sw', label: 'Swahili' },
  { code: 'zh', label: 'Chinese' },
  { code: 'yue', label: 'Cantonese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
] as const;

export type TranscriptionLanguage = (typeof TRANSCRIPTION_LANGUAGES)[number]['code'];

export function isTranscriptionLanguage(value: string): value is TranscriptionLanguage {
  return TRANSCRIPTION_LANGUAGES.some((language) => language.code === value);
}

/** Languages notes can be written in and transcripts translated to: every fixed one. */
export const NOTES_LANGUAGES = TRANSCRIPTION_LANGUAGES.filter((language) => language.code !== AUTO_LANGUAGE);

export function isNotesLanguage(value: string): boolean {
  return NOTES_LANGUAGES.some((language) => language.code === value);
}

/** The English name of a Whisper language code, falling back to the code itself. */
export function languageName(code: string | null | undefined): string {
  if (!code) return '';
  const listed = TRANSCRIPTION_LANGUAGES.find((language) => language.code === code);
  if (listed) return listed.label;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * A language the user doesn't speak needs this much certainty to be kept:
 * accented English heard as Welsh or Dutch usually lands well below it.
 */
export const CONFIDENT_OUTSIDE_SPOKEN = 0.85;

/** Most people record in one or two languages; a few more covers everyone else. */
export const MAX_SPOKEN_LANGUAGES = 5;

/**
 * When Whisper detected the language itself, whether to transcribe the clip
 * again in a likelier one. A confident switch is kept, since people do change
 * language mid-call. An unsure detection is retried in the language the
 * meeting has been in so far, and one outside the languages the user speaks
 * must be near certain, else it is retried in the one of theirs most likely.
 */
export function retryLanguage(opts: {
  setting: string | null | undefined;
  detected: string | undefined;
  probability: number | undefined;
  established: string | null | undefined;
  spoken?: readonly string[];
}): string | undefined {
  if (whisperLanguage(opts.setting) || !opts.detected || opts.probability === undefined) return undefined;
  const established = opts.established?.trim().toLowerCase() || undefined;
  if (established === opts.detected) return undefined;
  const spoken = opts.spoken ?? [];
  if (spoken.length > 0 && !spoken.includes(opts.detected) && opts.probability < CONFIDENT_OUTSIDE_SPOKEN) {
    return established ?? spoken[0];
  }
  if (!established || opts.probability >= CONFIDENT_DETECTION) return undefined;
  return established;
}

/** Offered languages only, without repeats, in the order given. */
export function normalizeSpokenLanguages(codes: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of codes) {
    if (typeof raw !== 'string') continue;
    const code = raw.trim().toLowerCase();
    if (!isNotesLanguage(code) || out.includes(code)) continue;
    out.push(code);
    if (out.length >= MAX_SPOKEN_LANGUAGES) break;
  }
  return out;
}

export function parseSpokenLanguages(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? normalizeSpokenLanguages(parsed) : [];
  } catch {
    return [];
  }
}

/**
 * The languages a user speaks: the ones they chose, else the fixed language
 * they used to transcribe in, else none (detect anything).
 */
export function spokenLanguages(user: {
  spokenLanguagesJson?: string | null;
  defaultLanguage?: string | null;
}): string[] {
  const chosen = parseSpokenLanguages(user.spokenLanguagesJson);
  if (chosen.length > 0) return chosen;
  const fixed = whisperLanguage(user.defaultLanguage);
  return fixed && isNotesLanguage(fixed) ? [fixed] : [];
}

/** The offered languages among a browser's preferences, e.g. ['en-GB', 'es-419'] → ['en', 'es']. */
export function languagesFromLocales(locales: readonly string[]): string[] {
  return normalizeSpokenLanguages(
    locales.map((locale) => {
      const code = locale.split('-')[0]?.toLowerCase() ?? '';
      return code === 'nb' || code === 'nn' ? 'no' : code;
    }),
  );
}

/** The language most of these lines were heard in, if any were labelled. */
export function dominantLanguage(lines: readonly { language?: string | null; text?: string }[]): string | undefined {
  const weight = new Map<string, number>();
  for (const line of lines) {
    if (!line.language) continue;
    weight.set(line.language, (weight.get(line.language) ?? 0) + Math.max(1, line.text?.length ?? 1));
  }
  let best: string | undefined;
  let bestWeight = 0;
  for (const [language, w] of weight) {
    if (w > bestWeight) {
      best = language;
      bestWeight = w;
    }
  }
  return best;
}

/** The prompt rule for which language notes are written in. */
export function notesLanguageRule(notesLanguage: string | null | undefined): string {
  const code = notesLanguage?.trim().toLowerCase();
  if (code && code !== AUTO_LANGUAGE) {
    return `Write every text field, chapter titles included, in ${languageName(code)}, translating from the transcript wherever it is in another language. Keep names, product terms and short quotes as spoken.`;
  }
  return 'Write every text field, chapter titles included, in the language most of the meeting was spoken in. When several languages were spoken, still use only that one.';
}
