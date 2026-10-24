import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { resolveIngestActor } from '@/server/device-auth';
import { cleanText, MAX_ANSWER_CHARS, resolveForDevice } from '@/server/agent-inbox';

/** Far above the longest answer (20,000 characters of up to 4 UTF-8 bytes) plus JSON. */
const MAX_BODY_BYTES = 100_000;

/** The body as text, read until `max` bytes; null past that, without reading the rest. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The Mac that showed an `ask_human` card sends what you typed, or that you
 * dismissed it. The answer goes back only to the call that asked.
 */
export const Route = createFileRoute('/api/agents/inbox/$id')({ server: { handlers: {
  POST: async ({ request, params }) => {
    const actor = await resolveIngestActor(request).catch(() => null);
    if (!actor?.deviceId) return Response.json({ error: 'Connect this Mac to your Eavesy account first.' }, { status: 401 });
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
      return Response.json({ error: `Keep your answer under ${MAX_ANSWER_CHARS} characters.` }, { status: 413 });
    }
    const raw = await readCapped(request, MAX_BODY_BYTES);
    if (raw === null) {
      return Response.json({ error: `Keep your answer under ${MAX_ANSWER_CHARS} characters.` }, { status: 413 });
    }
    let body: unknown = null;
    try { body = JSON.parse(raw); } catch { /* answered below */ }
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    let outcome: { status: 'answered'; text: string } | { status: 'dismissed' };
    if (record.status === 'dismissed') {
      outcome = { status: 'dismissed' };
    } else if (record.status === 'answered') {
      if (typeof record.text !== 'string') return Response.json({ error: 'Write an answer first.' }, { status: 400 });
      // Checked before cleaning, which would otherwise clip it without saying.
      if ([...record.text.trim()].length > MAX_ANSWER_CHARS) {
        return Response.json({ error: `Keep your answer under ${MAX_ANSWER_CHARS} characters.` }, { status: 400 });
      }
      const text = cleanText(record.text, MAX_ANSWER_CHARS);
      if (!text) return Response.json({ error: 'Write an answer first.' }, { status: 400 });
      outcome = { status: 'answered', text };
    } else {
      return Response.json({ error: 'status must be answered or dismissed' }, { status: 400 });
    }
    const done = await resolveForDevice(getDb(), actor.userId, actor.deviceId, params.id, outcome);
    if (!done) return Response.json({ error: 'That agent stopped waiting for an answer.' }, { status: 409 });
    return Response.json({ ok: true });
  },
} } });
