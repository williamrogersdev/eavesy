import { waitUntil } from 'cloudflare:workers';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as calendarRepo from '@/db/repo/calendar';
import { resolveIngestActor } from '@/server/device-auth';
import { canListCalendars, isDue, SYNC_AHEAD_MS, SYNC_STALE_MS, syncDue, syncConnection } from '@/server/calendar-sync';
import { calendarListEnabled, googleCredentials, revokeGoogleToken } from '@/server/google-calendar';
import { openSecret } from '@/server/secret-box';

const selectSchema = z.object({
  id: z.string().min(1).max(100),
  calendars: z.array(z.object({ id: z.string().min(1).max(500), selected: z.boolean() })).max(500),
});
const removeSchema = z.object({ id: z.string().min(1).max(100), force: z.boolean().optional() });
const unauthenticated = () => Response.json({ error: 'unauthenticated' }, { status: 401 });

// Read and disconnect accept the Mac app's device token too (Settings →
// Connections). Connecting needs the browser: it goes through Google's screen.
export const Route = createFileRoute('/api/calendar-connections')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return unauthenticated();
        }
        const db = getDb();
        const now = Date.now();
        const rows = await calendarRepo.listConnections(db, actor.userId);
        // Answer from what's stored; due connections sync after the response, so
        // Google's speed never holds up Settings. The next load shows the result.
        if (rows.some((row) => isDue(row, now))) waitUntil(syncDue(db, rows, now));
        const connections = await Promise.all(
          rows.map(async (row) => ({
            id: row.id,
            provider: row.provider,
            accountEmail: row.accountEmail,
            lastSyncAt: row.lastSyncAt,
            upcoming: await calendarRepo.countUpcoming(db, row.id, now, now + SYNC_AHEAD_MS),
            needsReconnect: row.lastSyncStatus === 'reconnect',
            // The last sync didn't work (Google or the network); it is tried again by itself.
            syncFailing: row.lastSyncStatus === 'failed',
            // Which of the account's calendars are synced; null until Eavesy may list them.
            calendars: canListCalendars(row) ? calendarRepo.storedCalendars(row) : null,
            // A grant from before the calendar list was asked for: reconnecting adds it.
            canAddCalendars: calendarListEnabled() && !canListCalendars(row),
          })),
        );
        return Response.json({ available: { google: googleCredentials() !== null, outlook: false }, connections });
      },

      // Ticks or unticks calendars on one connection, then syncs it so their meetings appear or go.
      PATCH: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return unauthenticated();
        }
        const parsed = selectSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const db = getDb();
        const result = await calendarRepo.setSelectedCalendars(db, actor.userId, parsed.data.id, parsed.data.calendars);
        if (result === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
        // Nothing listed yet: the next sync reads the calendars, and the choice can be made then.
        if (result === 'not_listed') return Response.json({ ok: false, error: 'calendars_not_listed' }, { status: 409 });
        if (result === 'conflict') return Response.json({ ok: false, error: 'conflict' }, { status: 409 });
        const row = await calendarRepo.getConnection(db, actor.userId, parsed.data.id);
        // Synced now unless another sync of it is already running (it then reads the new choice next time).
        const now = Date.now();
        if (row && (await calendarRepo.claimAttempt(db, row.id, now, SYNC_STALE_MS))) waitUntil(syncConnection(db, row, now));
        return Response.json({ ok: true, calendars: row ? calendarRepo.storedCalendars(row) : [] });
      },

      DELETE: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return unauthenticated();
        }
        const parsed = removeSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const db = getDb();
        const row = await calendarRepo.getConnection(db, actor.userId, parsed.data.id);
        if (!row) return Response.json({ ok: true });
        // Google keeps the grant until it's told, so Eavesy keeps the row (and the
        // token to tell it with) until then, unless you choose to remove it anyway.
        const refresh = await openSecret(row.refreshTokenEncrypted).catch((error: unknown) => {
          console.error('[calendar-connections] open secret', error);
          return null;
        });
        const revoked = row.provider === 'google' && refresh ? await revokeGoogleToken(refresh) : false;
        if (!revoked && !parsed.data.force) return Response.json({ ok: false, error: 'google_not_revoked' });
        await calendarRepo.deleteConnection(db, actor.userId, row.id);
        return Response.json({ ok: true });
      },
    },
  },
});
