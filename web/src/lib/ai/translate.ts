import { OPENROUTER_MODELS, openRouterChat } from '@/lib/providers/openrouter-chat';
import { languageName } from '@/lib/transcription/language';
import { anthropic, anthropicForUser, MODELS } from './client';

export interface TranslatableLine {
  id: string;
  text: string;
}

/** Lines per request: enough context to keep terms consistent, small enough to stay fast. */
export const TRANSLATE_BATCH = 60;
const PARALLEL_BATCHES = 4;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'text'],
        properties: { n: { type: 'integer' }, text: { type: 'string' } },
      },
    },
  },
} as const;

export function translateSystemPrompt(to: string): string {
  const name = languageName(to);
  return `You translate lines of a spoken meeting transcript into ${name}.

Rules:
- Translate each line on its own, keeping its number "n". Return every line you were given.
- Write natural spoken ${name}, keeping the speaker's meaning and tone. Do not summarize, add or explain.
- Keep names, product names, code and numbers as they are.
- A line already in ${name} comes back unchanged. A line that mixes languages comes back entirely in ${name}.
- Transcripts come from speech recognition and can contain errors; translate the evident meaning.

Reply with JSON: {"lines":[{"n":number,"text":string}]}`;
}

export function translateUserMessage(lines: readonly TranslatableLine[]): string {
  return lines.map((line, n) => `${n}\t${line.text.replace(/\s+/g, ' ')}`).join('\n');
}

/** Pairs the model's numbered reply back to the lines it was given, dropping anything malformed. */
export function parseTranslation(reply: string, lines: readonly TranslatableLine[]): Map<string, string> {
  const out = new Map<string, string>();
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return out;
  }
  const items = typeof parsed === 'object' && parsed !== null ? (parsed as { lines?: unknown }).lines : undefined;
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const { n, text } = item as { n?: unknown; text?: unknown };
    if (typeof n !== 'number' || typeof text !== 'string' || !text.trim()) continue;
    const line = lines[n];
    if (line) out.set(line.id, text.trim());
  }
  return out;
}

export interface TranslateInput {
  lines: readonly TranslatableLine[];
  to: string;
  openRouter?: { apiKey: string } | null;
  byoApiKey?: string;
}

async function translateBatch(input: TranslateInput, batch: readonly TranslatableLine[]) {
  const system = translateSystemPrompt(input.to);
  const content = translateUserMessage(batch);
  if (input.openRouter) {
    const reply = await openRouterChat({
      apiKey: input.openRouter.apiKey,
      model: OPENROUTER_MODELS.summary,
      maxTokens: 8_000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
    });
    return parseTranslation(reply, batch);
  }
  const client = input.byoApiKey ? anthropicForUser(input.byoApiKey) : anthropic();
  const message = await client.messages.create({
    model: MODELS.translate,
    max_tokens: 8_000,
    system,
    output_config: { format: { type: 'json_schema', schema: SCHEMA as unknown as Record<string, unknown> } },
    messages: [{ role: 'user', content }],
  });
  if (message.stop_reason === 'refusal') throw new Error('translation refused by the model');
  const reply = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  return parseTranslation(reply, batch);
}

/** Translates transcript lines, a few batches at a time. Lines the model skipped are left out. */
export async function translateLines(input: TranslateInput): Promise<Map<string, string>> {
  const batches: TranslatableLine[][] = [];
  for (let i = 0; i < input.lines.length; i += TRANSLATE_BATCH) {
    batches.push(input.lines.slice(i, i + TRANSLATE_BATCH));
  }
  const out = new Map<string, string>();
  for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
    const results = await Promise.all(
      batches.slice(i, i + PARALLEL_BATCHES).map((batch) => translateBatch(input, batch)),
    );
    for (const result of results) for (const [id, text] of result) out.set(id, text);
  }
  return out;
}
