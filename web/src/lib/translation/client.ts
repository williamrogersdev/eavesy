import { isDesktop } from '@/lib/desktop/bridge';
import { encodeWav, SAMPLE_RATE } from '@/lib/imports/wav';
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

export async function readClipboardText(): Promise<string> {
  if (isDesktop()) return window.__TAURI__!.core.invoke<string>('read_clipboard_text');
  return navigator.clipboard.readText();
}

/** Resample mic audio to bounded mono PCM, matching the server's credit validation. */
export async function voicePayload(blob: Blob): Promise<string> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    if (audio.duration > 60) throw new Error('Please record up to 60 seconds.');
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * SAMPLE_RATE)), SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = audio;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const bytes = encodeWav(rendered.getChannelData(0));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  } finally { await context.close(); }
}
