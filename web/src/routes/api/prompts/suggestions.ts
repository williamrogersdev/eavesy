import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as prompts from '@/db/repo/prompts';
import { anthropic } from '@/lib/ai/client';
import { resolveIngestActor } from '@/server/device-auth';
import { MIN_DICTATIONS, recentDictations, suggestPrompts } from '@/server/prompt-suggestions';
import { guardSpend, guardUserQuota, refundSpend, refundUserQuota } from '@/server/rate-limit';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

/**
 * Saved prompts suggested from the user's own recent dictations. `source` says
 * where they came from: "dictations", or "none" when there's too little to go on
 * (Settings then shows its starter prompts).
 */
export const Route = createFileRoute('/api/prompts/suggestions')({ server: { handlers: {
  GET: async ({ request }) => {
    let actor;
    try { actor = await resolveIngestActor(request); }
    catch { return json({ error: 'unauthenticated' }, 401); }
    const db = getDb();
    const samples = await recentDictations(db, actor.userId);
    // Not enough to find a pattern in: free, and no model call.
    if (samples.length < MIN_DICTATIONS) return json({ suggestions: [], source: 'none' });
    const chargedAt = Date.now();
    const refund = () => refundUserQuota(actor.userId, 'prompt-suggestions', chargedAt);
    const quota = await guardUserQuota(actor.userId, 'prompt-suggestions', chargedAt);
    if (quota) return quota;
    const limited = await guardSpend(request, 'prompt-suggestions', { perMin: 20, perDay: 2_000 });
    if (limited) { await refund(); return limited; }
    const taken = new Set((await prompts.list(db, actor.userId)).map((prompt) => prompt.name.toLowerCase()));
    try {
      return json({ suggestions: await suggestPrompts(anthropic(), samples, taken), source: 'dictations' });
    } catch {
      await Promise.allSettled([refund(), refundSpend('prompt-suggestions', chargedAt)]);
      return json({ error: 'Couldn’t suggest prompts right now.' }, 502);
    }
  },
} } });
