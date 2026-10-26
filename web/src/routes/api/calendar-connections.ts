import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as calendarRepo from '@/db/repo/calendar';
import { resolveIngestActor } from '@/server/device-auth';
import { SYNC_AHEAD_MS, SYNC_STALE_MS, SYNC_TIMEOUT_MS, syncConnection, type SyncResult } from '@/server/calendar-sync';
import { googleCredentials, revokeGoogleToken } from '@/server/google-calendar';
import { openSecret } from '@/server/secret-box';

const removeSchema = z.object({ id: z.string().min(1).max(100) });
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
        const connections = await Promise.all(
          rows.map(async (row) => {
            let sync: SyncResult = 'ok';
            if (!row.lastSyncAt || now - row.lastSyncAt > SYNC_STALE_MS) {
              sync = await syncConnection(db, row, now, undefined, AbortSignal.timeout(SYNC_TIMEOUT_MS));
            }
            return {
              id: row.id,
              provider: row.provider,
              accountEmail: row.accountEmail,
              lastSyncAt: sync === 'ok' && !row.lastSyncAt ? now : row.lastSyncAt,
              upcoming: await calendarRepo.countUpcoming(db, row.id, now, now + SYNC_AHEAD_MS),
              needsReconnect: sync === 'reconnect',
            };
          }),
        );
        return Response.json({ available: { google: googleCredentials() !== null, outlook: false }, connections });
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
        // Disconnect always removes Eavesy's copy; when Google couldn't be told, say so.
        const refresh = await openSecret(row.refreshTokenEncrypted).catch((error: unknown) => {
          console.error('[calendar-connections] open secret', error);
          return null;
        });
        const revoked = row.provider === 'google' && refresh ? await revokeGoogleToken(refresh) : false;
        await calendarRepo.deleteConnection(db, actor.userId, row.id);
        return Response.json(revoked ? { ok: true } : { ok: true, warning: 'google_not_revoked' });
      },
    },
  },
});
