import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import type { AppDb } from '../client';
import { decode, encode } from '../codec';
import { pid } from '../ids';
import { calendarConnections, calendarEvents } from '../schema';
import type { CalendarEventInput } from '@/server/google-calendar';

export type CalendarConnection = typeof calendarConnections.$inferSelect;

export async function listConnections(db: AppDb, userId: string): Promise<CalendarConnection[]> {
  return db.select().from(calendarConnections).where(eq(calendarConnections.userId, userId));
}

export async function getConnection(db: AppDb, userId: string, id: string): Promise<CalendarConnection | null> {
  const rows = await db
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.id, id), eq(calendarConnections.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** One row per account: connecting the same Google account again replaces its token. */
export async function saveConnection(
  db: AppDb,
  args: { userId: string; provider: 'google' | 'outlook'; accountEmail: string; refreshTokenEncrypted: string },
): Promise<string> {
  const existing = (
    await db
      .select({ id: calendarConnections.id })
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.userId, args.userId),
          eq(calendarConnections.provider, args.provider),
          eq(calendarConnections.accountEmail, args.accountEmail),
        ),
      )
      .limit(1)
  )[0];
  if (existing) {
    await db
      .update(calendarConnections)
      .set({ refreshTokenEncrypted: args.refreshTokenEncrypted, lastAttemptAt: null, lastSyncStatus: null })
      .where(eq(calendarConnections.id, existing.id));
    return existing.id;
  }
  const id = pid('cal');
  await db.insert(calendarConnections).values({ id, ...args, lastSyncAt: null, lastAttemptAt: null, lastSyncStatus: null });
  return id;
}

/**
 * Stamps the attempt's start, but only if no other request has since: true
 * when this caller won it, so two Settings loads never sync one calendar twice.
 */
export async function claimAttempt(db: AppDb, id: string, now: number, staleMs: number): Promise<boolean> {
  const claimed = await db
    .update(calendarConnections)
    .set({ lastAttemptAt: now })
    .where(
      and(
        eq(calendarConnections.id, id),
        or(isNull(calendarConnections.lastAttemptAt), lt(calendarConnections.lastAttemptAt, now - staleMs)),
      ),
    )
    .returning({ id: calendarConnections.id });
  return claimed.length > 0;
}

/** Records how a sync attempt went, so a broken grant shows Reconnect without asking Google again. */
export async function markAttempt(db: AppDb, id: string, status: 'ok' | 'reconnect' | 'failed', now: number): Promise<void> {
  await db.update(calendarConnections).set({ lastAttemptAt: now, lastSyncStatus: status }).where(eq(calendarConnections.id, id));
}

export async function deleteConnection(db: AppDb, userId: string, id: string): Promise<void> {
  await db.batch([
    db.delete(calendarEvents).where(and(eq(calendarEvents.connectionId, id), eq(calendarEvents.userId, userId))),
    db.delete(calendarConnections).where(and(eq(calendarConnections.id, id), eq(calendarConnections.userId, userId))),
  ]);
}

/**
 * Makes the stored events between `from` and `to` match `events`: new ones are
 * added and changed ones updated (the update leaves `autoRecord`, the record
 * choice and the recorded meeting alone). With `complete`, ones that went away
 * are dropped unless a recording points at them; a truncated listing deletes
 * nothing.
 */
export async function replaceEvents(
  db: AppDb,
  args: { userId: string; connectionId: string; from: number; to: number; events: CalendarEventInput[]; complete: boolean; now: number },
): Promise<void> {
  const { userId, connectionId } = args;
  const current = await db
    .select({ id: calendarEvents.id, providerEventId: calendarEvents.providerEventId })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.connectionId, connectionId),
        gte(calendarEvents.startsAt, args.from),
        lte(calendarEvents.startsAt, args.to),
        isNull(calendarEvents.recordedMeetingId),
      ),
    );
  const keep = new Set(args.events.map((e) => e.providerEventId));
  const gone = args.complete ? current.filter((row) => !keep.has(row.providerEventId)).map((row) => row.id) : [];

  const writes = args.events.map((event) => {
    const fields = {
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      meetingUrl: event.meetingUrl,
      platform: event.platform,
      participantsJson: encode(event.participants),
    };
    return db
      .insert(calendarEvents)
      .values({ id: pid('evt'), userId, connectionId, providerEventId: event.providerEventId, ...fields })
      .onConflictDoUpdate({ target: [calendarEvents.connectionId, calendarEvents.providerEventId], set: fields });
  });
  // D1 caps bound parameters per statement, so deletions go in small groups.
  const deletes = [];
  for (let i = 0; i < gone.length; i += 50) {
    deletes.push(db.delete(calendarEvents).where(inArray(calendarEvents.id, gone.slice(i, i + 50))));
  }
  const touch = db
    .update(calendarConnections)
    .set({ lastSyncAt: args.now, lastAttemptAt: args.now, lastSyncStatus: 'ok' })
    .where(eq(calendarConnections.id, connectionId));
  await db.batch([touch, ...writes, ...deletes]);
}

export async function countUpcoming(db: AppDb, connectionId: string, from: number, to: number): Promise<number> {
  const rows = await db
    .select({ id: calendarEvents.id })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.connectionId, connectionId), gte(calendarEvents.startsAt, from), lte(calendarEvents.startsAt, to)));
  return rows.length;
}

export type StoredEvent = {
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  meetingUrl: string | null;
  platform: string | null;
  participants: { email: string; name: string | null }[];
  recordChoice: 'record' | 'skip' | null;
  recordedMeetingId: string | null;
};

/** The user's events under way or starting between `from` and `to` (ones begun over a day before `from` are left out). */
export async function eventsAround(db: AppDb, userId: string, from: number, to: number): Promise<StoredEvent[]> {
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        gte(calendarEvents.startsAt, from - 24 * 60 * 60 * 1000),
        lte(calendarEvents.startsAt, to),
        gt(calendarEvents.endsAt, from),
      ),
    )
    .orderBy(asc(calendarEvents.startsAt));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    meetingUrl: row.meetingUrl,
    platform: row.platform,
    participants: decode<{ email: string; name: string | null }[]>(row.participantsJson, []),
    recordChoice: row.recordChoice,
    recordedMeetingId: row.recordedMeetingId,
  }));
}

/** Points the event at its recording, unless an earlier recording of it already claimed it. */
export async function markRecorded(db: AppDb, userId: string, eventId: string, meetingId: string): Promise<void> {
  await db
    .update(calendarEvents)
    .set({ recordedMeetingId: meetingId })
    .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.userId, userId), isNull(calendarEvents.recordedMeetingId)));
}

/** Records whether to record this meeting; null goes back to the Mac's setting. False when the event isn't the user's. */
export async function setRecordChoice(db: AppDb, userId: string, eventId: string, choice: 'record' | 'skip' | null): Promise<boolean> {
  const updated = await db
    .update(calendarEvents)
    .set({ recordChoice: choice })
    .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.userId, userId)))
    .returning({ id: calendarEvents.id });
  return updated.length > 0;
}
