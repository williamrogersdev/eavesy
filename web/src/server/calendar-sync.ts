import type { AppDb } from '@/db/client';
import * as calendarRepo from '@/db/repo/calendar';
import { openSecret } from '@/server/secret-box';
import {
  type GoogleCredentials,
  GoogleAccessRevoked,
  googleCredentials,
  listGoogleEvents,
  refreshGoogleAccess,
} from '@/server/google-calendar';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Synced window: yesterday's meetings (still being written up) through two weeks ahead. */
export const SYNC_BEHIND_MS = DAY_MS;
export const SYNC_AHEAD_MS = 14 * DAY_MS;
/** How long after an attempt, good or bad, opening Settings tries again. */
export const SYNC_STALE_MS = 15 * 60 * 1000;
/** Budget for one background round of syncs, inside the Worker's 30s after the response. */
export const SYNC_BUDGET_MS = 20_000;

export type SyncResult = 'ok' | 'reconnect' | 'failed';

/**
 * Pulls the window's events for one connection and records how it went.
 * Uses `accessToken` when the caller already has one.
 */
export async function syncConnection(
  db: AppDb,
  connection: calendarRepo.CalendarConnection,
  now = Date.now(),
  accessToken?: string,
  signal?: AbortSignal,
): Promise<SyncResult> {
  const creds = googleCredentials();
  if (connection.provider !== 'google' || !creds) return 'failed';
  const result = await attempt(db, connection, creds, now, accessToken, signal);
  // A success already stamped the row along with its events.
  if (result !== 'ok') await calendarRepo.markAttempt(db, connection.id, result, now).catch(() => undefined);
  return result;
}

/** Due for a sync: never tried, or the last try is older than SYNC_STALE_MS. */
export function isDue(connection: calendarRepo.CalendarConnection, now: number): boolean {
  return !connection.lastAttemptAt || now - connection.lastAttemptAt > SYNC_STALE_MS;
}

/** Syncs every due connection one after another, longest-waiting first, within one shared budget. */
export async function syncDue(db: AppDb, connections: calendarRepo.CalendarConnection[], now = Date.now()): Promise<void> {
  const signal = AbortSignal.timeout(SYNC_BUDGET_MS);
  const due = connections.filter((c) => isDue(c, now)).sort((a, b) => (a.lastAttemptAt ?? 0) - (b.lastAttemptAt ?? 0));
  for (const connection of due) {
    if (signal.aborted) break;
    if (!(await calendarRepo.claimAttempt(db, connection.id, now, SYNC_STALE_MS))) continue;
    await syncConnection(db, connection, now, undefined, signal);
  }
}

async function attempt(
  db: AppDb,
  connection: calendarRepo.CalendarConnection,
  creds: GoogleCredentials,
  now: number,
  accessToken: string | undefined,
  signal: AbortSignal | undefined,
): Promise<SyncResult> {
  try {
    let token = accessToken;
    if (!token) {
      const refresh = await openSecret(connection.refreshTokenEncrypted);
      if (!refresh) return 'reconnect';
      token = await refreshGoogleAccess(creds, refresh, signal);
    }
    const from = now - SYNC_BEHIND_MS;
    const to = now + SYNC_AHEAD_MS;
    const { events, complete } = await listGoogleEvents(token, from, to, signal);
    await calendarRepo.replaceEvents(db, { userId: connection.userId, connectionId: connection.id, from, to, events, complete, now });
    return 'ok';
  } catch (error) {
    if (error instanceof GoogleAccessRevoked) return 'reconnect';
    console.error('[calendar-sync]', error);
    return 'failed';
  }
}
