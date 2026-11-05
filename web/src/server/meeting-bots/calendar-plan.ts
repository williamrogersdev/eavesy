import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { AppDb } from '@/db/client';
import * as calendarRepo from '@/db/repo/calendar';
import { meetingBots, users } from '@/db/schema';
import { isMeetingLike } from '@/lib/calendar/match';
import { type CaptureDefault, effectiveMode, notetakerName, wantsNotetaker } from '@/lib/meetings/capture-plan';
import type { MeetingBotsEnv } from './control';
import { joinableMeeting, type MeetingBot, placeBot, withdrawBot } from './service';

/** How far ahead the plan sends bots. Every sync runs it again, so later meetings get theirs in time. */
export const PLAN_AHEAD_MS = 24 * 60 * 60 * 1000;
/** The bot asks to join this long before the start, so it's in the lobby when people arrive. */
export const JOIN_EARLY_MS = 60 * 1000;
/** A bot whose meeting moved by more than this is sent again for the new time. */
const MOVED_MS = 2 * 60 * 1000;
/** The status detail of a bot the plan itself withdrew; only those are sent again. */
const WITHDRAWN_PREFIX = 'calendar_';

export type PlanResult = { scheduled: number; withdrawn: number; skipped: string[] };

/**
 * Makes the account's Notetaker bots match its calendar: each meeting in the
 * next PLAN_AHEAD_MS whose plan includes the Notetaker (its own choice, else
 * the account default) and has a Meet or Teams link gets one bot, asked to
 * join JOIN_EARLY_MS before it starts. A bot the plan sent whose meeting no
 * longer wants it, moved, or left the calendar is withdrawn if it hasn't
 * joined; one already in the call stays. Bots sent by hand are never touched.
 */
export async function reconcileCalendarBots(db: AppDb, env: MeetingBotsEnv, userId: string, now = Date.now()): Promise<PlanResult> {
  const result: PlanResult = { scheduled: 0, withdrawn: 0, skipped: [] };
  if (!env.MEETING_BOTS) return result;
  const user = (await db
    .select({ displayName: users.displayName, notetakerName: users.notetakerName, captureDefault: users.meetingCaptureDefault, isAnonymous: users.isAnonymous })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0];
  if (!user || user.isAnonymous) return result;
  const accountDefault: CaptureDefault = user.captureDefault ?? 'mac';
  const botName = notetakerName(user.notetakerName, user.displayName);

  const events = await calendarRepo.eventsAround(db, userId, now, now + PLAN_AHEAD_MS);
  const wanted = new Map<string, { joinAt: number | null; url: string; platform: MeetingBot['platform']; title: string }>();
  for (const event of events) {
    if (!isMeetingLike(event) || event.endsAt <= now || event.recordedMeetingId) continue;
    const target = joinableMeeting(event.meetingUrl);
    if (!wantsNotetaker(effectiveMode(event.captureMode, accountDefault, target !== null))) {
      // A Zoom call (or no link) under a Notetaker plan falls to the Mac.
      if (!target && wantsNotetaker(effectiveMode(event.captureMode, accountDefault))) result.skipped.push(event.id);
      continue;
    }
    if (!target) continue;
    const joinAt = event.startsAt - JOIN_EARLY_MS;
    wanted.set(event.id, { joinAt: joinAt > now ? joinAt : null, url: target.url, platform: target.platform, title: event.title });
  }

  const planned = await db
    .select()
    .from(meetingBots)
    .where(and(eq(meetingBots.userId, userId), isNotNull(meetingBots.calendarEventId), inArray(meetingBots.status, ['scheduling', 'scheduled', 'joining', 'waiting_room', 'in_call', 'recording', 'call_ended', 'collecting'])));
  const covered = new Set<string>();
  // A meeting whose bot failed, finished or was cancelled by the person isn't
  // sent another: a withdrawn plan bot (`calendar_*`) is the only one replaced.
  if (wanted.size) {
    const ended = await db
      .select({ calendarEventId: meetingBots.calendarEventId, statusDetail: meetingBots.statusDetail })
      .from(meetingBots)
      .where(and(eq(meetingBots.userId, userId), inArray(meetingBots.calendarEventId, [...wanted.keys()]), inArray(meetingBots.status, ['done', 'failed', 'cancelled'])));
    for (const bot of ended) {
      if (!bot.statusDetail?.startsWith(WITHDRAWN_PREFIX)) covered.add(bot.calendarEventId!);
    }
  }
  for (const bot of planned) {
    const want = bot.calendarEventId ? wanted.get(bot.calendarEventId) : undefined;
    const target = want?.joinAt ?? now;
    const notStarted = bot.status === 'scheduled' && bot.statusDetail !== 'launching';
    const moved = want && bot.joinAt !== null && Math.abs(bot.joinAt - target) > MOVED_MS && notStarted;
    // A new name (or display name) reaches bots that haven't joined yet.
    const renamed = want && bot.botName !== botName && notStarted;
    if (want && !moved && !renamed && bot.meetingUrl === want.url) {
      covered.add(bot.calendarEventId!);
      continue;
    }
    const why = !want ? 'calendar_plan_changed' : renamed && !moved ? 'calendar_renamed' : 'calendar_moved';
    if (await withdrawBot(db, env, bot, why)) result.withdrawn++;
    else if (bot.calendarEventId) covered.add(bot.calendarEventId);
  }

  for (const [eventId, want] of wanted) {
    if (covered.has(eventId)) continue;
    const placed = await placeBot(db, env, userId, {
      url: want.url,
      platform: want.platform,
      title: want.title,
      folderId: null,
      joinAt: want.joinAt,
      calendarEventId: eventId,
      botName,
    }, now);
    if ('error' in placed) {
      console.error(JSON.stringify({ message: 'calendar notetaker not scheduled', userId, eventId, error: placed.error }));
      continue;
    }
    // A duplicate is a bot sent by hand to the same call: it covers the meeting and stays the person's own.
    if (!placed.duplicate) result.scheduled++;
  }
  return result;
}
