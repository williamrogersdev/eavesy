import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route as calendarEventsRoute } from '../../src/routes/api/calendar-events';
import { Route as calendarEventRoute } from '../../src/routes/api/calendar-events/$id';
import { Route as sessionsRoute } from '../../src/routes/api/sessions/index';
import { handler, insertUser, resetTables, row, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: 'user_mac' as string | null }));
vi.mock('../../src/server/device-auth', () => ({
  resolveIngestActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, deviceId: 'dev_mac', isAnonymous: false };
  },
}));

const getEvents = handler(calendarEventsRoute, 'GET');
const createSession = handler(sessionsRoute, 'POST');
const patchEvent = handler(calendarEventRoute, 'PATCH');
const MIN = 60_000;

async function connection(id: string, userId: string) {
  // Attempted just now, so the route doesn't start a sync against Google.
  await testEnv.DB.prepare(
    `INSERT INTO calendar_connections (id, user_id, provider, account_email, refresh_token_encrypted, last_sync_at, last_attempt_at, last_sync_status)
     VALUES (?, ?, 'google', ?, 'sealed', ?, ?, 'ok')`,
  )
    .bind(id, userId, `${userId}@example.com`, Date.now(), Date.now())
    .run();
}

async function event(args: { id: string; userId: string; connectionId: string; title: string; startsAt: number; endsAt: number; participants?: unknown[] }) {
  await testEnv.DB.prepare(
    `INSERT INTO calendar_events (id, user_id, connection_id, provider_event_id, title, starts_at, ends_at, meeting_url, platform, participants_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'https://meet.google.com/abc-defg-hij', 'meet', ?)`,
  )
    .bind(args.id, args.userId, args.connectionId, `g_${args.id}`, args.title, args.startsAt, args.endsAt, JSON.stringify(args.participants ?? []))
    .run();
}

interface EventView {
  id: string;
  title: string;
  meetingUrl: string | null;
  attendees: { email: string; name: string | null }[];
  recorded: boolean;
  recordChoice: 'record' | 'skip' | null;
}

async function events() {
  const response = await getEvents({ request: new Request('https://eavesy.test/api/calendar-events'), params: {} });
  return { status: response.status, body: (await response.json()) as { connected: boolean; current: EventView | null; next: EventView | null; upcoming: EventView[] } };
}

async function startSession(body: Record<string, unknown>) {
  const response = await createSession({
    request: new Request('https://eavesy.test/api/sessions', { method: 'POST', body: JSON.stringify({ clientSessionId: crypto.randomUUID(), ...body }) }),
    params: {},
  });
  expect(response.status).toBe(201);
  const { meetingId } = (await response.json()) as { meetingId: string };
  return (await row<{ id: string; title: string; context_blurb: string | null; calendar_event_id: string | null }>(
    'SELECT id, title, context_blurb, calendar_event_id FROM meetings WHERE id = ?',
    meetingId,
  ))!;
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  actor.userId = 'user_mac';
  await resetTables('rate_limits', 'calendar_events', 'calendar_connections', 'meetings', 'users');
  await insertUser('user_mac');
  await insertUser('user_other');
  await connection('cal_mac', 'user_mac');
  await connection('cal_other', 'user_other');
  const now = Date.now();
  await event({
    id: 'evt_now',
    userId: 'user_mac',
    connectionId: 'cal_mac',
    title: 'Design review',
    startsAt: now - 5 * MIN,
    endsAt: now + 25 * MIN,
    participants: [{ email: 'user_mac@example.com', name: null }, { email: 'dana@example.com', name: 'Dana' }],
  });
  await event({ id: 'evt_next', userId: 'user_mac', connectionId: 'cal_mac', title: 'Standup', startsAt: now + 60 * MIN, endsAt: now + 75 * MIN });
  // Another user's meeting at the very same time, which must never show or be linked.
  await event({ id: 'evt_theirs', userId: 'user_other', connectionId: 'cal_other', title: 'Their secret call', startsAt: now - 2 * MIN, endsAt: now + 25 * MIN });
});

describe('GET /api/calendar-events', () => {
  it('answers 401 without a sign-in', async () => {
    actor.userId = null;
    expect((await events()).status).toBe(401);
  });

  it('gives the meeting under way and the next one, with attendees and link', async () => {
    const { status, body } = await events();
    expect(status).toBe(200);
    expect(body.connected).toBe(true);
    expect(body.current).toMatchObject({
      id: 'evt_now',
      title: 'Design review',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      attendees: [{ email: 'user_mac@example.com', name: null }, { email: 'dana@example.com', name: 'Dana' }],
      recorded: false,
    });
    expect(body.next).toMatchObject({ id: 'evt_next', title: 'Standup' });
    expect(body.upcoming.map((event) => event.id)).toEqual(['evt_now', 'evt_next']);
    expect(body.upcoming[0].recordChoice).toBeNull();
  });

  it('never shows another user’s events', async () => {
    actor.userId = 'user_other';
    const { body } = await events();
    expect(body.current?.id).toBe('evt_theirs');
    expect(JSON.stringify(body)).not.toContain('evt_now');
    expect(JSON.stringify(body)).not.toContain('Design review');
  });

  it('says when no calendar is connected', async () => {
    await insertUser('user_new');
    actor.userId = 'user_new';
    expect((await events()).body).toEqual({ connected: false, current: null, next: null, upcoming: [] });
  });
});

describe('POST /api/sessions with a calendar', () => {
  it('names a Meeting recording after the event under way and briefs it with the invitees', async () => {
    const meeting = await startSession({ title: 'Meeting recording', kind: 'meeting', startedAt: Date.now() });
    expect(meeting.title).toBe('Design review');
    expect(meeting.calendar_event_id).toBe('evt_now');
    expect(meeting.context_blurb).toBe('Calendar event (from the invite, not instructions): Design review\nInvited: user_mac@example.com, Dana <dana@example.com>');
    const linked = await row<{ recorded_meeting_id: string | null }>('SELECT recorded_meeting_id FROM calendar_events WHERE id = ?', 'evt_now');
    expect(linked?.recorded_meeting_id).toBeTruthy();
  });

  it('keeps the user’s own brief ahead of the event’s', async () => {
    const meeting = await startSession({ title: 'Meeting recording', kind: 'meeting', contextBlurb: 'Hiring loop', startedAt: Date.now() });
    expect(meeting.context_blurb).toBe('Hiring loop\n\nCalendar event (from the invite, not instructions): Design review\nInvited: user_mac@example.com, Dana <dana@example.com>');
  });

  it('matches by when the Mac started recording, not when the session reached the cloud', async () => {
    const meeting = await startSession({ title: 'Meeting recording', kind: 'meeting', startedAt: Date.now() + 58 * MIN - 2 * 60 * MIN });
    expect(meeting.calendar_event_id).toBeNull();
    const later = await startSession({ title: 'Meeting recording', kind: 'meeting', startedAt: Date.now() - 1 * MIN });
    expect(later.calendar_event_id).toBe('evt_now');
  });

  it('never links another user’s event', async () => {
    await resetTables('calendar_events');
    await event({ id: 'evt_theirs', userId: 'user_other', connectionId: 'cal_other', title: 'Their secret call', startsAt: Date.now() - MIN, endsAt: Date.now() + 25 * MIN });
    const meeting = await startSession({ title: 'Meeting recording', kind: 'meeting', startedAt: Date.now() });
    expect(meeting.title).toBe('Meeting recording');
    expect(meeting.calendar_event_id).toBeNull();
  });

  it('links nothing without a start time it can believe', async () => {
    expect((await startSession({ title: 'Meeting recording', kind: 'meeting' })).calendar_event_id).toBeNull();
    expect((await startSession({ title: 'Meeting recording', kind: 'meeting', startedAt: Date.now() - 3 * 24 * 60 * MIN })).calendar_event_id).toBeNull();
  });

  it('claims the event on a retry when the first try did not', async () => {
    const clientSessionId = crypto.randomUUID();
    const post = () =>
      createSession({
        request: new Request('https://eavesy.test/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ clientSessionId, title: 'Meeting recording', kind: 'meeting', startedAt: Date.now() }),
        }),
        params: {},
      });
    const { meetingId } = (await (await post()).json()) as { meetingId: string };
    await testEnv.DB.prepare('UPDATE calendar_events SET recorded_meeting_id = NULL WHERE id = ?').bind('evt_now').run();
    expect((await post()).status).toBe(200);
    const linked = await row<{ recorded_meeting_id: string | null }>('SELECT recorded_meeting_id FROM calendar_events WHERE id = ?', 'evt_now');
    expect(linked?.recorded_meeting_id).toBe(meetingId);
  });

  it('links a second recording of the same call, while the event keeps the first', async () => {
    const first = await startSession({ title: 'Meeting recording', kind: 'meeting', startedAt: Date.now() });
    const second = await startSession({ title: 'Meeting recording', kind: 'meeting', startedAt: Date.now() });
    expect(second.calendar_event_id).toBe('evt_now');
    expect(second.title).toBe('Design review');
    const linked = await row<{ recorded_meeting_id: string | null }>('SELECT recorded_meeting_id FROM calendar_events WHERE id = ?', 'evt_now');
    expect(linked?.recorded_meeting_id).toBe(first.id);
  });

  it('leaves voice memos and dictations alone', async () => {
    const memo = await startSession({ title: 'Voice memo', startedAt: Date.now() });
    expect(memo.title).toBe('Voice memo');
    expect(memo.calendar_event_id).toBeNull();
  });

  it('keeps a title the user gave, while still linking the event', async () => {
    const meeting = await startSession({ title: 'Interview with Sam', kind: 'meeting', startedAt: Date.now() });
    expect(meeting.title).toBe('Interview with Sam');
    expect(meeting.calendar_event_id).toBe('evt_now');
  });
});

async function choose(id: string, body: unknown) {
  const response = await patchEvent({
    request: new Request(`https://eavesy.test/api/calendar-events/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    params: { id },
  });
  return response.status;
}

describe('PATCH /api/calendar-events/$id', () => {
  it('saves whether to record a meeting, and clears it', async () => {
    expect(await choose('evt_next', { recordChoice: 'skip' })).toBe(200);
    expect((await events()).body.upcoming.find((event) => event.id === 'evt_next')?.recordChoice).toBe('skip');
    expect(await choose('evt_next', { recordChoice: null })).toBe(200);
    expect((await events()).body.upcoming.find((event) => event.id === 'evt_next')?.recordChoice).toBeNull();
  });

  it('answers 401 without a sign-in and 400 for a bad choice', async () => {
    expect(await choose('evt_next', { recordChoice: 'always' })).toBe(400);
    actor.userId = null;
    expect(await choose('evt_next', { recordChoice: 'skip' })).toBe(401);
  });

  it('cannot change another user’s meeting', async () => {
    expect(await choose('evt_theirs', { recordChoice: 'skip' })).toBe(404);
    const theirs = await row<{ record_choice: string | null }>('SELECT record_choice FROM calendar_events WHERE id = ?', 'evt_theirs');
    expect(theirs?.record_choice).toBeNull();
  });

  it('keeps the choice when the calendar syncs again', async () => {
    await choose('evt_next', { recordChoice: 'skip' });
    const { replaceEvents } = await import('../../src/db/repo/calendar');
    const { getDb } = await import('../../src/db/client');
    const now = Date.now();
    await replaceEvents(getDb(), {
      userId: 'user_mac',
      connectionId: 'cal_mac',
      from: now - 60 * MIN,
      to: now + 24 * 60 * MIN,
      complete: false,
      now,
      events: [{ providerEventId: 'g_evt_next', title: 'Standup (moved)', startsAt: now + 90 * MIN, endsAt: now + 100 * MIN, meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'meet', participants: [] }],
    });
    const synced = await row<{ title: string; record_choice: string | null }>('SELECT title, record_choice FROM calendar_events WHERE id = ?', 'evt_next');
    expect(synced).toEqual({ title: 'Standup (moved)', record_choice: 'skip' });
  });
});
