import type { AppDb } from '@/db/client';
import * as calendarRepo from '@/db/repo/calendar';
import { openSecret } from '@/server/secret-box';
import {
  GoogleAccessRevoked,
  googleCredentials,
  listGoogleEvents,
  refreshGoogleAccess,
} from '@/server/google-calendar';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Synced window: yesterday's meetings (still being written up) through two weeks ahead. */
export const SYNC_BEHIND_MS = DAY_MS;
export const SYNC_AHEAD_MS = 14 * DAY_MS;
/** How old a sync may be before opening Settings refreshes it. */
export const SYNC_STALE_MS = 15 * 60 * 1000;

export type SyncResult = 'ok' | 'reconnect' | 'failed';

/** Pulls the window's events for one connection. Uses `accessToken` when the caller already has one. */
export async function syncConnection(
  db: AppDb,
  connection: calendarRepo.CalendarConnection,
  now = Date.now(),
  accessToken?: string,
): Promise<SyncResult> {
  const creds = googleCredentials();
  if (connection.provider !== 'google' || !creds) return 'failed';
  try {
    let token = accessToken;
    if (!token) {
      const refresh = await openSecret(connection.refreshTokenEncrypted);
      if (!refresh) return 'reconnect';
      token = await refreshGoogleAccess(creds, refresh);
    }
    const from = now - SYNC_BEHIND_MS;
    const to = now + SYNC_AHEAD_MS;
    const events = await listGoogleEvents(token, from, to);
    await calendarRepo.replaceEvents(db, { userId: connection.userId, connectionId: connection.id, from, to, events, now });
    return 'ok';
  } catch (error) {
    if (error instanceof GoogleAccessRevoked) return 'reconnect';
    console.error('[calendar-sync]', error);
    return 'failed';
  }
}
