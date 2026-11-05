import type { AppDb } from '@/db/client';
import * as calendarRepo from '@/db/repo/calendar';
import { openSecret } from '@/server/secret-box';
import { reconcileCalendarBots } from '@/server/meeting-bots/calendar-plan';
import type { MeetingBotsEnv } from '@/server/meeting-bots/control';
import {
  CALENDAR_LIST_SCOPE,
  type CalendarEventInput,
  type GoogleCredentials,
  GoogleAccessRevoked,
  googleCredentials,
  listGoogleCalendars,
  listGoogleEvents,
  refreshGoogleAccess,
  selectedByDefault,
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
  // Fresh events can change which meetings the Notetaker goes to.
  else await planAfterSync(db, connection.userId, now);
  return result;
}

/** Due for a sync: never tried, or the last try is older than SYNC_STALE_MS. */
export function isDue(connection: calendarRepo.CalendarConnection, now: number): boolean {
  return !connection.lastAttemptAt || now - connection.lastAttemptAt > SYNC_STALE_MS;
}

/** The background sync's cadence (the web Worker's cron) and the age it treats as due. */
export const BACKGROUND_SYNC_CRON = '*/5 * * * *';
export const BACKGROUND_STALE_MS = 4 * 60 * 1000;
/** Connections one background run takes on, and its time budget. */
export const BACKGROUND_BATCH = 200;
export const BACKGROUND_BUDGET_MS = 4 * 60 * 1000;
const BACKGROUND_CONCURRENCY = 6;

/**
 * Every account's calendars, kept fresh without anyone having Settings or the
 * Mac app open: each connection not tried in BACKGROUND_STALE_MS is synced,
 * a few at a time, within one budget. A connection another request is
 * syncing is skipped (`claimAttempt`).
 */
export async function syncAllDue(db: AppDb, now = Date.now()): Promise<{ synced: number }> {
  // `synced` counts syncs that succeeded, not attempts.
  const due = await calendarRepo.listDueConnections(db, now, BACKGROUND_STALE_MS, BACKGROUND_BATCH);
  const signal = AbortSignal.timeout(BACKGROUND_BUDGET_MS);
  let next = 0;
  let synced = 0;
  const worker = async () => {
    while (next < due.length && !signal.aborted) {
      const connection = due[next++];
      if (!(await calendarRepo.claimAttempt(db, connection.id, now, BACKGROUND_STALE_MS))) continue;
      // Out of budget after the claim: give the claim back, so the next run takes it.
      if (signal.aborted) {
        await calendarRepo.releaseAttempt(db, connection.id, now).catch(() => undefined);
        break;
      }
      if ((await syncConnection(db, connection, now, undefined, signal)) === 'ok') synced++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(BACKGROUND_CONCURRENCY, due.length) }, worker));
  return { synced };
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
    const calendarIds = await calendarsToSync(db, connection, token, signal);
    const { events, complete } = await eventsFrom(token, calendarIds, from, to, signal);
    await calendarRepo.replaceEvents(db, { userId: connection.userId, connectionId: connection.id, from, to, events, complete, now });
    return 'ok';
  } catch (error) {
    if (error instanceof GoogleAccessRevoked) return 'reconnect';
    console.error('[calendar-sync]', error);
    return 'failed';
  }
}

/** Sends or withdraws Notetaker bots for the account's meetings; a failure never fails the sync. */
async function planAfterSync(db: AppDb, userId: string, now: number): Promise<void> {
  const env = await botEnv();
  if (!env) return;
  await reconcileCalendarBots(db, env, userId, now).catch((error: unknown) => console.error('[calendar-sync] notetaker plan', error));
}

/** The meeting-bot service binding where this Worker has one (the web Worker does). */
async function botEnv(): Promise<MeetingBotsEnv | null> {
  try {
    // Loaded here, not at the top: outside a Worker (unit tests) there is no `cloudflare:workers`.
    const { getCloudflareContext } = await import('@/server/cloudflare-context');
    const env = getCloudflareContext<Partial<MeetingBotsEnv>>().env;
    return env?.MEETING_BOTS ? { MEETING_BOTS: env.MEETING_BOTS } : null;
  } catch {
    return null;
  }
}

/** Whether this connection's grant lets Eavesy list its calendars. */
export function canListCalendars(connection: Pick<calendarRepo.CalendarConnection, 'scopes'>): boolean {
  return (connection.scopes ?? '').split(' ').includes(CALENDAR_LIST_SCOPE);
}

/**
 * The calendars to read: the ticked ones from the account's current list
 * (refreshed each sync, keeping earlier choices and ticking new calendars by
 * `selectedByDefault`), or only the primary one when the grant can't list them
 * or the list can't be read right now.
 */
async function calendarsToSync(
  db: AppDb,
  connection: calendarRepo.CalendarConnection,
  token: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  if (!canListCalendars(connection)) return ['primary'];
  let listed;
  try {
    listed = await listGoogleCalendars(token, signal);
  } catch (error) {
    if (error instanceof GoogleAccessRevoked) throw error;
    console.error('[calendar-sync] calendar list', error);
    const known = calendarRepo.storedCalendars(connection).filter((c) => c.selected);
    return known.length ? known.map((c) => (c.primary ? 'primary' : c.id)) : ['primary'];
  }
  // Merged against the stored list and saved only if it's unchanged since; a
  // tick saved meanwhile means reading it again, so the sync never undoes it.
  let stored = connection.calendarsJson;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = new Map(calendarRepo.storedCalendars({ calendarsJson: stored }).map((c) => [c.id, c.selected]));
    const calendars = listed.map((calendar) => ({
      id: calendar.id,
      name: calendar.name,
      primary: calendar.primary,
      selected: calendar.primary || (before.get(calendar.id) ?? selectedByDefault(calendar)),
    }));
    if (await calendarRepo.saveCalendarList(db, connection.id, calendars, stored)) {
      const ids = calendars.filter((c) => c.selected).map((c) => (c.primary ? 'primary' : c.id));
      return ids.length ? ids : ['primary'];
    }
    stored = (await calendarRepo.getConnection(db, connection.userId, connection.id))?.calendarsJson ?? null;
  }
  // Still changing: read what's stored as it stands, and pick up the rest next sync.
  const known = calendarRepo.storedCalendars({ calendarsJson: stored }).filter((c) => c.selected);
  return known.length ? known.map((c) => (c.primary ? 'primary' : c.id)) : ['primary'];
}

/**
 * Events from each calendar, one entry per Google event (the first calendar to
 * carry it wins, primary first). A calendar that can't be read (unshared since
 * the list was read, say) makes the listing incomplete, so nothing is deleted.
 */
async function eventsFrom(
  token: string,
  calendarIds: string[],
  from: number,
  to: number,
  signal: AbortSignal | undefined,
): Promise<{ events: CalendarEventInput[]; complete: boolean }> {
  const seen = new Set<string>();
  const events: CalendarEventInput[] = [];
  let complete = true;
  for (const calendarId of calendarIds) {
    let listing;
    try {
      listing = await listGoogleEvents(token, from, to, signal, calendarId);
    } catch (error) {
      if (error instanceof GoogleAccessRevoked || calendarId === 'primary') throw error;
      console.error('[calendar-sync] calendar', error);
      complete = false;
      continue;
    }
    complete &&= listing.complete;
    for (const event of listing.events) {
      if (seen.has(event.providerEventId)) continue;
      seen.add(event.providerEventId);
      events.push(event);
    }
  }
  return { events, complete };
}
