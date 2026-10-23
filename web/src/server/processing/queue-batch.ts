import type { Queue } from '@cloudflare/workers-types';
import { reportError } from '@/server/observability';
import type { ProcessingMessage } from './shared';

/** Cloudflare Queues accepts at most 100 messages per `sendBatch` call. */
const QUEUE_BATCH_SIZE = 100;
/** D1 binds at most 100 parameters per statement; leave room for the rest of the WHERE. */
export const D1_IN_LIST_SIZE = 90;

export interface Outgoing<T> {
  item: T;
  body: ProcessingMessage;
  delaySeconds?: number;
}

export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Sends many queue messages, 100 per call. A chunk whose send fails is
 * reported, not thrown, and its items are left out of the result, so a sweep
 * can leave those rows for its next run and carry on with the rest.
 *
 * Bindings without `sendBatch` (test doubles) get one `send` per message.
 */
export async function sendAll<T>(
  queue: Queue<ProcessingMessage>,
  outgoing: Outgoing<T>[],
  what: string,
): Promise<T[]> {
  const sent: T[] = [];
  if (typeof queue.sendBatch !== 'function') {
    for (const message of outgoing) {
      try {
        if (message.delaySeconds === undefined) await queue.send(message.body);
        else await queue.send(message.body, { delaySeconds: message.delaySeconds });
        sent.push(message.item);
      } catch (error) {
        reportError(`could not queue ${what}`, error, { job: message.body });
      }
    }
    return sent;
  }
  for (const chunk of chunked(outgoing, QUEUE_BATCH_SIZE)) {
    try {
      await queue.sendBatch(
        chunk.map(({ body, delaySeconds }) => (delaySeconds === undefined ? { body } : { body, delaySeconds })),
      );
      sent.push(...chunk.map((message) => message.item));
    } catch (error) {
      reportError(`could not queue ${what}`, error, { count: chunk.length });
    }
  }
  return sent;
}

/** `sendAll` for messages that need no per-item bookkeeping. */
export async function sendMessages(queue: Queue<ProcessingMessage>, bodies: ProcessingMessage[], what: string) {
  const sent = await sendAll(queue, bodies.map((body) => ({ item: body, body })), what);
  return sent.length;
}
