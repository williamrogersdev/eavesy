import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../../src/db/schema';
import * as calendarRepo from '../../src/db/repo/calendar';
import { BACKGROUND_STALE_MS, syncAllDue, syncConnection } from '../../src/server/calendar-sync';
import { CALENDAR_LIST_SCOPE, GOOGLE_SCOPES } from '../../src/server/google-calendar';
import { insertUser, resetTables, testEnv } from './support';

const NOW = Date.UTC(2026, 10, 5, 15);
const HOUR = 60 * 60 * 1000;
const db = () => drizzle(testEnv.DB, { schema });

const CALENDARS = [
  { id: 'me@example.com', summary: 'Me', primary: true, selected: true, accessRole: 'owner' },
  { id: 'team@group.calendar.google.com', summary: 'Team', selected: true, accessRole: 'reader' },
  { id: 'side@group.calendar.google.com', summary: 'Side project', selected: false, accessRole: 'owner' },
  { id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays', selected: true, accessRole: 'reader' },
];

function googleEvent(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    summary: title,
    start: { dateTime: new Date(NOW + HOUR).toISOString() },
    end: { dateTime: new Date(NOW + 2 * HOUR).toISOString() },
    attendees: [{ email: 'me@example.com' }, { email: 'ben@numeral.com', displayName: 'Ben' }],
    ...extra,
  };
}

/** Google, as far as a sync sees it: the token endpoint, the calendar list and each calendar's events. */
function fakeGoogle(byCalendar: Record<string, unknown[]>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'at' });
    if (url.pathname.endsWith('/users/me/calendarList')) return Response.json({ items: CALENDARS });
    const calendar = decodeURIComponent(url.pathname.split('/calendars/')[1]!.replace(/\/events$/, ''));
    if (!(calendar in byCalendar)) return new Response(null, { status: 404 });
    return Response.json({ items: byCalendar[calendar] });
  });
  return calls;
}

async function addConnection(id: string, scopes: string[], extra: Partial<typeof schema.calendarConnections.$inferInsert> = {}) {
  await db().insert(schema.calendarConnections).values({
    id,
    userId: 'user_a',
    provider: 'google',
    accountEmail: `${id}@example.com`,
    refreshTokenEncrypted: 'rt',
    scopes: scopes.join(' '),
    ...extra,
  });
  return (await calendarRepo.getConnection(db(), 'user_a', id))!;
}

async function storedTitles() {
  const rows = await db().select().from(schema.calendarEvents);
  return rows.map((row) => `${row.title}@${row.calendarId}`).sort();
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetTables('calendar_events', 'calendar_connections', 'users');
  await insertUser('user_a');
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('calendar sync across an account’s calendars', () => {
  it('reads the ticked calendars, keeps invite text, and leaves unticked and holiday calendars out', async () => {
    fakeGoogle({
      primary: [googleEvent('a', 'Numeral intro', { description: '<p>Agenda:</p><ul><li>Pricing</li><li>Next steps</li></ul>' })],
      'team@group.calendar.google.com': [googleEvent('b', 'Team sync')],
      'side@group.calendar.google.com': [googleEvent('c', 'Side thing')],
      'en.usa#holiday@group.v.calendar.google.com': [googleEvent('d', 'A holiday')],
    });
    const connection = await addConnection('cal_a', [...GOOGLE_SCOPES, CALENDAR_LIST_SCOPE]);
    expect(await syncConnection(db(), connection, NOW)).toBe('ok');
    expect(await storedTitles()).toEqual(['Numeral intro@primary', 'Team sync@team@group.calendar.google.com']);
    const intro = (await db().select().from(schema.calendarEvents)).find((row) => row.title === 'Numeral intro')!;
    expect(intro.description).toBe('Agenda:\n- Pricing\n- Next steps');

    const saved = calendarRepo.storedCalendars((await calendarRepo.getConnection(db(), 'user_a', 'cal_a'))!);
    expect(saved.map((c) => [c.name, c.selected])).toEqual([
      ['Me', true],
      ['Team', true],
      ['Side project', false],
      ['Holidays', false],
    ]);
  });

  it('a choice sticks across syncs: unticking drops that calendar’s meetings, ticking adds them', async () => {
    fakeGoogle({
      primary: [googleEvent('a', 'Numeral intro')],
      'team@group.calendar.google.com': [googleEvent('b', 'Team sync')],
      'side@group.calendar.google.com': [googleEvent('c', 'Side thing')],
    });
    await addConnection('cal_a', [...GOOGLE_SCOPES, CALENDAR_LIST_SCOPE]);
    await syncConnection(db(), (await calendarRepo.getConnection(db(), 'user_a', 'cal_a'))!, NOW);

    expect(await calendarRepo.setSelectedCalendars(db(), 'user_a', 'cal_a', [
      { id: 'team@group.calendar.google.com', selected: false },
      { id: 'side@group.calendar.google.com', selected: true },
      // The primary calendar can't be unticked.
      { id: 'me@example.com', selected: false },
    ])).toBe('ok');
    const marked = (await calendarRepo.getConnection(db(), 'user_a', 'cal_a'))!;
    expect(marked.lastAttemptAt).toBeNull();
    await syncConnection(db(), marked, NOW + 1000);
    expect(await storedTitles()).toEqual(['Numeral intro@primary', 'Side thing@side@group.calendar.google.com']);
    // Someone else's connection can't be changed.
    expect(await calendarRepo.setSelectedCalendars(db(), 'user_b', 'cal_a', [])).toBe('not_found');
  });

  it('a calendar that can no longer be read deletes nothing', async () => {
    fakeGoogle({ primary: [googleEvent('a', 'Numeral intro')], 'team@group.calendar.google.com': [googleEvent('b', 'Team sync')] });
    await addConnection('cal_a', [...GOOGLE_SCOPES, CALENDAR_LIST_SCOPE]);
    await syncConnection(db(), (await calendarRepo.getConnection(db(), 'user_a', 'cal_a'))!, NOW);
    // Team is unshared: its listing 404s, so its stored meeting stays until a complete listing.
    fakeGoogle({ primary: [googleEvent('a', 'Numeral intro')] });
    expect(await syncConnection(db(), (await calendarRepo.getConnection(db(), 'user_a', 'cal_a'))!, NOW + 1000)).toBe('ok');
    expect(await storedTitles()).toEqual(['Numeral intro@primary', 'Team sync@team@group.calendar.google.com']);
  });

  it('a grant from before the calendar list reads the primary calendar only', async () => {
    const calls = fakeGoogle({ primary: [googleEvent('a', 'Numeral intro')], 'team@group.calendar.google.com': [googleEvent('b', 'Team sync')] });
    await addConnection('cal_old', GOOGLE_SCOPES);
    expect(await syncConnection(db(), (await calendarRepo.getConnection(db(), 'user_a', 'cal_old'))!, NOW)).toBe('ok');
    expect(await storedTitles()).toEqual(['Numeral intro@primary']);
    expect(calls.some((path) => path.endsWith('/calendarList'))).toBe(false);
  });
});

describe('background sync', () => {
  it('syncs every stale connection, and leaves fresh ones and broken grants alone', async () => {
    fakeGoogle({ primary: [googleEvent('a', 'Numeral intro')] });
    await addConnection('stale', GOOGLE_SCOPES, { lastAttemptAt: NOW - BACKGROUND_STALE_MS - 1 });
    await addConnection('never', GOOGLE_SCOPES);
    await addConnection('fresh', GOOGLE_SCOPES, { lastAttemptAt: NOW - 1000, lastSyncStatus: 'ok' });
    await addConnection('broken', GOOGLE_SCOPES, { lastAttemptAt: NOW - 10 * BACKGROUND_STALE_MS, lastSyncStatus: 'reconnect' });
    expect(await syncAllDue(db(), NOW)).toEqual({ synced: 2 });
    const rows = await db().select().from(schema.calendarConnections);
    const synced = rows.filter((row) => row.lastSyncAt === NOW).map((row) => row.id).sort();
    expect(synced).toEqual(['never', 'stale']);
  });
});
