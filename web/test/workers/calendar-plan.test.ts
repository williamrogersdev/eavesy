import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema';
import * as calendarRepo from '../../src/db/repo/calendar';
import { JOIN_EARLY_MS, reconcileCalendarBots } from '../../src/server/meeting-bots/calendar-plan';
import type { MeetingBotsEnv } from '../../src/server/meeting-bots/control';
import { ACTIVE_BOT_LIMIT, HAND_SENT_RESERVE, placeBot } from '../../src/server/meeting-bots/service';
import { insertUser, resetTables, testEnv } from './support';

const NOW = Date.UTC(2026, 10, 5, 15);
const HOUR = 60 * 60 * 1000;
const db = () => drizzle(testEnv.DB, { schema });

function fakeBots() {
  const control = {
    schedule: vi.fn(async (_id: string, _joinAt: number | null) => {}),
    leave: vi.fn(async (_id: string) => {}),
    stop: vi.fn(async (_id: string) => {}),
  };
  return { env: { MEETING_BOTS: control } as unknown as MeetingBotsEnv, control };
}

async function addEvent(id: string, over: Partial<typeof schema.calendarEvents.$inferInsert> = {}) {
  await db().insert(schema.calendarEvents).values({
    id,
    userId: 'user_a',
    connectionId: 'cal_a',
    providerEventId: `g_${id}`,
    title: 'Numeral intro',
    startsAt: NOW + 2 * HOUR,
    endsAt: NOW + 3 * HOUR,
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    platform: 'meet',
    participantsJson: JSON.stringify([{ email: 'me@example.com', name: null }, { email: 'ben@numeral.com', name: 'Ben' }]),
    ...over,
  });
}

async function activeBots() {
  const rows = await db().select().from(schema.meetingBots);
  return rows.filter((bot) => !['done', 'failed', 'cancelled'].includes(bot.status));
}

async function setDefault(mode: 'mac' | 'notetaker' | 'both', notetakerName: string | null = null) {
  await db().update(schema.users).set({ meetingCaptureDefault: mode, notetakerName, displayName: 'William Rogers' }).where(eq(schema.users.id, 'user_a'));
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetTables('meeting_bots', 'calendar_events', 'calendar_connections', 'users');
  await insertUser('user_a');
  await db().insert(schema.calendarConnections).values({ id: 'cal_a', userId: 'user_a', provider: 'google', accountEmail: 'me@example.com', refreshTokenEncrypted: 'rt' });
});

describe('the Notetaker follows the calendar', () => {
  it('sends one bot, named for its owner, to each Notetaker meeting, a minute early', async () => {
    await setDefault('notetaker');
    await addEvent('evt_a');
    const { env, control } = fakeBots();
    expect(await reconcileCalendarBots(db(), env, 'user_a', NOW)).toMatchObject({ scheduled: 1, withdrawn: 0 });
    const [bot] = await activeBots();
    expect(bot).toMatchObject({ calendarEventId: 'evt_a', botName: "William Rogers' Notetaker", joinAt: NOW + 2 * HOUR - JOIN_EARLY_MS, status: 'scheduled' });
    expect(control.schedule).toHaveBeenCalledWith(bot!.id, NOW + 2 * HOUR - JOIN_EARLY_MS);
    // Every sync runs the plan again; the bot on its way is kept.
    expect(await reconcileCalendarBots(db(), env, 'user_a', NOW + 60_000)).toMatchObject({ scheduled: 0, withdrawn: 0 });
    expect(await activeBots()).toHaveLength(1);
  });

  it('uses the name the owner chose', async () => {
    await setDefault('notetaker', 'Will’s notes');
    await addEvent('evt_a');
    await reconcileCalendarBots(db(), fakeBots().env, 'user_a', NOW);
    expect((await activeBots())[0]!.botName).toBe('Will’s notes');
  });

  it('leaves Mac meetings alone, and follows each meeting’s own choice over the default', async () => {
    await setDefault('mac');
    await addEvent('evt_mac');
    await addEvent('evt_both', { providerEventId: 'g_both', meetingUrl: 'https://meet.google.com/xyz-abcd-efg', startsAt: NOW + 4 * HOUR, endsAt: NOW + 5 * HOUR });
    await calendarRepo.setCaptureMode(db(), 'user_a', 'evt_both', 'both');
    await reconcileCalendarBots(db(), fakeBots().env, 'user_a', NOW);
    expect((await activeBots()).map((bot) => bot.calendarEventId)).toEqual(['evt_both']);
  });

  it('withdraws a bot that hasn’t joined when its meeting switches to the Mac or is skipped', async () => {
    await setDefault('notetaker');
    await addEvent('evt_a');
    const { env, control } = fakeBots();
    await reconcileCalendarBots(db(), env, 'user_a', NOW);
    await calendarRepo.setCaptureMode(db(), 'user_a', 'evt_a', 'mac');
    expect(await reconcileCalendarBots(db(), env, 'user_a', NOW + 1000)).toMatchObject({ withdrawn: 1 });
    expect(await activeBots()).toHaveLength(0);
    const cancelled = (await db().select().from(schema.meetingBots))[0]!;
    expect(cancelled).toMatchObject({ status: 'cancelled', statusDetail: 'calendar_plan_changed' });
    expect(control.stop).toHaveBeenCalledWith(cancelled.id);
  });

  it('sends the bot again when the meeting moves, and never pulls one out of a call', async () => {
    await setDefault('notetaker');
    await addEvent('evt_a');
    const { env } = fakeBots();
    await reconcileCalendarBots(db(), env, 'user_a', NOW);
    await db().update(schema.calendarEvents).set({ startsAt: NOW + 6 * HOUR, endsAt: NOW + 7 * HOUR }).where(eq(schema.calendarEvents.id, 'evt_a'));
    expect(await reconcileCalendarBots(db(), env, 'user_a', NOW + 1000)).toMatchObject({ scheduled: 1, withdrawn: 1 });
    const [moved] = await activeBots();
    expect(moved!.joinAt).toBe(NOW + 6 * HOUR - JOIN_EARLY_MS);

    // In the call: switching the meeting to the Mac doesn't drag the bot out.
    await db().update(schema.meetingBots).set({ status: 'recording' }).where(eq(schema.meetingBots.id, moved!.id));
    await calendarRepo.setCaptureMode(db(), 'user_a', 'evt_a', 'skip');
    expect(await reconcileCalendarBots(db(), env, 'user_a', NOW + 2000)).toMatchObject({ withdrawn: 0 });
    expect((await activeBots())[0]!.status).toBe('recording');
  });

  it('skips calls the bot can’t join, and never touches a bot sent by hand', async () => {
    await setDefault('notetaker');
    await addEvent('evt_zoom', { meetingUrl: 'https://zoom.us/j/123', platform: 'zoom' });
    await addEvent('evt_meet', { providerEventId: 'g_meet', startsAt: NOW + 4 * HOUR, endsAt: NOW + 5 * HOUR });
    const { env } = fakeBots();
    // Sent by hand to the same Meet call before the plan ran.
    await placeBot(db(), env, 'user_a', { url: 'https://meet.google.com/abc-defg-hij', platform: 'meet', title: null, folderId: null, joinAt: NOW + 4 * HOUR - 5 * 60_000, calendarEventId: null, botName: 'x' }, NOW);
    const result = await reconcileCalendarBots(db(), env, 'user_a', NOW);
    expect(result).toMatchObject({ scheduled: 0, skipped: ['evt_zoom'] });
    const bots = await activeBots();
    expect(bots).toHaveLength(1);
    expect(bots[0]!.calendarEventId).toBeNull();
    // Switching the meeting off doesn't cancel the bot the owner sent themselves.
    await calendarRepo.setCaptureMode(db(), 'user_a', 'evt_meet', 'skip');
    await reconcileCalendarBots(db(), env, 'user_a', NOW + 1000);
    expect(await activeBots()).toHaveLength(1);
  });

  it('does nothing where the meeting-bot service isn’t deployed', async () => {
    await setDefault('notetaker');
    await addEvent('evt_a');
    const read = vi.spyOn(calendarRepo, 'eventsAround');
    expect(await reconcileCalendarBots(db(), {} as MeetingBotsEnv, 'user_a', NOW)).toMatchObject({ scheduled: 0 });
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(await activeBots()).toHaveLength(0);
  });

  it('leaves a bot that is already launching alone, even when the plan changes', async () => {
    await setDefault('notetaker');
    await addEvent('evt_a');
    const { env, control } = fakeBots();
    await reconcileCalendarBots(db(), env, 'user_a', NOW);
    await db().update(schema.meetingBots).set({ statusDetail: 'launching' });
    await calendarRepo.setCaptureMode(db(), 'user_a', 'evt_a', 'skip');
    expect(await reconcileCalendarBots(db(), env, 'user_a', NOW + 1000)).toMatchObject({ withdrawn: 0 });
    expect(await activeBots()).toHaveLength(1);
    expect(control.stop).not.toHaveBeenCalled();
  });

  it('doesn’t send another bot to a meeting whose bot failed or that the owner cancelled', async () => {
    await setDefault('notetaker');
    await addEvent('evt_a');
    await addEvent('evt_b', { providerEventId: 'g_b', meetingUrl: 'https://meet.google.com/xyz-abcd-efg', startsAt: NOW + 4 * HOUR, endsAt: NOW + 5 * HOUR });
    const { env } = fakeBots();
    await reconcileCalendarBots(db(), env, 'user_a', NOW);
    await db().update(schema.meetingBots).set({ status: 'cancelled', statusDetail: 'cancelled_by_user' }).where(eq(schema.meetingBots.calendarEventId, 'evt_a'));
    await db().update(schema.meetingBots).set({ status: 'failed', statusDetail: 'provider_unavailable' }).where(eq(schema.meetingBots.calendarEventId, 'evt_b'));
    expect(await reconcileCalendarBots(db(), env, 'user_a', NOW + 1000)).toMatchObject({ scheduled: 0 });
    expect(await activeBots()).toHaveLength(0);
  });

  it('a new Notetaker name reaches bots that haven’t joined', async () => {
    await setDefault('notetaker');
    await addEvent('evt_a');
    const { env } = fakeBots();
    await reconcileCalendarBots(db(), env, 'user_a', NOW);
    await setDefault('notetaker', 'Will’s notes');
    expect(await reconcileCalendarBots(db(), env, 'user_a', NOW + 1000)).toMatchObject({ scheduled: 1, withdrawn: 1 });
    const [bot] = await activeBots();
    expect(bot!.botName).toBe('Will’s notes');
    const withdrawn = (await db().select().from(schema.meetingBots)).find((b) => b.status === 'cancelled');
    expect(withdrawn!.statusDetail).toBe('calendar_renamed');
  });

  it('a Notetaker default on a Zoom call leaves it to the Mac', async () => {
    await setDefault('notetaker');
    await addEvent('evt_zoom', { meetingUrl: 'https://zoom.us/j/123', platform: 'zoom' });
    const [event] = await calendarRepo.eventsAround(db(), 'user_a', NOW, NOW + 24 * HOUR);
    expect(event).toBeDefined();
    expect(await reconcileCalendarBots(db(), fakeBots().env, 'user_a', NOW)).toMatchObject({ scheduled: 0, skipped: ['evt_zoom'] });
  });

  it('an older Mac’s “record” adds the Mac to a Notetaker plan instead of dropping the Notetaker', async () => {
    await addEvent('evt_a');
    await calendarRepo.setCaptureMode(db(), 'user_a', 'evt_a', 'notetaker');
    await calendarRepo.setRecordChoice(db(), 'user_a', 'evt_a', 'record');
    const [row] = await db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, 'evt_a'));
    expect(row!.captureMode).toBe('both');
    await calendarRepo.setCaptureMode(db(), 'user_a', 'evt_a', null);
    await calendarRepo.setRecordChoice(db(), 'user_a', 'evt_a', 'record');
    expect((await db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, 'evt_a')))[0]!.captureMode).toBe('mac');
  });

  it('the plan leaves room for bots sent by hand', async () => {
    await setDefault('notetaker');
    for (let i = 0; i < ACTIVE_BOT_LIMIT; i++) {
      await addEvent(`evt_${i}`, { providerEventId: `g_${i}`, meetingUrl: `https://meet.google.com/abc-defg-hi${String.fromCharCode(97 + i)}`, startsAt: NOW + (i + 1) * HOUR, endsAt: NOW + (i + 1) * HOUR + 1800_000 });
    }
    const { env } = fakeBots();
    await reconcileCalendarBots(db(), env, 'user_a', NOW);
    expect(await activeBots()).toHaveLength(ACTIVE_BOT_LIMIT - HAND_SENT_RESERVE);
    for (const code of ['zzz-zzzz-zza', 'zzz-zzzz-zzb', 'zzz-zzzz-zzc']) {
      const byHand = await placeBot(db(), env, 'user_a', { url: `https://meet.google.com/${code}`, platform: 'meet', title: null, folderId: null, joinAt: null, calendarEventId: null, botName: 'x' }, NOW);
      expect('bot' in byHand).toBe(true);
    }
    expect(await activeBots()).toHaveLength(ACTIVE_BOT_LIMIT);
    // At the limit, a planned meeting that moves (still the first one) gets its bot back.
    await db().update(schema.calendarEvents).set({ startsAt: NOW + HOUR + 10 * 60_000 }).where(eq(schema.calendarEvents.id, 'evt_0'));
    expect(await reconcileCalendarBots(db(), env, 'user_a', NOW + 1000)).toMatchObject({ scheduled: 1, withdrawn: 1 });
    expect((await activeBots()).find((bot) => bot.calendarEventId === 'evt_0')!.joinAt).toBe(NOW + HOUR + 10 * 60_000 - JOIN_EARLY_MS);
  });
});
