import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as calendarRepo from '@/db/repo/calendar';
import { resolveActor } from '@/server/auth';
import { syncConnection } from '@/server/calendar-sync';
import { exchangeGoogleCode, GOOGLE_SCOPES, googleCredentials } from '@/server/google-calendar';
import { clearStateCookie, googleRedirectUri, readStateCookie, settingsRedirect } from '@/server/google-oauth-flow';
import { sealSecret } from '@/server/secret-box';

const CALENDAR_SCOPE = GOOGLE_SCOPES[2];

export const Route = createFileRoute('/api/connections/google/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const origin = url.origin;
        const saved = readStateCookie(request);
        const from = saved?.from ?? 'web';
        const done = (params: string) => clearStateCookie(settingsRedirect(origin, from, params));

        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return done('error=signin_required');
        }
        // Closing Google's screen or pressing Cancel comes back as access_denied.
        if (url.searchParams.get('error') === 'access_denied') return done('error=google_cancelled');
        const code = url.searchParams.get('code');
        if (!code) return done('error=google_failed');
        if (!saved || saved.state !== url.searchParams.get('state')) return done('error=google_expired');
        const creds = googleCredentials();
        if (!creds) return done('error=google_unavailable');

        try {
          const grant = await exchangeGoogleCode(creds, { code, codeVerifier: saved.verifier, redirectUri: googleRedirectUri(origin) });
          // The consent screen lets people untick the calendar box.
          if (!grant.scopes.includes(CALENDAR_SCOPE)) return done('error=google_no_calendar');
          const sealed = await sealSecret(grant.refreshToken);
          if (!sealed) return done('error=google_failed');
          const db = getDb();
          const id = await calendarRepo.saveConnection(db, {
            userId: actor.userId,
            provider: 'google',
            accountEmail: grant.email,
            refreshTokenEncrypted: sealed,
          });
          const connection = await calendarRepo.getConnection(db, actor.userId, id);
          if (connection) await syncConnection(db, connection, Date.now(), grant.accessToken);
          return done('connected=google');
        } catch (error) {
          console.error('[google/callback]', error);
          return done('error=google_failed');
        }
      },
    },
  },
});
