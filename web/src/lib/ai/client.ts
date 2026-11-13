import Anthropic from '@anthropic-ai/sdk';
import { requireServerEnv } from '@/lib/env';
import { DEFAULT_ASSISTANT_MODEL, DEFAULT_NOTES_MODEL } from './model-choice';

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: requireServerEnv('ANTHROPIC_API_KEY') });
  }
  return client;
}

export function anthropicForUser(userKey: string): Anthropic {
  return new Anthropic({ apiKey: userKey });
}

/**
 * Sent with requests to models whose safety classifiers can decline one (a
 * meeting about security work, say): the API then retries on the model's
 * default fallback inside the same call, so notes are still written.
 */
const REFUSAL_FALLBACK: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: 'default' } = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

/**
 * What to add to a request to `model` so a declined one is retried on
 * another model. Haiku has no server-side fallback, so its requests go
 * without the parameter.
 */
export function refusalFallback(model: string): Partial<typeof REFUSAL_FALLBACK> {
  return model.startsWith('claude-haiku') ? {} : REFUSAL_FALLBACK;
}

/**
 * The text of a finished reply. A declined or cut-off one throws: half an
 * answer, or half of some notes, is never passed on as the whole.
 */
export function replyText(response: { stop_reason: string | null; content: { type: string; text?: string }[] }, what: string): string {
  if (response.stop_reason === 'refusal') throw new Error(`${what} refused by the model`);
  if (response.stop_reason === 'max_tokens') throw new Error(`${what} truncated at max_tokens`);
  return response.content.map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('');
}

/**
 * The model to record as the author: the one asked for, unless the API says
 * another Claude model answered (a fallback after a decline).
 */
export function answeredBy(requested: string, reported: string | null | undefined): string {
  return reported && reported !== requested && reported.startsWith('claude-') ? reported : requested;
}

export const MODELS = {
  /** Meeting notes and questions about a meeting, unless the account chose another (`model-choice.ts`). */
  summary: DEFAULT_NOTES_MODEL,
  /** Rolling notes while a meeting is live: frequent, short, latency-sensitive. */
  rollingNotes: 'claude-haiku-5-5',
  /** Cleans finished transcripts up for pasting into an agent: many short requests. */
  transcriptCleanup: 'claude-haiku-5-5',
  /** Transcript translation: many short lines, latency-sensitive. */
  translate: 'claude-haiku-5-5',
  /** Spoken summary and suggested reply when a Claude Code session stops: short, latency-sensitive. */
  agentReply: 'claude-haiku-5-5',
  /** Saved prompts suggested from the user's recent dictations, on request in Settings. */
  promptSuggestions: 'claude-haiku-5-5',
  /** Agents' feedback on a saved prompt merged into one proposed rewrite, on request in Settings. */
  promptFeedbackMerge: 'claude-haiku-5-5',
  /** Eavesy's conversation: tool use, short replies. The default; the account may choose another. */
  assistant: DEFAULT_ASSISTANT_MODEL,
  /** The second-model check on each tier 2 or 3 action (assistant.md C7). */
  assistantCheck: 'claude-haiku-5-5',
  vision: 'claude-sonnet-5-5',
  embed: 'voyage-3',
} as const;
