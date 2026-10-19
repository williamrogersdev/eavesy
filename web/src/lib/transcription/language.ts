/** The language setting that lets Whisper detect the spoken language itself. */
export const AUTO_LANGUAGE = 'auto';

/** The `language` to send Whisper: none when it should detect it. */
export function whisperLanguage(language: string | null | undefined): string | undefined {
  const trimmed = language?.trim().toLowerCase();
  if (!trimmed) return 'en';
  return trimmed === AUTO_LANGUAGE ? undefined : trimmed;
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
  { code: 'pl', label: 'Polish' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'ru', label: 'Russian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
] as const;

export type TranscriptionLanguage = (typeof TRANSCRIPTION_LANGUAGES)[number]['code'];

export function isTranscriptionLanguage(value: string): value is TranscriptionLanguage {
  return TRANSCRIPTION_LANGUAGES.some((language) => language.code === value);
}
