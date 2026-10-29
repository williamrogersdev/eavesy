import { accountCall, isDesktop } from '@/lib/desktop/bridge';
import { isRecord } from '@/lib/json';
import type { PromptSuggestion } from '@/lib/prompt-starters';
import { parseSavedPrompt, type SavedPrompt } from '@/lib/prompts';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

function message(code: string, otherwise: string): string {
  if (code.includes('too_many_prompts')) return 'You have reached the prompt limit. Delete one before adding another.';
  if (code.includes('invalid_request')) return 'A prompt needs a name and some text.';
  return otherwise;
}

/** Calls `/api/prompts…` as this Mac when in the app, or as the signed-in browser. */
async function call(method: Method, path: string, body?: unknown): Promise<unknown> {
  if (isDesktop()) {
    try { return await accountCall(method, path, body); }
    catch (error) { throw new Error(message(String(error), String(error))); }
  }
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(message(isRecord(json) && typeof json.error === 'string' ? json.error : '', 'Couldn’t reach eavesy.com. Try again.'));
  return json;
}

function one(body: unknown): SavedPrompt {
  const prompt = isRecord(body) ? parseSavedPrompt(body.prompt) : null;
  if (!prompt) throw new Error('eavesy.com sent an answer Eavesy couldn’t read');
  return prompt;
}

export async function listPrompts(): Promise<SavedPrompt[]> {
  const body = await call('GET', '/api/prompts');
  if (!isRecord(body) || !Array.isArray(body.items)) throw new Error('eavesy.com sent an answer Eavesy couldn’t read');
  return body.items.flatMap((item) => parseSavedPrompt(item) ?? []);
}

export async function createPrompt(fields: { name: string; body: string }): Promise<SavedPrompt> {
  return one(await call('POST', '/api/prompts', fields));
}

export async function updatePrompt(id: string, fields: { name?: string; body?: string }): Promise<SavedPrompt> {
  return one(await call('PATCH', `/api/prompts/${encodeURIComponent(id)}`, fields));
}

/** Counts a paste, so the prompts used most come first. */
export async function markPromptUsed(id: string): Promise<SavedPrompt> {
  return one(await call('PATCH', `/api/prompts/${encodeURIComponent(id)}`, { used: true }));
}

/**
 * Prompts suggested from the account's recent dictations: empty when there's
 * too little to go on. Throws when eavesy.com can't be reached or says no.
 */
export async function suggestPrompts(): Promise<PromptSuggestion[]> {
  const body = await call('GET', '/api/prompts/suggestions');
  if (!isRecord(body) || !Array.isArray(body.suggestions)) throw new Error('eavesy.com sent an answer Eavesy couldn’t read');
  return body.suggestions.flatMap((item) => isRecord(item) && typeof item.name === 'string' && typeof item.body === 'string'
    ? [{ name: item.name, body: item.body, why: typeof item.why === 'string' ? item.why : '' }]
    : []);
}

export async function deletePrompt(id: string): Promise<void> {
  await call('DELETE', `/api/prompts/${encodeURIComponent(id)}`);
}
