import { getCloudflareContext } from '@/server/cloudflare-context';
import type { Queue } from '@cloudflare/workers-types';

export type QueueMessage =
  | { kind: 'process-recording'; meetingId: string }
  | { kind: 'embed'; meetingId: string }
  | { kind: 'embed-dictation'; dictationId: string }
  /** `track` is absent on messages from before two-track capture; read as `mixed`. */
  | { kind: 'transcribe-segment'; meetingId: string; idx: number; track?: 'mixed' | 'mic' | 'system' }
  | { kind: 'rolling-summarize'; meetingId: string; throughIdx: number }
  /** `waitingSince` bounds how long the final summary waits on segment jobs. */
  | { kind: 'summarize'; meetingId: string; waitingSince?: number }
  | { kind: 'cleanup-anonymous'; meetingId: string }
  /** Permanently remove a meeting the user deleted (R2, vectors, rows). */
  | { kind: 'purge-meeting'; meetingId: string }
  /** Permanently remove a deleted account and everything it owns. */
  | { kind: 'purge-account'; userId: string };

export function getQueue(): Queue<QueueMessage> {
  const { env } = getCloudflareContext();
  const q = (env as unknown as { PROCESSING_QUEUE?: Queue<QueueMessage> }).PROCESSING_QUEUE;
  if (!q) {
    throw new Error('PROCESSING_QUEUE binding missing — see wrangler.toml');
  }
  return q;
}

export async function enqueue(message: QueueMessage, opts?: { delaySeconds?: number }) {
  await getQueue().send(message, opts ? { delaySeconds: opts.delaySeconds } : undefined);
}

export async function enqueueBatch(messages: QueueMessage[]) {
  await getQueue().sendBatch(messages.map((body) => ({ body })));
}
