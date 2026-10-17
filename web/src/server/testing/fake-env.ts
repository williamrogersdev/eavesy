import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessingEnv, ProcessingMessage } from '@/server/processing-worker';

const MIGRATIONS = join(import.meta.dir, '../../../drizzle');

function fakeD1(sqlite: Database) {
  const statement = (query: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(query, next),
    async all() {
      return { results: sqlite.query(query).all(...(params as never[])), success: true, meta: {} };
    },
    async run() {
      const result = sqlite.query(query).run(...(params as never[]));
      return { results: [], success: true, meta: { changes: result.changes } };
    },
    async first(column?: string) {
      const row = sqlite.query(query).get(...(params as never[])) as Record<string, unknown> | null;
      return column && row ? row[column] : row;
    },
    async raw() {
      return sqlite.query(query).values(...(params as never[]));
    },
  });
  return {
    prepare: (query: string) => statement(query),
    async batch(statements: { run(): Promise<unknown> }[]) {
      return Promise.all(statements.map((s) => s.run()));
    },
    async exec(query: string) {
      sqlite.exec(query);
      return { count: 0, duration: 0 };
    },
  };
}

export interface SentMessage {
  body: ProcessingMessage;
  delaySeconds?: number;
}

export function createFakeEnv(
  opts: { transcribe?: (audio: Uint8Array, request: { vadFilter: boolean }) => unknown } = {},
) {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    for (const chunk of readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint')) {
      if (chunk.trim()) sqlite.exec(chunk);
    }
  }

  const sent: SentMessage[] = [];
  const objects = new Map<string, Uint8Array>();
  const deletedVectors: string[] = [];
  const env = {
    DB: fakeD1(sqlite),
    AUDIO_BUCKET: {
      async get(key: string) {
        const bytes = objects.get(key);
        return bytes ? { arrayBuffer: async () => bytes.buffer } : null;
      },
      async delete(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      },
      async list({ prefix = '' }: { prefix?: string } = {}) {
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
        return { objects: keys.map((key) => ({ key })), truncated: false };
      },
    },
    VECTORIZE: {
      deleteByIds: async (ids: string[]) => {
        deletedVectors.push(...ids);
        return {};
      },
      upsert: async () => ({}),
    },
    PROCESSING_QUEUE: {
      async send(body: ProcessingMessage, options?: { delaySeconds?: number }) {
        sent.push({ body, delaySeconds: options?.delaySeconds });
      },
    },
    AI: {
      async run(model: string, input: { audio?: string; text?: string[]; vad_filter?: boolean }) {
        if (model.includes('whisper')) {
          const audio = Uint8Array.from(atob(input.audio ?? ''), (c) => c.charCodeAt(0));
          return opts.transcribe
            ? opts.transcribe(audio, { vadFilter: input.vad_filter ?? true })
            : { text: '', segments: [] };
        }
        return { data: (input.text ?? []).map(() => new Array(1024).fill(0)) };
      },
    },
    ANTHROPIC_API_KEY: 'test-key',
  } as unknown as ProcessingEnv;

  return { env, sqlite, sent, objects, deletedVectors };
}

export function delivery(body: ProcessingMessage, attempts = 1) {
  const outcome: { acked: boolean; retried: boolean; delaySeconds?: number } = {
    acked: false,
    retried: false,
  };
  return {
    outcome,
    message: {
      id: 'm',
      timestamp: new Date(),
      body,
      attempts,
      ack: () => void (outcome.acked = true),
      retry: (o?: { delaySeconds?: number }) => {
        outcome.retried = true;
        outcome.delaySeconds = o?.delaySeconds;
      },
    },
  };
}

export function stubAnthropic(reply: (body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const original = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}');
    calls.push(body);
    const { status = 200, json } = reply(body);
    if (body.stream === true && status === 200) return streamedReply(json as StubMessage);
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

interface StubMessage {
  stop_reason: string;
  content: { type: 'text'; text: string }[];
  [key: string]: unknown;
}

/** The same message as the server-sent events a streamed request receives. */
function streamedReply(message: StubMessage) {
  const { content, stop_reason, ...rest } = message;
  const events: [string, unknown][] = [
    ['message_start', { type: 'message_start', message: { ...rest, content: [], stop_reason: null } }],
    ...content.flatMap((block, index): [string, unknown][] => [
      ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }],
      ['content_block_stop', { type: 'content_block_stop', index }],
    ]),
    ['message_delta', { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const sse = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function summaryReply(summary: Record<string, unknown>, stop_reason = 'end_turn') {
  return {
    json: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'test',
      stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: typeof summary === 'string' ? summary : JSON.stringify(summary) }],
    },
  };
}
