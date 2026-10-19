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
 * When Whisper detected the language itself, whether to transcribe the clip
 * again in the language the meeting has been in so far. A confident switch is
 * kept, since people do change language mid-call; an unsure one that
 * disagrees with the meeting is far more often a misdetection than a switch.
 */
export function retryLanguage(opts: {
  setting: string | null | undefined;
  detected: string | undefined;
  probability: number | undefined;
  established: string | null | undefined;
}): string | undefined {
  if (whisperLanguage(opts.setting)) return undefined;
  const established = opts.established?.trim().toLowerCase();
  if (!established || established === opts.detected) return undefined;
  if (opts.probability === undefined || opts.probability >= CONFIDENT_DETECTION) return undefined;
  return established;
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
