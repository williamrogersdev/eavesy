import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { resolveActor } from '@/server/auth';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { createAiRunner, creditsConfigured } from '@/lib/ai/credit-runner';
import { askLibrary } from '@/server/library-memory';
import type { ProcessingEnv } from '@/server/processing-worker';
const input = z.object({ question: z.string().trim().min(3).max(1000) });
export const Route = createFileRoute('/api/library/ask')({ server: { handlers: {
  POST: async ({ request }) => {
    let actor;
    try { actor = await resolveActor(); } catch { return Response.json({ error: 'unauthenticated' }, { status: 401 }); }
    if (actor.isAnonymous) return Response.json({ error: 'Sign in to ask your library' }, { status: 403 });
    const env = getCloudflareContext<ProcessingEnv>().env;
    if (!creditsConfigured(env)) return Response.json({ error: 'Library answers are not enabled yet.' }, { status: 503 });
    const parsed = input.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'Enter a question between 3 and 1000 characters.' }, { status: 400 });
    try { return Response.json(await askLibrary(getDb(), actor.userId, parsed.data.question, { ai: createAiRunner(env, 'library-answer'), vectorize: env.VECTORIZE })); }
    catch { return Response.json({ error: 'Could not produce a verified answer. Please retry.' }, { status: 503 }); }
  },
} } });
