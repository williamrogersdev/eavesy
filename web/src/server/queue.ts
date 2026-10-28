import { getCloudflareContext } from '@/server/cloudflare-context';
import type { Queue } from '@cloudflare/workers-types';
import type { BotPlatform } from '@/server/meeting-bots/service';
import type { WebhookDelivery } from '@/server/webhooks';

export type QueueMessage =
  | { kind: 'process-recording'; meetingId: string }
  /**
   * `queuedAt` marks a re-index after a transcript edit: the job is skipped
   * when the meeting was embedded after that time, so a burst of edits
   * embeds once.
   */
  | { kind: 'embed'; meetingId: string; queuedAt?: number }
  | { kind: 'embed-dictation'; dictationId: string }
  /** `track` is absent on messages from before two-track capture; read as `mixed`. */
  | { kind: 'transcribe-segment'; meetingId: string; idx: number; track?: 'mixed' | 'mic' | 'system' }
  /** `throughMs` is absent on messages from before time-based rolling notes. */
  | { kind: 'rolling-summarize'; meetingId: string; throughIdx: number; throughMs?: number }
  /** `waitingSince` bounds how long the final summary waits on segment jobs. */
  | { kind: 'summarize'; meetingId: string; waitingSince?: number }
  /** Clean the finished transcript up for pasting into an AI agent. */
  | { kind: 'agent-transcript'; meetingId: string; onlyIfMissing?: boolean }
  | { kind: 'cleanup-anonymous'; meetingId: string }
  /** Permanently remove a meeting the user deleted (R2, vectors, rows). */
  | { kind: 'purge-meeting'; meetingId: string }
  /** Permanently remove a deleted account and everything it owns. */
  | { kind: 'purge-account'; userId: string }
  /** Copy a notetaker bot's finished recording in and hand it to the summary pipeline. */
  | { kind: 'collect-bot-recording'; botId: string }
  /** Judge a canary bot's run (meeting-bots/canary.ts); `check` counts re-looks. */
  | { kind: 'check-canary'; botId: string; platform?: BotPlatform; check?: number }
  /** Email the owner the recap of a completed meeting, if they turned recaps on. */
  | { kind: 'send-recap'; meetingId: string }
  /** One attempt to POST an event to one of the account's webhook endpoints (server/webhooks.ts). */
  | WebhookDelivery;

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

