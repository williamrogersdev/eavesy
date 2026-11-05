import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import type { AppDb } from '../client';
import { decode, encode } from '../codec';
import { pid } from '../ids';
import { calendarConnections, calendarEvents } from '../schema';
import { UNTITLED_EVENT } from '@/lib/calendar/match';
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
  connectionId: string;
  providerEventId: string;
  title: string;
  startsAt: number;
  endsAt: number;
  meetingUrl: string | null;
  platform: string | null;
  participants: { email: string; name: string | null }[];
  recordChoice: 'record' | 'skip' | null;
  recordedMeetingId: string | null;
};

/**
 * The user's events under way or starting between `from` and `to` (ones begun
 * over a day before `from` are left out), with one entry per meeting even when
 * several connected calendars carry it.
 */
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
    .orderBy(asc(calendarEvents.startsAt), asc(calendarEvents.id));
  // The user's own addresses are on every copy, so they never show two copies are one meeting.
  const own = (await db.select({ email: calendarConnections.accountEmail }).from(calendarConnections).where(eq(calendarConnections.userId, userId)))
    .map((row) => row.email);
  return mergeShared(rows.map((row) => ({
    id: row.id,
    connectionId: row.connectionId,
    providerEventId: row.providerEventId,
    title: row.title,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    meetingUrl: row.meetingUrl,
    platform: row.platform,
    participants: decode<{ email: string; name: string | null }[]>(row.participantsJson, []),
    recordChoice: row.recordChoice,
    recordedMeetingId: row.recordedMeetingId,
  })), own);
}

/** A call link without its query or fragment, so one meeting's link matches across invites. */
function linkKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

/** Strong signs two stored events are the same meeting: the same Google event, or the same call link, at the same start. */
function sameMeetingKeys(event: StoredEvent): string[] {
  const keys = [`id:${event.providerEventId}@${event.startsAt}`];
  if (event.meetingUrl) keys.push(`url:${linkKey(event.meetingUrl)}@${event.startsAt}`);
  return keys;
}

/** A weaker sign, used only between different calendars: the same real title and times. */
function titleTimeKey(event: StoredEvent): string | null {
  return event.title === UNTITLED_EVENT ? null : `at:${event.title}@${event.startsAt}-${event.endsAt}`;
}

/** Which copy stands for the meeting: the recorded one, else one with a record choice, else the first. */
function rank(event: StoredEvent): number {
  return event.recordedMeetingId ? 2 : event.recordChoice ? 1 : 0;
}

/**
 * Collapses copies of one meeting that arrive from more than one connected
 * calendar (an invite between two of your own accounts, say) into one, keeping
 * order. Copies sharing a Google id or call link chain together: one sharing
 * an id with a second and a link with a third joins all three. Without either,
 * copies merge on the same title and times only when they come from different
 * calendars, the title is a real one and they have an attendee in common
 * other than the user (`ownEmails`), so two "Focus time" blocks, or two blocks
 * on one calendar, stay apart.
 *
 * One copy stands for the meeting, chosen the same way every time: a recorded
 * one, else one with a record choice, else the first. Its id is what Settings
 * and the Mac show and edit, so its record choice wins when copies disagree;
 * it takes another copy's only when it has none. Likewise only its recording
 * shows: copies recorded separately before they were merged keep their own
 * links in the database, but the merged entry names the kept copy's. Its
 * attendees are everyone's, and it takes a call link if it lacked one.
 */
export function mergeShared(events: StoredEvent[], ownEmails: readonly string[] = []): StoredEvent[] {
  const own = new Set(ownEmails.map((email) => email.toLowerCase()));
  const parent = events.map((_, i) => i);
  const connections = events.map((event) => new Set([event.connectionId]));
  const emails = events.map((event) => new Set(event.participants.map((p) => p.email.toLowerCase()).filter((email) => !own.has(email))));
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a === b) return;
    const [root, child] = a < b ? [a, b] : [b, a];
    parent[child] = root;
    for (const c of connections[child]) connections[root].add(c);
    for (const e of emails[child]) emails[root].add(e);
  };
  const firstWith = new Map<string, number>();
  events.forEach((event, i) => {
    for (const key of sameMeetingKeys(event)) {
      const j = firstWith.get(key);
      if (j === undefined) firstWith.set(key, i);
      else union(i, j);
    }
  });
  // Title and time only join whole groups that share no calendar, so a copy
  // elsewhere can never pull two of one calendar's blocks together.
  const byTitleTime = new Map<string, number[]>();
  events.forEach((event, i) => {
    const key = titleTimeKey(event);
    if (key) byTitleTime.set(key, [...(byTitleTime.get(key) ?? []), i]);
  });
  for (const members of byTitleTime.values()) {
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const a = find(members[x]);
        const b = find(members[y]);
        if (a === b) continue;
        if ([...connections[a]].some((c) => connections[b].has(c))) continue;
        if (![...emails[a]].some((e) => emails[b].has(e))) continue;
        union(a, b);
      }
    }
  }
  const groups = new Map<number, StoredEvent[]>();
  events.forEach((event, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(event);
    else groups.set(root, [event]);
  });
  // Roots are each group's first index, so the Map keeps the input's order.
  return [...groups.values()].map((copies) => {
    if (copies.length === 1) return copies[0];
    const kept = copies.reduce((best, event) => (rank(event) > rank(best) ? event : best));
    const participants = new Map<string, { email: string; name: string | null }>();
    for (const copy of copies) {
      for (const person of copy.participants) {
        const email = person.email.toLowerCase();
        const known = participants.get(email);
        if (!known || (!known.name && person.name)) participants.set(email, person);
      }
    }
    const linked = kept.meetingUrl ? kept : copies.find((copy) => copy.meetingUrl) ?? kept;
    const recordChoice = kept.recordChoice ?? copies.find((copy) => copy.recordChoice)?.recordChoice ?? null;
    return { ...kept, meetingUrl: linked.meetingUrl, platform: linked.platform, participants: [...participants.values()], recordChoice };
  });
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
