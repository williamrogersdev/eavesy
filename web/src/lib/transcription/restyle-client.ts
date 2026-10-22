import { isDesktop } from '@/lib/desktop/bridge';
import type { DictationStyle } from './dictation-style';

/** The server's polish route keeps anything longer to the model-free cleanup. */
export const MAX_RESTYLE_CHARS = 20_000;

/** Reads a polish reply: the rewrite, or why there isn't one. Never passes the unchanged text off as a rewrite. */
export function restyledText(value: unknown): string {
  const reply = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (reply.polished === false) throw new Error(reply.reason === 'too_long' ? 'Too long to rewrite here' : 'Couldn’t rewrite it in that tone');
  if (typeof reply.text !== 'string' || !reply.text.trim()) throw new Error('Couldn’t rewrite it in that tone');
  return reply.text;
}

/** A saved capture's words in another tone, or shaped as a prompt for an AI. Not saved anywhere. */
export async function requestRestyle(id: string, text: string, style: DictationStyle, forAgents: boolean): Promise<string> {
  if (text.length > MAX_RESTYLE_CHARS) throw new Error('Too long to rewrite here');
  if (isDesktop()) {
    return String(await window.__TAURI__!.core.invoke('restyle_dictation', { sessionId: id, text, style, forAgents }));
  }
  const response = await fetch('/api/dictations/polish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, style, forAgents }),
    signal: AbortSignal.timeout(60_000),
  });
  const reply: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = reply && typeof reply === 'object' && 'error' in reply ? String(reply.error) : '';
    throw new Error(response.status === 429 || error === 'rate_limited' ? 'Too many rewrites. Try again in a minute' : 'Couldn’t rewrite it. Try again');
  }
  return restyledText(reply);
}
