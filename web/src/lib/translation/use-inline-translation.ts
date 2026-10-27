import { useCallback, useEffect, useRef, useState } from 'react';
import { errMsg } from '@/lib/desktop/errors';
import { requestTranslation } from './client';
import { type Language } from './languages';

/** Split at natural boundaries without losing a single source character. */
export function translationChunks(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 4000) {
    const candidate = rest.slice(0, 4000);
    const boundary = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
    let end = boundary > 2000 ? boundary + 1 : 4000;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Keep paragraph/space boundaries instead of inventing a newline at every request boundary. */
export function joinTranslatedChunks(source: string[], translated: string[]): string {
  if (!source.length || !translated.length) return '';
  const leading = source[0].match(/^\s+/)?.[0] ?? '';
  const trailing = source[source.length - 1].match(/\s+$/)?.[0] ?? '';
  return leading + translated.map((text, index) => {
    if (index === translated.length - 1) return text.trim();
    const separator = source[index].match(/\s+$/)?.[0] ?? source[index + 1].match(/^\s+/)?.[0] ?? '';
    return text.trim() + separator;
  }).join('') + trailing;
}

/** Each entry keeps its own original and cached languages. Never saves a translation over it. */
export function useInlineTranslation(text: string, loadText?: () => Promise<string>, revision?: number) {
  const [language, setLanguage] = useState<Language | null>(null);
  const activeLanguage = useRef<Language | null>(null);
  const [displayed, setDisplayed] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cache = useRef(new Map<Language, string>());
  const requestId = useRef(0);
  const loadSource = useRef(loadText);
  loadSource.current = loadText;
  const chunks = useRef(new Map<string, string>());
  const original = useRef(text);

  useEffect(() => {
    const requests = requestId;
    requests.current++;
    original.current = text;
    cache.current.clear();
    chunks.current.clear();
    activeLanguage.current = null;
    setLanguage(null); setDisplayed(text); setBusy(false); setError('');
    return () => { requests.current++; };
  }, [text, revision]);

  async function select(next: Language | null) {
    const request = ++requestId.current;
    setError('');
    if (next === null) {
      activeLanguage.current = null; setLanguage(null); setDisplayed(original.current);
      if (!loadSource.current) { setBusy(false); return; }
      setBusy(true);
      try {
        const full = await loadSource.current();
        if (request === requestId.current) { original.current = full; setDisplayed(full); }
      } catch (cause) {
        if (request === requestId.current) setError(errMsg(cause, 'Couldn’t load the original. Try again.'));
      } finally { if (request === requestId.current) setBusy(false); }
      return;
    }
    const cached = cache.current.get(next);
    if (cached !== undefined) { activeLanguage.current = next; setLanguage(next); setDisplayed(cached); setBusy(false); return; }
    setBusy(true);
    try {
      const source = loadSource.current ? await loadSource.current() : original.current;
      if (request !== requestId.current) return;
      original.current = source;
      if (!activeLanguage.current) setDisplayed(source);
      const translated: string[] = [];
      const sourceChunks = translationChunks(source);
      for (const chunk of sourceChunks) {
        if (request !== requestId.current) return;
        const key = `${next}:${chunk}`;
        let output = chunks.current.get(key);
        if (output === undefined) {
          const result = await requestTranslation({ text: chunk, source: 'auto', target: next });
          if (request !== requestId.current) return;
          output = result.translation;
          chunks.current.set(key, output);
        }
        translated.push(output);
      }
      if (request !== requestId.current) return;
      const output = joinTranslatedChunks(sourceChunks, translated);
      cache.current.set(next, output);
      activeLanguage.current = next;
      setLanguage(next); setDisplayed(output);
    } catch (cause) {
      if (request === requestId.current) setError(errMsg(cause, 'Couldn’t translate. Try again.'));
    } finally { if (request === requestId.current) setBusy(false); }
  }
  const clearError = useCallback(() => setError(''), []);
  return { language, text: displayed, busy, error, select, clearError };
}
