import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { AppDb } from '../client';
import { encode } from '../codec';
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
      .set({ refreshTokenEncrypted: args.refreshTokenEncrypted })
      .where(eq(calendarConnections.id, existing.id));
    return existing.id;
  }
  const id = pid('cal');
  await db.insert(calendarConnections).values({ id, ...args, lastSyncAt: null });
  return id;
}

export async function deleteConnection(db: AppDb, userId: string, id: string): Promise<void> {
  await db.batch([
    db.delete(calendarEvents).where(and(eq(calendarEvents.connectionId, id), eq(calendarEvents.userId, userId))),
    db.delete(calendarConnections).where(and(eq(calendarConnections.id, id), eq(calendarConnections.userId, userId))),
  ]);
}

/**
 * Makes the stored events between `from` and `to` match `events`: new ones are
 * added, changed ones updated (keeping `autoRecord` and the recorded meeting),
 * and ones that went away are dropped unless a recording points at them.
 */
export async function replaceEvents(
  db: AppDb,
  args: { userId: string; connectionId: string; from: number; to: number; events: CalendarEventInput[]; now: number },
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
  const gone = current.filter((row) => !keep.has(row.providerEventId)).map((row) => row.id);

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
  const touch = db.update(calendarConnections).set({ lastSyncAt: args.now }).where(eq(calendarConnections.id, connectionId));
  await db.batch([touch, ...writes, ...deletes]);
}

export async function countUpcoming(db: AppDb, connectionId: string, from: number, to: number): Promise<number> {
  const rows = await db
    .select({ id: calendarEvents.id })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.connectionId, connectionId), gte(calendarEvents.startsAt, from), lte(calendarEvents.startsAt, to)));
  return rows.length;
}
