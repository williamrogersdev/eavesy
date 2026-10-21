/** Shared, explicit choices for speech recognition and translated output. */
import { NOTES_LANGUAGES } from '@/lib/transcription/language';
export const LANGUAGES = NOTES_LANGUAGES.map(({ code, label }) => [code, label] as const);
export type Language = typeof LANGUAGES[number][0];
export type SourceLanguage = Language | 'auto';
export const MAX_TRANSLATION_TEXT = 4000;
export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some(([code]) => code === value);
}
export function languageName(code: SourceLanguage): string {
  return code === 'auto' ? 'Detect language' : LANGUAGES.find(([id]) => id === code)![1];
}
export interface TranslationResult { text: string; translation: string; target: Language }
