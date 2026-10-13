import { isRecord } from '@/lib/json';

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const OPENROUTER_MODELS = {
  vision: 'anthropic/claude-sonnet-4.6',
  summary: 'anthropic/claude-sonnet-4.6',
} as const;

export interface ORTextPart {
  type: 'text';
  text: string;
}
export interface ORImagePart {
  type: 'image_url';
  image_url: { url: string };
}
export type ORContent = string | Array<ORTextPart | ORImagePart>;
export interface ORMessage {
  role: 'system' | 'user' | 'assistant';
  content: ORContent;
}

export async function openRouterChat(opts: {
  apiKey: string;
  model: string;
  messages: ORMessage[];
  maxTokens?: number;
}): Promise<string> {
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://eavesy.com',
      'X-Title': 'Eavesy',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? 2048,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter chat failed (${res.status})`);
  }

  const json: unknown = await res.json();
  const choices = isRecord(json) ? asUnknownArray(json.choices) : [];
  const firstChoice = choices[0];
  const message = isRecord(firstChoice) ? firstChoice.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content !== 'string') {
    throw new Error('OpenRouter chat returned no text content');
  }
  return content;
}

function asUnknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function imageDataUrl(mediaType: string, bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mediaType};base64,${btoa(binary)}`;
}
