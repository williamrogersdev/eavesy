import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '@/db/client';
import { meetings, summaries } from '@/db/schema';
import { transcriptDelta } from '@/server/transcript-delta';

const TERMINAL = new Set(['complete', 'failed']);

export interface LiveTranscriptOptions {
  /** How often the stream checks D1 for newly transcribed ranges. */
  pollMs?: number;
  /** The stream ends after this; EventSource reconnects with Last-Event-ID. */
  lifetimeMs?: number;
  /** A comment is sent after this much quiet so proxies keep the stream open. */
  keepAliveMs?: number;
}

const DEFAULTS: Required<LiveTranscriptOptions> = {
  pollMs: 1_500,
  lifetimeMs: 5 * 60 * 1_000,
  keepAliveMs: 15_000,
};

/** The cursor a client asked to resume from: Last-Event-ID wins on reconnect. */
export function requestedCursor(request: Request): number {
  const url = new URL(request.url);
  const raw = request.headers.get('last-event-id') ?? url.searchParams.get('since');
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function wantsEventStream(request: Request) {
  return request.headers.get('accept')?.includes('text/event-stream') ?? false;
}

async function snapshot(db: AppDb, meetingId: string) {
  const [meetingRows, summaryRows] = await db.batch([
    db
      .select({ status: meetings.status })
      .from(meetings)
      .where(and(eq(meetings.id, meetingId), isNull(meetings.deletedAt)))
      .limit(1),
    db
      .select({ generatedAt: summaries.generatedAt })
      .from(summaries)
      .where(eq(summaries.meetingId, meetingId))
      .limit(1),
  ]);
  const meeting = meetingRows[0];
  return meeting ? { status: meeting.status, summaryAt: summaryRows[0]?.generatedAt ?? null } : null;
}

/** One JSON read of the changes since `since`, for clients that poll. */
export async function liveTranscriptJson(db: AppDb, meetingId: string, since: number) {
  const [state, { stamps: _stamps, ...delta }] = await Promise.all([
    snapshot(db, meetingId),
    transcriptDelta(db, meetingId, since),
  ]);
  if (!state) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json({ status: state.status, summaryAt: state.summaryAt, ...delta });
}

function event(name: string, data: unknown, id?: number) {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Server-sent events for a meeting being recorded or processed:
 * - `lines` carries a transcript delta (see `TranscriptDelta`); its id is the cursor.
 * - `status` and `summary` say the meeting row or its notes changed; reload them.
 * - `done` means the meeting is finished and the stream will not say more.
 *
 * Workers cannot be woken by the processing queue without a Durable Object, so
 * this checks D1 every `pollMs` on the client's behalf: two indexed lookups,
 * and the transcript lines only when a range changed.
 */
export function liveTranscriptStream(
  db: AppDb,
  meetingId: string,
  since: number,
  options: LiveTranscriptOptions = {},
): Response {
  const opts = { ...DEFAULTS, ...options };
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let cursor = since;
  // What this stream already sent, so the overlap window is not sent again.
  const sent = new Set<string>();
  let lastStatus: string | null = null;
  let lastSummaryAt: number | null | undefined;
  let lastWriteAt = startedAt;
  let first = true;
  let finished = false;
  let cancelled = false;

  async function tick(): Promise<string> {
    const [state, { stamps, ...delta }] = await Promise.all([
      snapshot(db, meetingId),
      transcriptDelta(db, meetingId, cursor, sent),
    ]);
    if (!state) {
      finished = true;
      return event('done', { status: 'deleted' });
    }
    let out = '';
    if (delta.ranges.length > 0) {
      cursor = delta.cursor;
      stamps.forEach((stamp) => sent.add(stamp));
      out += event('lines', delta, cursor);
    }
    if (lastStatus !== null && state.status !== lastStatus) out += event('status', { status: state.status });
    if (lastSummaryAt !== undefined && state.summaryAt !== lastSummaryAt) {
      out += event('summary', { summaryAt: state.summaryAt });
    }
    lastStatus = state.status;
    lastSummaryAt = state.summaryAt;
    if (TERMINAL.has(state.status)) {
      finished = true;
      out += event('done', { status: state.status });
    }
    return out;
  }

  async function next(): Promise<string | null> {
    while (!cancelled && !finished) {
      if (!first) {
        if (Date.now() - startedAt >= opts.lifetimeMs) return null;
        await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
        if (cancelled) return null;
      }
      first = false;
      const out = await tick();
      if (out) return out;
      if (Date.now() - lastWriteAt >= opts.keepAliveMs) return ': keep-alive\n\n';
    }
    return null;
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`retry: ${opts.pollMs}\n\n`));
    },
    async pull(controller) {
      try {
        const chunk = await next();
        if (chunk === null) {
          controller.close();
          return;
        }
        lastWriteAt = Date.now();
        controller.enqueue(encoder.encode(chunk));
      } catch (error) {
        // The client reconnects and resumes from its last cursor.
        controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}
