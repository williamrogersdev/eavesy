import * as schema from '@/db/schema';
import type { BatchItem } from 'drizzle-orm/batch';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database, Queue, R2Bucket, VectorizeIndex } from '@cloudflare/workers-types';
import { type WorkersAiRunner } from '@/lib/ai/embed';
import type { QueueMessage } from '@/server/queue';

import type { CreditEnv } from '@/lib/ai/credit-runner';
import type { MeetingBotsEnv } from '@/server/meeting-bots/control';
import type { EmailEnv } from '@/server/email/resend';

export interface ProcessingEnv extends CreditEnv, MeetingBotsEnv, EmailEnv {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  VECTORIZE: VectorizeIndex;
  PROCESSING_QUEUE: Queue<QueueMessage>;
  AI: WorkersAiRunner;
  ANTHROPIC_API_KEY: string;
}

export type ProcessingMessage = QueueMessage;
export type Db = ReturnType<typeof drizzle<typeof schema>>;
export const MAX_ATTEMPTS = 5;
export const SUMMARY_WAIT_LIMIT_MS = 6 * 60 * 60 * 1_000;
export const DEAD_LETTER_QUEUE = 'eavesy-processing-dlq';
// A queue consumer can run for at most 15 minutes, so a claim older than that
// belongs to a worker that died without releasing it.
export const SEGMENT_CLAIM_TTL_MS = 15 * 60 * 1_000;
export const SEGMENT_BUSY_RETRY_SECONDS = 300;

export class SegmentBusyError extends Error {
  constructor() {
    super('segment is being transcribed by another job');
  }
}

const D1_BATCH_SIZE = 50;

/** Sends row writes to D1 in batches: one round trip per 50 rows, not per row. */
export async function runBatched(db: Pick<Db, 'batch'>, statements: BatchItem<'sqlite'>[]) {
  for (let i = 0; i < statements.length; i += D1_BATCH_SIZE) {
    const [first, ...rest] = statements.slice(i, i + D1_BATCH_SIZE);
    await db.batch([first, ...rest]);
  }
}

export function chunkText(text: string, maxChars: number): string[] {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buffer = '';
  for (const line of lines) {
    if (buffer && buffer.length + line.length + 1 > maxChars) {
      chunks.push(buffer);
      buffer = '';
    }
    buffer += `${buffer ? '\n' : ''}${line}`;
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
