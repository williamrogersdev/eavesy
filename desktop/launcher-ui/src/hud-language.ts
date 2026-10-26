import { LANGUAGES, isLanguage, languageName, type Language } from '@/lib/translation/languages';

/** Where the drawer keeps the languages last translated to, newest first. */
export const RECENT_LANGUAGES_KEY = 'eavesy.hud.recentLanguages';
/** How many recent languages lead the list: enough for "mine and English" and a couple more. */
export const MAX_RECENT_LANGUAGES = 4;

/**
 * The languages to offer for `query`, best first. Empty, the recent ones lead
 * and the rest follow in the usual order. Typed, names that start with it come
 * before names that only contain it, and a language code matches exactly
 * ("pt", "zh"), so a language is a couple of keystrokes away.
 */
export function findLanguages(query: string, recent: readonly Language[] = []): Language[] {
  const q = query.trim().toLowerCase();
  const all = LANGUAGES.map(([code]) => code);
  if (!q) return [...recent.filter(isLanguage), ...all.filter((code) => !recent.includes(code))];
  const rank = (code: Language): number => {
    const name = languageName(code).toLowerCase();
    if (code === q || name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.split(/[\s()]+/).some((word) => word.startsWith(q))) return 2;
    if (name.includes(q)) return 3;
    return -1;
  };
  return all
    .map((code) => ({ code, rank: rank(code), recent: recent.includes(code) }))
    .filter((match) => match.rank >= 0)
    .sort((a, b) => a.rank - b.rank || Number(b.recent) - Number(a.recent))
    .map((match) => match.code);
}

/** `recent` with `language` first, without repeats, capped. */
export function rememberLanguage(recent: readonly Language[], language: Language): Language[] {
  return [language, ...recent.filter((code) => code !== language)].slice(0, MAX_RECENT_LANGUAGES);
}

/** The recent languages this Mac kept, or none when storage is unavailable. */
export function loadRecentLanguages(): Language[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_LANGUAGES_KEY) ?? '[]');
    return Array.isArray(raw) ? [...new Set(raw.filter(isLanguage))].slice(0, MAX_RECENT_LANGUAGES) : [];
  } catch {
    return [];
  }
}

export function saveRecentLanguages(recent: readonly Language[]): void {
  try { localStorage.setItem(RECENT_LANGUAGES_KEY, JSON.stringify(recent)); } catch { /* a convenience only */ }
}
