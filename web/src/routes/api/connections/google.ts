import { createFileRoute } from '@tanstack/react-router';
import { deriveCodeChallenge, generateCodeVerifier } from '@/lib/providers/openrouter';
import { resolveActor } from '@/server/auth';
import { buildGoogleAuthorizeUrl, googleCredentials } from '@/server/google-calendar';
import { googleRedirectUri, settingsRedirect, stateCookie, userTag } from '@/server/google-oauth-flow';

// Starts "Connect Google": state and PKCE verifier ride in a short-lived
// cookie scoped to this path, so the callback can check both.
export const Route = createFileRoute('/api/connections/google')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const origin = url.origin;
        const from = url.searchParams.get('from') === 'mac' ? 'mac' : 'web';
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          const back = `/app/connect-google${from === 'mac' ? '#mac' : ''}`;
          return Response.redirect(`${origin}/sign-in?redirect_url=${encodeURIComponent(back)}`, 302);
        }
        const creds = googleCredentials();
        if (!creds) return settingsRedirect(origin, from, 'error=google_unavailable');

        const state = generateCodeVerifier();
        const verifier = generateCodeVerifier();
        const location = buildGoogleAuthorizeUrl({
          clientId: creds.clientId,
          redirectUri: googleRedirectUri(origin),
          state,
          codeChallenge: await deriveCodeChallenge(verifier),
        });
        return new Response(null, {
          status: 302,
          headers: {
            location,
            'set-cookie': stateCookie({ state, verifier, from, user: await userTag(actor.userId) }),
          },
        });
      },
    },
  },
});
