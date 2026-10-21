import { isDesktop } from '@/lib/desktop/bridge';
import { isLanguage, type TranslationResult } from './languages';

export class TranslationError extends Error {
  constructor(message: string, public readonly sourceText?: string) { super(message); }
}

function translationResult(value: unknown): TranslationResult {
  if (!value || typeof value !== 'object') throw new TranslationError('Invalid translation response. Please try again.');
  const result = value as Record<string, unknown>;
  if (typeof result.error === 'string') throw new TranslationError(result.error, typeof result.text === 'string' ? result.text : undefined);
  if (typeof result.text !== 'string' || typeof result.translation !== 'string' || !result.translation.trim() || !isLanguage(result.target)) throw new TranslationError('Invalid translation response. Please try again.');
  return { text: result.text, translation: result.translation, target: result.target };
}

export async function requestTranslation(body: Record<string, unknown>): Promise<TranslationResult> {
  if (isDesktop()) {
    return translationResult(await window.__TAURI__!.core.invoke('translation_request', { body }));
  }
  const response = await fetch('/api/translation', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const result: unknown = await response.json();
  if (!response.ok && (!result || typeof result !== 'object' || !('error' in result))) throw new TranslationError('Could not translate. Please try again.');
  return translationResult(result);
}
