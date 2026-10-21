import { useEffect, useRef, useState } from 'react';
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

/** Each entry keeps its own original and cached languages. Never saves a translation over it. */
export function useInlineTranslation(text: string, loadText?: () => Promise<string>, revision?: number) {
  const [language, setLanguage] = useState<Language | null>(null);
  const [displayed, setDisplayed] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cache = useRef(new Map<Language, string>());
  const version = useRef(0);
  const original = useRef(text);

  useEffect(() => {
    const requests = version;
    requests.current++;
    original.current = text;
    cache.current.clear();
    setLanguage(null); setDisplayed(text); setBusy(false); setError('');
    return () => { requests.current++; };
  }, [text, revision]);

  async function select(next: Language | null) {
    const request = ++version.current;
    setError('');
    if (next === null) { setLanguage(null); setDisplayed(original.current); setBusy(false); return; }
    const cached = cache.current.get(next);
    if (cached !== undefined) { setLanguage(next); setDisplayed(cached); setBusy(false); return; }
    setBusy(true);
    try {
      const source = loadText ? await loadText() : original.current;
      if (request !== version.current) return;
      original.current = source;
      const translated: string[] = [];
      for (const chunk of translationChunks(source)) {
        if (request !== version.current) return;
        const result = await requestTranslation({ text: chunk, source: 'auto', target: next });
        translated.push(result.translation);
      }
      if (request !== version.current) return;
      const output = translated.join('\n');
      cache.current.set(next, output);
      setLanguage(next); setDisplayed(output);
    } catch (cause) {
      if (request === version.current) setError(cause instanceof Error ? cause.message : 'Could not translate. Try again.');
    } finally { if (request === version.current) setBusy(false); }
  }
  return { language, text: displayed, busy, error, select };
}
