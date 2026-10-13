import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as usersRepo from '@/db/repo/users';
import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  generateCodeVerifier,
} from '@/lib/providers/openrouter';
import { resolveActor } from '@/server/auth';

export const Route = createFileRoute('/api/connections/openrouter')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.redirect(`${origin}/app/settings?error=signin_required`, 302);
        }

        const verifier = generateCodeVerifier();
        const challenge = await deriveCodeChallenge(verifier);
        await usersRepo.setOpenRouterPkceVerifier(getDb(), actor.userId, verifier);

        const authorizeUrl = buildAuthorizeUrl({
          callbackUrl: `${origin}/api/connections/openrouter/callback`,
          codeChallenge: challenge,
        });
        return Response.redirect(authorizeUrl, 302);
      },

      DELETE: async () => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        await usersRepo.clearOpenRouterConnection(getDb(), actor.userId);
        return Response.json({ ok: true });
      },
    },
  },
});
