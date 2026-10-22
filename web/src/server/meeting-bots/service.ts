import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import * as schema from '@/db/schema';
import { meetingBots, meetingSegments, meetings, transcriptSegments, users } from '@/db/schema';
import { pid } from '@/db/ids';
import * as projectsRepo from '@/db/repo/projects';
import type { AppDb } from '@/db/client';
import { type ProcessingEnv, runBatched } from '@/server/processing/shared';
import { type MeetingBotsEnv, attributeSpeakers, parseSpeakerSpans } from './control';

/**
 * Notetaker bots: Eavesy's own bot (workers/meeting-bot) joins a Meet or
 * Teams call, and reports back through the meeting-bot Worker, which calls
 * `handleBotEvent` and `handleBotSegment` here. Segments go through the same
 * per-segment Whisper and rolling-notes pipeline as the Mac app's, so the
 * transcript is live during the call.
 */

export type BotEnv = ProcessingEnv & MeetingBotsEnv;
/** What the meeting-bot Worker needs to take a bot's reports. */
export type BotIngestEnv = Pick<ProcessingEnv, 'AUDIO_BUCKET' | 'PROCESSING_QUEUE'>;
export type MeetingBot = typeof meetingBots.$inferSelect;
export type BotStatus = MeetingBot['status'];
export type BotPlatform = MeetingBot['platform'];

/** How far each status is along a bot's life; a status never moves backwards. */
export const BOT_STATUS_ORDER: Record<BotStatus, number> = {
  scheduling: 0,
  scheduled: 1,
  joining: 2,
  waiting_room: 3,
  in_call: 4,
  recording: 5,
  call_ended: 6,
  collecting: 7,
  done: 8,
  failed: 8,
  cancelled: 8,
};
export const TERMINAL_BOT_STATUSES: BotStatus[] = ['done', 'failed', 'cancelled'];
const IN_CALL_STATUSES: BotStatus[] = ['joining', 'waiting_room', 'in_call', 'recording', 'call_ended'];
/** The bot only sends audio once it is in the call; `call_ended` covers its last segments. */
const SEGMENT_STATUSES: BotStatus[] = ['in_call', 'recording', 'call_ended'];

/** Bots one account may have scheduled or in calls at once. */
export const ACTIVE_BOT_LIMIT = 10;
/** Collection checks back this often while the last segments are transcribed, for up to an hour. */
export const COLLECT_RETRY_SECONDS = 60;
export const MAX_COLLECT_ATTEMPTS = 60;
/** The bot reports at least once a minute in a call; this long without a word, it is gone. */
export const BOT_SILENT_AFTER_MS = 10 * 60 * 1_000;
/** A container that hasn't reported this long after starting never got going. */
export const BOT_START_TIMEOUT_MS = 5 * 60 * 1_000;
export const BOT_NAME = 'Eavesy Notetaker';
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_BYTES = 512 * 1024;

const PLATFORM_LABEL: Record<BotPlatform, string> = { zoom: 'Zoom', meet: 'Google Meet', teams: 'Teams' };
/** Platforms the bot can join today. Zoom needs its Meeting SDK, which is next. */
export const JOINABLE_PLATFORMS: BotPlatform[] = ['meet', 'teams'];

/** Recognises meeting links over HTTPS, Zoom included so it can be turned away by name. */
export function parseMeetingUrl(value: string): { url: string; platform: BotPlatform } | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if ((host === 'zoom.us' || host.endsWith('.zoom.us') || host === 'zoom.com' || host.endsWith('.zoom.com')) && /^\/(j|my|w|wc\/join)\//.test(url.pathname)) {
    return { url: url.toString(), platform: 'zoom' };
  }
  if (host === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(url.pathname)) {
    return { url: url.toString(), platform: 'meet' };
  }
  if (host === 'teams.microsoft.com' || host === 'teams.live.com' || host === 'teams.cloud.microsoft') {
    return { url: url.toString(), platform: 'teams' };
  }
  return null;
}

const scheduleSchema = z.object({
  meetingUrl: z.string().trim().min(1).max(2_000),
  /** Epoch ms. Omitted means join now. */
  joinAt: z.number().int().optional().nullable(),
  title: z.string().trim().max(200).optional().nullable(),
  folderId: z.string().max(100).optional().nullable(),
});

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** The database as the meeting-bot Worker opens it. */
export function botDatabase(d1: D1Database): AppDb {
  return drizzle(d1, { schema });
}

export function botsAvailable(env: MeetingBotsEnv) {
  return Boolean(env.MEETING_BOTS);
}

export function publicBot(bot: MeetingBot) {
  return {
    id: bot.id,
    meetingId: bot.meetingId,
    meetingUrl: bot.meetingUrl,
    platform: bot.platform,
    title: bot.title,
    joinAt: bot.joinAt,
    status: bot.status,
    statusDetail: bot.statusDetail,
    createdAt: bot.createdAt,
  };
}

export async function listBots(db: AppDb, userId: string) {
  const rows = await db.select().from(meetingBots).where(eq(meetingBots.userId, userId)).orderBy(desc(meetingBots.createdAt)).limit(50);
  return rows.map(publicBot);
}

async function botById(db: AppDb, id: string) {
  return (await db.select().from(meetingBots).where(eq(meetingBots.id, id)).limit(1))[0] as MeetingBot | undefined;
}

export async function scheduleBot(db: AppDb, env: MeetingBotsEnv, userId: string, input: unknown, now = Date.now()): Promise<Response> {
  const control = env.MEETING_BOTS;
  if (!control) return json({ error: 'The notetaker is not available on this server.' }, 503);
  const parsed = scheduleSchema.safeParse(input);
  if (!parsed.success) return json({ error: 'Invalid notetaker request' }, 400);
  const target = parseMeetingUrl(parsed.data.meetingUrl);
  if (!target) return json({ error: 'Paste a Google Meet or Microsoft Teams meeting link.' }, 400);
  if (!JOINABLE_PLATFORMS.includes(target.platform)) {
    return json({ error: `The notetaker can't join ${PLATFORM_LABEL[target.platform]} calls yet. Google Meet and Teams work today.` }, 400);
  }
  const joinAt = parsed.data.joinAt ?? null;
  if (joinAt !== null && (joinAt < now - 5 * 60 * 1_000 || joinAt > now + 60 * 24 * 60 * 60 * 1_000)) {
    return json({ error: 'Choose a start time in the next 60 days.' }, 400);
  }
  const folderId = parsed.data.folderId || null;
  if (folderId && !(await projectsRepo.ownsProject(db, userId, folderId))) return json({ error: 'Project not found' }, 404);

  const active = await db.select().from(meetingBots)
    .where(and(eq(meetingBots.userId, userId), notInArray(meetingBots.status, TERMINAL_BOT_STATUSES)));
  // A second click, or the same invite pasted twice, gets the bot already on its way.
  const same = active.find((bot) => bot.meetingUrl === target.url && Math.abs((bot.joinAt ?? bot.createdAt) - (joinAt ?? now)) < 30 * 60 * 1_000);
  if (same) return json({ bot: publicBot(same), duplicate: true });
  if (active.length >= ACTIVE_BOT_LIMIT) {
    return json({ error: `You can have ${ACTIVE_BOT_LIMIT} notetakers scheduled at once. Cancel one to add another.` }, 429);
  }

  const id = pid('bot', now);
  await db.insert(meetingBots).values({
    id,
    userId,
    provider: 'eavesy',
    providerBotId: id,
    meetingUrl: target.url,
    platform: target.platform,
    title: parsed.data.title || null,
    folderId,
    joinAt,
    status: 'scheduling',
    createdAt: now,
    updatedAt: now,
  });
  try {
    await control.schedule(id, joinAt);
  } catch (error) {
    console.error(JSON.stringify({ message: 'notetaker schedule failed', botId: id, error: error instanceof Error ? error.message : String(error) }));
    await finishBot(db, id, 'failed', 'provider_unavailable');
    return json({ error: 'The notetaker service is unavailable. Please retry.' }, 503);
  }
  await db.update(meetingBots).set({ status: 'scheduled', updatedAt: Date.now() })
    .where(and(eq(meetingBots.id, id), eq(meetingBots.status, 'scheduling')));
  return json({ bot: publicBot((await botById(db, id))!) }, 201);
}

/** Cancels a bot that hasn't joined, or makes one in a call leave and keep what it recorded. */
export async function cancelBot(db: AppDb, env: MeetingBotsEnv, userId: string, botId: string): Promise<Response> {
  const bot = (await db.select().from(meetingBots).where(and(eq(meetingBots.id, botId), eq(meetingBots.userId, userId))).limit(1))[0];
  if (!bot) return json({ error: 'Notetaker not found' }, 404);
  if (TERMINAL_BOT_STATUSES.includes(bot.status) || bot.status === 'collecting') return json({ bot: publicBot(bot), duplicate: true });
  if (IN_CALL_STATUSES.includes(bot.status)) {
    try {
      await env.MEETING_BOTS?.leave(bot.id);
    } catch (error) {
      console.error(JSON.stringify({ message: 'notetaker leave failed', botId, error: error instanceof Error ? error.message : String(error) }));
      return json({ error: 'Could not reach the notetaker. Please retry.' }, 502);
    }
    // Leaving ends the call for the bot; it delivers what it recorded as usual.
    await db.update(meetingBots).set({ statusDetail: 'leave_requested', updatedAt: Date.now() }).where(eq(meetingBots.id, botId));
  } else {
    // The bot's scheduled start sees the cancellation and does nothing; a
    // container that had just started is stopped.
    await db.update(meetingBots)
      .set({ status: 'cancelled', statusDetail: 'cancelled_by_user', updatedAt: Date.now() })
      .where(and(eq(meetingBots.id, botId), eq(meetingBots.status, bot.status)));
    await env.MEETING_BOTS?.stop(bot.id).catch(() => undefined);
  }
  return json({ bot: publicBot((await botById(db, botId))!) });
}

/** Maps a status code the bot reports to ours; null for codes that don't move the bot along. */
export function statusForCode(code: string): BotStatus | null {
  switch (code) {
    case 'joining_call': return 'joining';
    case 'in_waiting_room': return 'waiting_room';
    case 'in_call_recording': return 'recording';
    // The bot's last segments are still on their way after these.
    case 'call_ended':
    case 'fatal': return 'call_ended';
    // Sent after the last segment landed: collection starts.
    case 'done': return 'collecting';
    default: return null;
  }
}

const FAILURE_TEXT: Record<string, string> = {
  bot_kicked_from_waiting_room: 'The notetaker was not admitted from the waiting room.',
  timeout_exceeded_waiting_room: 'Nobody admitted the notetaker from the waiting room.',
  timeout_exceeded_noone_joined: 'Nobody joined the meeting.',
  meeting_not_found: 'The meeting link did not lead to a meeting.',
  sign_in_required: 'The meeting only admits signed-in accounts, so the notetaker could not join as a guest.',
  join_failed: 'The notetaker could not find its way into the meeting.',
  bot_removed: 'The notetaker was removed from the meeting.',
  bot_error: 'The notetaker stopped with an error.',
  bot_never_reported: 'The notetaker did not start.',
  start_failed: 'The notetaker could not be started. Please try again.',
  lost_track: 'The notetaker stopped reporting before the meeting finished.',
};

export function failureText(detail: string | null) {
  return (detail && FAILURE_TEXT[detail]) || 'The notetaker did not record this meeting.';
}

async function ensureMeeting(db: AppDb, bot: MeetingBot, startedAt: number): Promise<string> {
  if (bot.meetingId) return bot.meetingId;
  const owner = (await db.select({ language: users.defaultLanguage }).from(users).where(eq(users.id, bot.userId)).limit(1))[0];
  const now = Date.now();
  const clientSessionId = `bot:${bot.id}`;
  await db.insert(meetings).values({
    id: pid('meet', now),
    userId: bot.userId,
    title: bot.title || `${PLATFORM_LABEL[bot.platform]} meeting`,
    source: 'bot',
    platform: bot.platform,
    language: owner?.language && owner.language !== 'auto' ? owner.language : 'en',
    folderId: bot.folderId,
    status: 'recording',
    startedAt,
    clientSessionId,
    transcriptKind: 'conversation',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({ target: meetings.clientSessionId });
  const meeting = (await db.select({ id: meetings.id }).from(meetings).where(eq(meetings.clientSessionId, clientSessionId)).limit(1))[0];
  await db.update(meetingBots).set({ meetingId: meeting.id }).where(and(eq(meetingBots.id, bot.id), isNull(meetingBots.meetingId)));
  return meeting.id;
}

/**
 * Moves a bot to the status it reports. Out-of-order and repeated reports
 * are ignored, so a retried delivery and the watchdog can both call it.
 */
export async function applyStatus(db: AppDb, env: Pick<BotIngestEnv, 'PROCESSING_QUEUE'>, bot: MeetingBot, code: string, subCode: string | null, at: number) {
  if (TERMINAL_BOT_STATUSES.includes(bot.status) || bot.status === 'collecting') return bot.status;
  const next = statusForCode(code);
  if (!next) return bot.status;
  if (BOT_STATUS_ORDER[next] < BOT_STATUS_ORDER[bot.status]) return bot.status;
  if (bot.statusAt !== null && at < bot.statusAt && next === bot.status) return bot.status;

  if (next === 'recording') await ensureMeeting(db, bot, at);
  const changed = await db.update(meetingBots)
    .set({
      status: next,
      // A leave the person asked for stays the reason, whatever the bot says;
      // a report without a reason keeps the last one (`done` after `call_ended`).
      statusDetail: bot.statusDetail === 'leave_requested' ? bot.statusDetail : subCode ?? (bot.statusDetail === 'launching' ? null : bot.statusDetail),
      statusAt: Math.max(at, bot.statusAt ?? 0),
      updatedAt: Date.now(),
    })
    .where(and(eq(meetingBots.id, bot.id), eq(meetingBots.status, bot.status)))
    .returning({ id: meetingBots.id });
  if (!changed.length) return bot.status; // another delivery moved it first

  if (next === 'collecting') await env.PROCESSING_QUEUE.send({ kind: 'collect-bot-recording', botId: bot.id });
  return next;
}

async function failMeeting(db: AppDb, meetingId: string, message: string) {
  await db.update(meetings)
    .set({ status: 'failed', statusError: message, updatedAt: Date.now() })
    .where(and(eq(meetings.id, meetingId), inArray(meetings.status, ['recording', 'queued', 'uploading', 'processing'])));
}

const speakersKey = (bot: MeetingBot, meetingId: string) => `users/${bot.userId}/meetings/${meetingId}/bot/speakers.json`;

/** A status report from the bot: `{ code, subCode, at, speakers?, participants? }`. */
export async function handleBotEvent(db: AppDb, env: BotIngestEnv, botId: string, request: Request): Promise<Response> {
  const bot = await botById(db, botId);
  if (!bot) return json({ error: 'not_found' }, 404);
  const text = await request.text();
  if (text.length > MAX_EVENT_BYTES) return json({ error: 'too_large' }, 413);
  let body: { code?: unknown; subCode?: unknown; at?: unknown; speakers?: unknown; participants?: unknown; lostSegments?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const code = typeof body.code === 'string' ? body.code : '';
  const subCode = typeof body.subCode === 'string' ? body.subCode.slice(0, 100) : null;
  const at = typeof body.at === 'number' && Number.isFinite(body.at) ? body.at : Date.now();

  if (Array.isArray(body.speakers) && bot.meetingId) {
    const participants = Array.isArray(body.participants) ? body.participants.filter((p): p is string => typeof p === 'string').slice(0, 500) : [];
    await env.AUDIO_BUCKET.put(speakersKey(bot, bot.meetingId), JSON.stringify({ speakers: parseSpeakerSpans(body.speakers), participants }), {
      httpMetadata: { contentType: 'application/json' },
    });
  }
  if (code === 'done' && Array.isArray(body.lostSegments) && body.lostSegments.length) {
    // Segments the bot gave up delivering; the meeting has a gap there.
    console.warn(JSON.stringify({ message: 'notetaker lost segments', botId, lostSegments: body.lostSegments.slice(0, 100) }));
  }
  if (code === 'heartbeat' || code === 'speakers') {
    // The watchdog reads this as the bot being alive.
    await db.update(meetingBots).set({ updatedAt: Date.now() }).where(eq(meetingBots.id, bot.id));
    return json({ ok: true });
  }
  return json({ ok: true, status: await applyStatus(db, env, bot, code, subCode, at) });
}

/** One segment of the call from the bot: 16 kHz mono WAV, about a minute. */
export async function handleBotSegment(db: AppDb, env: BotIngestEnv, botId: string, idxParam: string, request: Request): Promise<Response> {
  const bot = await botById(db, botId);
  if (!bot) return json({ error: 'not_found' }, 404);
  const int = (value: string | null, max: number) => {
    const n = Number(value);
    return value !== null && value !== '' && Number.isSafeInteger(n) && n >= 0 && n <= max ? n : null;
  };
  const idx = int(idxParam, 100_000);
  const startMs = int(request.headers.get('x-segment-start-ms'), 72 * 60 * 60 * 1_000);
  const durationMs = int(request.headers.get('x-segment-duration-ms'), 10 * 60 * 1_000);
  const activeMs = int(request.headers.get('x-segment-active-ms'), 10 * 60 * 1_000);
  if (idx === null || startMs === null || !durationMs) return json({ error: 'invalid_segment_metadata' }, 400);
  if (Number(request.headers.get('content-length') ?? '0') > MAX_SEGMENT_BYTES) return json({ error: 'segment_too_large' }, 413);
  if (!SEGMENT_STATUSES.includes(bot.status)) return json({ error: 'bot_not_recording' }, 409);

  const meetingId = await ensureMeeting(db, bot, bot.statusAt ?? Date.now());
  const existing = await db.select({ id: meetingSegments.id }).from(meetingSegments)
    .where(and(eq(meetingSegments.meetingId, meetingId), eq(meetingSegments.idx, idx), eq(meetingSegments.track, 'mixed'))).limit(1);
  if (existing.length) return json({ ok: true, idempotent: true });

  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.byteLength === 0) return json({ error: 'empty_segment' }, 400);
  if (audio.byteLength > MAX_SEGMENT_BYTES) return json({ error: 'segment_too_large' }, 413);
  const r2Key = `users/${bot.userId}/meetings/${meetingId}/segments/${String(idx).padStart(5, '0')}.wav`;
  await env.AUDIO_BUCKET.put(r2Key, audio, { httpMetadata: { contentType: 'audio/wav' } });
  // A retry racing this one is settled by the unique (meeting, idx, track) index.
  const inserted = await db.insert(meetingSegments).values({
    id: pid('mseg'),
    meetingId,
    idx,
    track: 'mixed',
    activeMs,
    r2Key,
    bytes: audio.byteLength,
    offsetMs: startMs,
    durationMs,
    transcribeStatus: 'pending',
    createdAt: Date.now(),
  }).onConflictDoNothing().returning({ id: meetingSegments.id });
  if (!inserted.length) return json({ ok: true, idempotent: true });
  await db.update(meetings).set({ status: 'uploading', updatedAt: Date.now() })
    .where(and(eq(meetings.id, meetingId), eq(meetings.status, 'recording')));
  await db.update(meetingBots).set({ updatedAt: Date.now() }).where(eq(meetingBots.id, bot.id));
  await env.PROCESSING_QUEUE.send({ kind: 'transcribe-segment', meetingId, idx, track: 'mixed' });
  return json({ ok: true }, 202);
}

export class BotMediaNotReady extends Error {}

/**
 * Queue job once the bot has delivered everything: waits for the last
 * segments' transcription, names the speakers from the timeline the bot read
 * off the meeting page, and hands the meeting to the summary.
 */
export async function collectBotRecording(db: AppDb, env: BotEnv, botId: string) {
  const bot = await botById(db, botId);
  if (!bot || bot.status !== 'collecting') return;
  if (bot.provider !== 'eavesy') {
    // A Recall.ai bot from before Eavesy ran its own; that service is gone.
    await finishBot(db, bot.id, 'failed', 'provider_retired');
    if (bot.meetingId) await failMeeting(db, bot.meetingId, failureText(null));
    return;
  }
  const meeting = bot.meetingId ? (await db.select().from(meetings).where(eq(meetings.id, bot.meetingId)).limit(1))[0] : null;
  if (!meeting) {
    await finishBot(db, bot.id, 'failed', bot.statusDetail ?? 'no_recording');
    return;
  }
  if (meeting.deletedAt) {
    await finishBot(db, bot.id, 'done', 'meeting_deleted');
    return;
  }
  const segments = await db.select({ status: meetingSegments.transcribeStatus, end: sql<number>`${meetingSegments.offsetMs} + ${meetingSegments.durationMs}` })
    .from(meetingSegments).where(eq(meetingSegments.meetingId, meeting.id));
  if (!segments.length) {
    await finishBot(db, bot.id, 'failed', bot.statusDetail ?? 'no_recording');
    await failMeeting(db, meeting.id, failureText(bot.statusDetail));
    return;
  }
  const waiting = segments.some((s) => s.status === 'pending' || s.status === 'processing');
  if (waiting && bot.collectAttempts + 1 < MAX_COLLECT_ATTEMPTS) {
    await db.update(meetingBots).set({ collectAttempts: bot.collectAttempts + 1, updatedAt: Date.now() }).where(eq(meetingBots.id, bot.id));
    await env.PROCESSING_QUEUE.send({ kind: 'collect-bot-recording', botId: bot.id }, { delaySeconds: COLLECT_RETRY_SECONDS });
    return;
  }

  const timeline = await env.AUDIO_BUCKET.get(speakersKey(bot, meeting.id));
  const spans = timeline ? parseSpeakerSpans((JSON.parse(new TextDecoder().decode(await timeline.arrayBuffer())) as { speakers?: unknown }).speakers) : [];
  const lines = await db.select({ id: transcriptSegments.id, startMs: transcriptSegments.startMs, endMs: transcriptSegments.endMs })
    .from(transcriptSegments)
    .where(and(eq(transcriptSegments.meetingId, meeting.id), eq(transcriptSegments.isEdited, false)));
  const { assignments, speakerNames } = attributeSpeakers(lines, spans);
  await runBatched(db, [...assignments].map(([id, speakerId]) =>
    db.update(transcriptSegments).set({ speakerId }).where(and(eq(transcriptSegments.id, id), eq(transcriptSegments.isEdited, false)))));

  const now = Date.now();
  await db.update(meetings).set({
    status: 'processing',
    statusError: null,
    endedAt: now,
    durationSec: Math.round(Math.max(...segments.map((s) => s.end)) / 1_000),
    // Names people already gave a speaker win over the meeting's display names.
    speakerNamesJson: JSON.stringify({ ...speakerNames, ...parseNames(meeting.speakerNamesJson) }),
    updatedAt: now,
  }).where(eq(meetings.id, meeting.id));
  await env.PROCESSING_QUEUE.send({ kind: 'summarize', meetingId: meeting.id });
  await finishBot(db, bot.id, 'done', bot.statusDetail);
}

function parseNames(value: string | null): Record<string, string> {
  try {
    const parsed: unknown = value ? JSON.parse(value) : {};
    return typeof parsed === 'object' && parsed && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function finishBot(db: AppDb, botId: string, status: 'done' | 'failed', detail: string | null) {
  await db.update(meetingBots).set({ status, statusDetail: detail, updatedAt: Date.now() }).where(eq(meetingBots.id, botId));
}

/** Called when the collect job runs out of queue retries. */
export async function failCollection(db: AppDb, botId: string, reason: string) {
  const bot = await botById(db, botId);
  if (!bot || TERMINAL_BOT_STATUSES.includes(bot.status)) return;
  await finishBot(db, bot.id, 'failed', 'collect_failed');
  if (bot.meetingId) await failMeeting(db, bot.meetingId, `The notetaker's recording could not be collected: ${reason.slice(0, 300)}`);
}

/**
 * The bot's container is about to start. Claims the start, so a repeated
 * alarm never runs a second container, and returns what the bot needs, or
 * null when it should not run (cancelled, already started, gone).
 */
export async function claimBotStart(db: AppDb, botId: string) {
  const claimed = await db.update(meetingBots)
    .set({ status: 'scheduled', statusDetail: 'launching', updatedAt: Date.now() })
    // A bot asked for "now" can start before scheduling has recorded `scheduled`.
    .where(and(eq(meetingBots.id, botId), inArray(meetingBots.status, ['scheduling', 'scheduled']), isNull(meetingBots.statusDetail)))
    .returning();
  const bot = claimed[0] as MeetingBot | undefined;
  return bot ? { meetingUrl: bot.meetingUrl, platform: bot.platform, botName: BOT_NAME } : null;
}

/** Container starts tried for one bot before it is failed, and the wait between them. */
export const START_ATTEMPTS = 4;
export const START_RETRY_MS = 40 * 1_000;
/** What one start attempt can take (the container library's own waits are ~30 s), kept free before the watchdog's deadline. */
const START_ATTEMPT_ALLOWANCE_MS = 60 * 1_000;

/**
 * When to try a failed container start again, or null to give up now: after
 * the last attempt, or when one more would run past the watchdog's start
 * timeout, counted from the claim.
 */
export function nextStartAttemptAt(attempt: number, claimedAt: number, now: number): number | null {
  if (attempt >= START_ATTEMPTS) return null;
  const at = now + START_RETRY_MS;
  return at + START_ATTEMPT_ALLOWANCE_MS <= claimedAt + BOT_START_TIMEOUT_MS ? at : null;
}

/** A claimed start still waiting for its container, for a retry; null once cancelled or given up. */
export async function launchingBot(db: AppDb, botId: string) {
  const bot = await botById(db, botId);
  return bot && bot.status === 'scheduled' && bot.statusDetail === 'launching'
    ? { meetingUrl: bot.meetingUrl, platform: bot.platform, botName: BOT_NAME }
    : null;
}

/** The container could not be started. */
export async function failBotStart(db: AppDb, botId: string) {
  await db.update(meetingBots)
    .set({ status: 'failed', statusDetail: 'start_failed', updatedAt: Date.now() })
    .where(and(eq(meetingBots.id, botId), eq(meetingBots.status, 'scheduled'), eq(meetingBots.statusDetail, 'launching')));
}

/** A bot gone quiet or whose container died: keep whatever audio arrived. */
async function loseBot(db: AppDb, env: BotIngestEnv, bot: MeetingBot, reason: string) {
  const hasAudio = bot.meetingId
    ? (await db.select({ id: meetingSegments.id }).from(meetingSegments).where(eq(meetingSegments.meetingId, bot.meetingId)).limit(1)).length > 0
    : false;
  if (hasAudio) {
    const moved = await db.update(meetingBots)
      .set({ status: 'collecting', statusDetail: reason, updatedAt: Date.now() })
      .where(and(eq(meetingBots.id, bot.id), eq(meetingBots.status, bot.status)))
      .returning({ id: meetingBots.id });
    if (moved.length) await env.PROCESSING_QUEUE.send({ kind: 'collect-bot-recording', botId: bot.id });
    return;
  }
  await finishBot(db, bot.id, 'failed', reason);
  if (bot.meetingId) await failMeeting(db, bot.meetingId, failureText(reason));
}

export type WatchVerdict = 'watch' | 'stop' | 'done';

/**
 * The bot's Durable Object asks this every few minutes while a bot is out,
 * and when its container stops. It replaces provider webhooks being lost:
 * the answer says whether to keep watching, stop the container, or let go.
 */
export async function watchBot(db: AppDb, env: BotIngestEnv, botId: string, running: boolean, now = Date.now()): Promise<WatchVerdict> {
  const bot = await botById(db, botId);
  if (!bot) return running ? 'stop' : 'done';
  if (TERMINAL_BOT_STATUSES.includes(bot.status) || bot.status === 'collecting') {
    // Everything is delivered; a container still up is only shutting down.
    return running && now - bot.updatedAt > 60_000 ? 'stop' : 'done';
  }
  if (bot.status === 'scheduled' || bot.status === 'scheduling') {
    if (bot.statusDetail !== 'launching') return 'done'; // not started yet: its alarm is still set
    if (now - bot.updatedAt < BOT_START_TIMEOUT_MS) return 'watch';
    await finishBot(db, bot.id, 'failed', 'bot_never_reported');
    return running ? 'stop' : 'done';
  }
  // In a call (or on the way in).
  if (!running) {
    await loseBot(db, env, bot, 'bot_error');
    return 'done';
  }
  if (now - bot.updatedAt > BOT_SILENT_AFTER_MS) {
    await loseBot(db, env, bot, 'lost_track');
    return 'stop';
  }
  return 'watch';
}

/** Account deletion: make every bot still out leave, then forget them all. */
export async function purgeAccountBots(db: AppDb, env: MeetingBotsEnv, userId: string) {
  const bots = await db.select().from(meetingBots).where(eq(meetingBots.userId, userId));
  for (const bot of bots) {
    if (TERMINAL_BOT_STATUSES.includes(bot.status) || bot.provider !== 'eavesy') continue;
    // Throws while the bot Worker is unreachable, so the purge job retries.
    await env.MEETING_BOTS?.stop(bot.id);
  }
  await db.delete(meetingBots).where(eq(meetingBots.userId, userId));
}
