import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { resolveIngestActor } from '@/server/device-auth';
import { cleanText, MAX_ANSWER_CHARS, resolveForDevice } from '@/server/agent-inbox';

/**
 * The Mac that showed an `ask_human` card sends what you typed, or that you
 * dismissed it. The answer goes back only to the call that asked.
 */
export const Route = createFileRoute('/api/agents/inbox/$id')({ server: { handlers: {
  POST: async ({ request, params }) => {
    const actor = await resolveIngestActor(request).catch(() => null);
    if (!actor?.deviceId) return Response.json({ error: 'Connect this Mac to your Eavesy account first.' }, { status: 401 });
    const body: unknown = await request.json().catch(() => null);
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    let outcome: { status: 'answered'; text: string } | { status: 'dismissed' };
    if (record.status === 'dismissed') {
      outcome = { status: 'dismissed' };
    } else if (record.status === 'answered') {
      if (typeof record.text === 'string' && [...record.text].length > MAX_ANSWER_CHARS) {
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
