import { accountCall, isDesktop } from '@/lib/desktop/bridge';
import { parseAgentFeedback, type AgentFeedback } from '@/lib/agent-feedback';
import { isRecord } from '@/lib/json';
import { parseSavedPrompt, type SavedPrompt } from '@/lib/prompts';

/** The prompt changed since the preview was made; `prompt` is how it reads now. */
export class PromptChanged extends Error {
  constructor(readonly prompt: SavedPrompt | null) { super('This prompt changed since the preview. Look at it again before applying.'); }
}

const UNREADABLE = 'eavesy.com sent an answer Eavesy couldn’t read';

/** Calls `/api/agent-feedback…` as this Mac when in the app, or as the signed-in browser. */
async function call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
  if (isDesktop()) {
    try { return await accountCall(method, path, body); }
    catch (error) {
      if (String(error).includes('prompt_changed')) throw new PromptChanged(null);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: unknown = await response.json().catch(() => null);
  if (response.status === 409 && isRecord(json)) throw new PromptChanged(parseSavedPrompt(json.prompt));
  if (!response.ok) throw new Error(isRecord(json) && typeof json.error === 'string' && json.error.includes(' ') ? json.error : 'Couldn’t reach eavesy.com. Try again.');
  return json;
}

/** What agents reported and the user hasn't dealt with yet, newest first. */
export async function listAgentFeedback(): Promise<AgentFeedback[]> {
  const body = await call('GET', '/api/agent-feedback');
  if (!isRecord(body) || !Array.isArray(body.items)) throw new Error(UNREADABLE);
  return body.items.flatMap((item) => parseAgentFeedback(item) ?? []);
}

export async function dismissAgentFeedback(ids: string[]): Promise<void> {
  await call('PATCH', '/api/agent-feedback', { ids, status: 'dismissed' });
}

/** Writes `body` into the prompt if it still reads `expectedBody`, and marks `ids` applied. Throws PromptChanged otherwise. */
export async function applyAgentFeedback(fields: { promptId: string; expectedBody: string; body: string; ids: string[] }): Promise<SavedPrompt> {
  const body = await call('POST', '/api/agent-feedback/apply', fields);
  const prompt = isRecord(body) ? parseSavedPrompt(body.prompt) : null;
  if (!prompt) throw new Error(UNREADABLE);
  return prompt;
}

export interface MergedRewrite { body: string; summary: string; basedOn: string; ids: string[] }

/** One rewrite of the prompt from the agents' open reports on it, to preview. */
export async function mergeAgentFeedback(promptId: string, ids?: string[]): Promise<MergedRewrite> {
  const body = await call('POST', '/api/agent-feedback/merge', { promptId, ...(ids ? { ids } : {}) });
  if (!isRecord(body) || typeof body.body !== 'string' || typeof body.basedOn !== 'string') throw new Error(UNREADABLE);
  return {
    body: body.body,
    summary: typeof body.summary === 'string' ? body.summary : '',
    basedOn: body.basedOn,
    ids: Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [],
  };
}
