import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as usersRepo from '@/db/repo/users';
import { exchangeCodeForKey } from '@/lib/providers/openrouter';
import { resolveActor } from '@/server/auth';

export const Route = createFileRoute('/api/connections/openrouter/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const origin = url.origin;
        const settings = (params: string) => Response.redirect(`${origin}/app/settings?${params}`, 302);

        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return settings('error=signin_required');
        }

        const code = url.searchParams.get('code');
        if (!code) return settings('error=openrouter_no_code');

        const db = getDb();
        const user = await usersRepo.getById(db, actor.userId);
        const verifier = user?.openRouterPkceVerifier;
        if (!verifier) return settings('error=openrouter_expired');

        try {
          const { key } = await exchangeCodeForKey({ code, codeVerifier: verifier });
          await usersRepo.setOpenRouterConnection(db, actor.userId, key);
          return settings('connected=openrouter');
        } catch (err) {
          await usersRepo.clearOpenRouterConnection(db, actor.userId).catch(() => {});
          console.error('[openrouter/callback]', err);
          return settings('error=openrouter_exchange_failed');
        }
      },
    },
  },
});
