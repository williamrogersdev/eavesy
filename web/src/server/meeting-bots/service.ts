import { and, desc, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { z } from 'zod';
import * as schema from '@/db/schema';
import { meetingBots, meetingSegments, meetings, transcriptSegments, users } from '@/db/schema';
import { pid } from '@/db/ids';
import * as projectsRepo from '@/db/repo/projects';
import type { AppDb } from '@/db/client';
import { type ProcessingEnv, runBatched } from '@/server/processing/shared';
import { AUTO_LANGUAGE } from '@/lib/transcription/language';
import { parseSpeakerNames } from '@/lib/transcription/two-track';
import { type MeetingBotsEnv, type SpeakerSpan, attributeSpeakers, parseSpeakerSpans } from './control';

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
/**
 * How long collection waits for transcription after the last segment came
 * in. Counted in time, not attempts: a second collect job for the bot (from
 * a repeated `done` or a re-send) must not cut the wait short.
 */
export const COLLECT_WAIT_MS = MAX_COLLECT_ATTEMPTS * COLLECT_RETRY_SECONDS * 1_000;
/** The bot reports at least once a minute once started; this long without a word, it is gone. */
export const BOT_SILENT_AFTER_MS = 10 * 60 * 1_000;
/**
 * In the lobby the bot waits up to 15 minutes to be admitted (`rules.rs`),
 * and images from before lobby heartbeats say nothing while it waits.
 */
export const BOT_LOBBY_SILENT_AFTER_MS = 20 * 60 * 1_000;
/** A container still up this long after its bot finished is stopped (SIGTERM). */
export const BOT_EXIT_GRACE_MS = 60 * 1_000;
/** A bot `collecting` untouched this long has lost its collect job (each attempt touches it every minute). */
export const COLLECT_STALE_MS = 5 * COLLECT_RETRY_SECONDS * 1_000;
/** The hourly sweep re-queues collections untouched this long. */
export const STALE_COLLECTION_MS = 10 * 60 * 1_000;
/** A container that hasn't reported this long after starting never got going. */
export const BOT_START_TIMEOUT_MS = 5 * 60 * 1_000;
/** A canary bot leaves once it has been in the call this long (checked on its next watch). */
export const CANARY_STAY_MS = 2 * 60 * 1_000;
export const BOT_NAME = 'Eavesy Notetaker';
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_BYTES = 512 * 1024;
/** Spans kept per meeting, as `parseSpeakerSpans` reads them. */
const MAX_SPANS = 50_000;
const MAX_PARTICIPANTS = 500;

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

const json = (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, { status, headers });
/** Two requests for one link this close together are the same bot. */
const DUPLICATE_WINDOW_MS = 30 * 60 * 1_000;

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

export async function botById(db: AppDb, id: string) {
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

  const id = pid('bot', now);
  const at = joinAt ?? now;
  // One statement, so two clicks at once can't both get past the checks: a
  // bot for the same link around the same time is the one already on its way,
  // and an account has at most ACTIVE_BOT_LIMIT out at once.
  const active = sql`${meetingBots.userId} = ${userId} AND ${meetingBots.status} NOT IN ('done', 'failed', 'cancelled')`;
  const inserted = await db.run(sql`
    INSERT INTO ${meetingBots} (id, user_id, provider, provider_bot_id, meeting_url, platform, title, folder_id, join_at, status, created_at, updated_at)
    SELECT ${id}, ${userId}, 'eavesy', ${id}, ${target.url}, ${target.platform}, ${parsed.data.title || null}, ${folderId}, ${joinAt}, 'scheduling', ${now}, ${now}
    WHERE NOT EXISTS (
      SELECT 1 FROM ${meetingBots} WHERE ${active} AND ${meetingBots.meetingUrl} = ${target.url}
        AND abs(coalesce(${meetingBots.joinAt}, ${meetingBots.createdAt}) - ${at}) < ${DUPLICATE_WINDOW_MS}
    )
    AND (SELECT count(*) FROM ${meetingBots} WHERE ${active}) < ${ACTIVE_BOT_LIMIT}`);
  if (!inserted.meta.changes) {
    const others = await db.select().from(meetingBots)
      .where(and(eq(meetingBots.userId, userId), notInArray(meetingBots.status, TERMINAL_BOT_STATUSES)));
    // A second click, or the same invite pasted twice, gets the bot already on its way.
    const same = others.find((bot) => bot.meetingUrl === target.url && Math.abs((bot.joinAt ?? bot.createdAt) - at) < DUPLICATE_WINDOW_MS);
    if (same) return json({ bot: publicBot(same), duplicate: true });
    if (others.length >= ACTIVE_BOT_LIMIT) {
      return json({ error: `You can have ${ACTIVE_BOT_LIMIT} notetakers scheduled at once. Cancel one to add another.` }, 429);
    }
    // The bot in the way finished between the insert and the look.
    return json({ error: 'The notetaker could not be scheduled. Please retry.' }, 503);
  }
  try {
    await control.schedule(id, joinAt);
  } catch (error) {
    console.error(JSON.stringify({ message: 'notetaker schedule failed', botId: id, error: error instanceof Error ? error.message : String(error) }));
    await finishBot(db, id, 'failed', 'provider_unavailable', 'scheduling');
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
  // The owner's language, `auto` included, as for the Mac's recordings
  // (`transcriptionPrefs`, not imported: it would pull secrets code into the bot Worker).
  const language = owner?.language || AUTO_LANGUAGE;
  const now = Date.now();
  const clientSessionId = `bot:${bot.id}`;
  await db.insert(meetings).values({
    id: pid('meet', now),
    userId: bot.userId,
    title: bot.title || `${PLATFORM_LABEL[bot.platform]} meeting`,
    source: 'bot',
    platform: bot.platform,
    language,
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
  if (bot.status === 'collecting' && code === 'done') {
    // The bot retries `done` when its first delivery failed, which may have
    // been the queue send after the move to `collecting`: send it again.
    // The collect job does nothing once the bot is past `collecting`.
    await env.PROCESSING_QUEUE.send({ kind: 'collect-bot-recording', botId: bot.id });
    return bot.status;
  }
  if (TERMINAL_BOT_STATUSES.includes(bot.status) || bot.status === 'collecting') return bot.status;
  const next = statusForCode(code);
  if (!next) return bot.status;
  if (BOT_STATUS_ORDER[next] < BOT_STATUS_ORDER[bot.status]) return bot.status;
  if (bot.statusAt !== null && at < bot.statusAt && next === bot.status) return bot.status;

  // A canary makes no meeting: getting in is marked on its row, and there is
  // nothing to collect once it is out.
  const status: BotStatus = bot.canary && next === 'collecting' ? 'done' : next;
  if (next === 'recording' && !bot.canary) await ensureMeeting(db, bot, at);
  const changed = await db.update(meetingBots)
    .set({
      status,
      ...(bot.canary && next === 'recording' ? { canaryNames: bot.canaryNames ?? 0 } : {}),
      // A leave the person asked for stays the reason, whatever the bot says;
      // a report without a reason keeps the last one (`done` after `call_ended`).
      statusDetail: bot.statusDetail === 'leave_requested' ? bot.statusDetail : subCode ?? (bot.statusDetail === 'launching' ? null : bot.statusDetail),
      statusAt: Math.max(at, bot.statusAt ?? 0),
      updatedAt: Date.now(),
    })
    .where(and(eq(meetingBots.id, bot.id), eq(meetingBots.status, bot.status)))
    .returning({ id: meetingBots.id });
  if (!changed.length) return bot.status; // another delivery moved it first

  if (status === 'collecting') await env.PROCESSING_QUEUE.send({ kind: 'collect-bot-recording', botId: bot.id });
  return status;
}

async function failMeeting(db: AppDb, meetingId: string, message: string) {
  await db.update(meetings)
    .set({ status: 'failed', statusError: message, updatedAt: Date.now() })
    .where(and(eq(meetings.id, meetingId), inArray(meetings.status, ['recording', 'queued', 'uploading', 'processing'])));
}

/** Keeps how many names a canary read, never the names: the test meeting's people aren't Eavesy's to store. */
async function noteCanaryNames(db: AppDb, bot: MeetingBot, speakers: unknown, participants: unknown) {
  const names = new Set(parseSpeakerSpans(speakers).map(([name]) => name));
  if (Array.isArray(participants)) {
    for (const p of participants.slice(0, 500)) if (typeof p === 'string' && p.trim()) names.add(p.trim());
  }
  // Only once it is in (`canary_names` set), and never fewer than already seen.
  await db.update(meetingBots)
    .set({ canaryNames: sql`max(${meetingBots.canaryNames}, ${names.size})` })
    .where(and(eq(meetingBots.id, bot.id), isNotNull(meetingBots.canaryNames)));
}

const speakersKey = (bot: MeetingBot, meetingId: string) => `users/${bot.userId}/meetings/${meetingId}/bot/speakers.json`;

interface Timeline { speakers: SpeakerSpan[]; participants: string[] }

const participantList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string').slice(0, MAX_PARTICIPANTS) : [];

/** The speaking timeline stored so far; one that can't be read counts as empty. */
async function readTimeline(bucket: Pick<R2Bucket, 'get'>, key: string): Promise<Timeline> {
  const object = await bucket.get(key);
  if (!object) return { speakers: [], participants: [] };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as { speakers?: unknown; participants?: unknown } | null;
    return { speakers: parseSpeakerSpans(parsed?.speakers), participants: participantList(parsed?.participants) };
  } catch {
    return { speakers: [], participants: [] };
  }
}

/**
 * Keeps the timeline a report carries. Bots send the spans from the first one
 * still open or not yet sent, with its start as `speakersFrom` (ms on the
 * recording's clock): the report replaces every stored span starting at or
 * after that time. A time rather than an index, so a report that never
 * arrived, or a span `parseSpeakerSpans` threw out, leaves a gap but never
 * shifts or doubles the spans after it. A report without `speakersFrom` is
 * the whole timeline, as images from before incremental reports send it.
 */
async function storeTimeline(env: Pick<BotIngestEnv, 'AUDIO_BUCKET'>, key: string, body: { speakers?: unknown; speakersFrom?: unknown; participants?: unknown }) {
  const spans = parseSpeakerSpans(body.speakers);
  const participants = participantList(body.participants);
  const from = body.speakersFrom;
  let timeline: Timeline = { speakers: spans, participants };
  if (typeof from === 'number' && Number.isFinite(from)) {
    const stored = await readTimeline(env.AUDIO_BUCKET, key);
    timeline = {
      speakers: [...stored.speakers.filter(([, start]) => start < from), ...spans].slice(0, MAX_SPANS),
      participants: [...new Set([...stored.participants, ...participants])].slice(0, MAX_PARTICIPANTS),
    };
  }
  await env.AUDIO_BUCKET.put(key, JSON.stringify(timeline), { httpMetadata: { contentType: 'application/json' } });
}

/** A status report from the bot: `{ code, subCode, at, speakers?, speakersFrom?, participants? }`; `speakersFrom` is a start time in ms. */
export async function handleBotEvent(db: AppDb, env: BotIngestEnv, botId: string, request: Request): Promise<Response> {
  const bot = await botById(db, botId);
  if (!bot) return json({ error: 'not_found' }, 404);
  // Any report, even one refused below, means the bot is alive. Only a bot
  // on its way into or in a call counts: a finished bot's lingering container
  // mustn't put off being stopped, or hide a stalled collection.
  if (IN_CALL_STATUSES.includes(bot.status)) {
    await db.update(meetingBots).set({ updatedAt: Date.now() })
      .where(and(eq(meetingBots.id, bot.id), inArray(meetingBots.status, IN_CALL_STATUSES)));
  }
  const text = await request.text();
  if (text.length > MAX_EVENT_BYTES) return json({ error: 'too_large' }, 413);
  let body: { code?: unknown; subCode?: unknown; at?: unknown; speakers?: unknown; speakersFrom?: unknown; participants?: unknown; lostSegments?: unknown } | null;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ error: 'invalid_json' }, 400);
  const code = typeof body.code === 'string' ? body.code : '';
  const subCode = typeof body.subCode === 'string' ? body.subCode.slice(0, 100) : null;
  const at = typeof body.at === 'number' && Number.isFinite(body.at) ? body.at : Date.now();

  if (bot.canary) {
    if (Array.isArray(body.speakers) || Array.isArray(body.participants)) await noteCanaryNames(db, bot, body.speakers, body.participants);
  } else if (Array.isArray(body.speakers)) {
    const meetingId = bot.meetingId ?? (SEGMENT_STATUSES.includes(bot.status) ? await ensureMeeting(db, bot, bot.statusAt ?? Date.now()) : null);
    if (meetingId) await storeTimeline(env, speakersKey(bot, meetingId), body);
  }
  if (code === 'done' && Array.isArray(body.lostSegments) && body.lostSegments.length) {
    // Segments the bot gave up delivering; the meeting has a gap there.
    console.warn(JSON.stringify({ message: 'notetaker lost segments', botId, lostSegments: body.lostSegments.slice(0, 100) }));
  }
  // The watchdog reads either as the bot being alive (noted above).
  if (code === 'heartbeat' || code === 'speakers') return json({ ok: true });
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
  if (BOT_STATUS_ORDER[bot.status] < BOT_STATUS_ORDER.in_call) {
    // The report saying it got in is still on its way (it travels on its own
    // queue). Every bot image retries a 5xx; a 4xx would drop the segment.
    return json({ error: 'bot_not_recording_yet' }, 503, { 'retry-after': '5' });
  }
  if (!SEGMENT_STATUSES.includes(bot.status)) return json({ error: 'bot_not_recording' }, 409);
  // A canary's audio is taken, so the bot carries on as usual, and dropped.
  if (bot.canary) return json({ ok: true, discarded: true }, 202);

  const meetingId = await ensureMeeting(db, bot, bot.statusAt ?? Date.now());
  const existing = (await db.select({ status: meetingSegments.transcribeStatus }).from(meetingSegments)
    .where(and(eq(meetingSegments.meetingId, meetingId), eq(meetingSegments.idx, idx), eq(meetingSegments.track, 'mixed'))).limit(1))[0];
  if (existing) {
    // A retry after the queue send failed: send it again, as the Mac's
    // segment route does. The segment's claim keeps a job already running
    // from being doubled.
    if (existing.status !== 'complete') await env.PROCESSING_QUEUE.send({ kind: 'transcribe-segment', meetingId, idx, track: 'mixed' });
    return json({ ok: true, idempotent: true });
  }

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
 * off the meeting page, and hands the meeting to the summary. More than one
 * can run for a bot (a repeated `done`, the watchdog, the hourly sweep);
 * only one waits on and only one hands the meeting on.
 */
export async function collectBotRecording(db: AppDb, env: BotEnv, botId: string, now = Date.now()) {
  const bot = await botById(db, botId);
  if (!bot || bot.status !== 'collecting') return;
  if (bot.provider !== 'eavesy') {
    // A Recall.ai bot from before Eavesy ran its own; that service is gone.
    if (await finishBot(db, bot.id, 'failed', 'provider_retired', 'collecting') && bot.meetingId) await failMeeting(db, bot.meetingId, failureText(null));
    return;
  }
  const meeting = bot.meetingId ? (await db.select().from(meetings).where(eq(meetings.id, bot.meetingId)).limit(1))[0] : null;
  if (!meeting) {
    await finishBot(db, bot.id, 'failed', bot.statusDetail ?? 'no_recording', 'collecting');
    return;
  }
  if (meeting.deletedAt) {
    await finishBot(db, bot.id, 'done', 'meeting_deleted', 'collecting');
    return;
  }
  const segments = await db.select({
    status: meetingSegments.transcribeStatus,
    end: sql<number>`${meetingSegments.offsetMs} + ${meetingSegments.durationMs}`,
    createdAt: meetingSegments.createdAt,
  }).from(meetingSegments).where(eq(meetingSegments.meetingId, meeting.id));
  if (!segments.length) {
    if (await finishBot(db, bot.id, 'failed', bot.statusDetail ?? 'no_recording', 'collecting')) await failMeeting(db, meeting.id, failureText(bot.statusDetail));
    return;
  }
  const waiting = segments.some((s) => s.status === 'pending' || s.status === 'processing');
  const lastArrived = Math.max(...segments.map((s) => s.createdAt));
  if (waiting && now - lastArrived < COLLECT_WAIT_MS) {
    // Of two jobs that read the same attempt, only one carries on waiting;
    // one that runs out of step costs only a job that finds nothing to do.
    const next = await db.update(meetingBots).set({ collectAttempts: bot.collectAttempts + 1, updatedAt: Date.now() })
      .where(and(eq(meetingBots.id, bot.id), eq(meetingBots.status, 'collecting'), eq(meetingBots.collectAttempts, bot.collectAttempts)))
      .returning({ id: meetingBots.id });
    if (next.length) await env.PROCESSING_QUEUE.send({ kind: 'collect-bot-recording', botId: bot.id }, { delaySeconds: COLLECT_RETRY_SECONDS });
    return;
  }

  const speakerNames = await nameSpeakers(db, env, bot, meeting.id);
  // `processing` too: a retry after the summary send failed carries on.
  const opened = await db.update(meetings).set({
    status: 'processing',
    statusError: null,
    endedAt: now,
    durationSec: Math.round(Math.max(...segments.map((s) => s.end)) / 1_000),
    // Names people already gave a speaker win over the meeting's display names.
    speakerNamesJson: JSON.stringify({ ...speakerNames, ...parseSpeakerNames(meeting.speakerNamesJson) }),
    updatedAt: now,
  }).where(and(eq(meetings.id, meeting.id), inArray(meetings.status, ['recording', 'queued', 'uploading', 'processing'])))
    .returning({ id: meetings.id });
  if (!opened.length) {
    // Already complete, or failed: nothing to hand on.
    await finishBot(db, bot.id, meeting.status === 'failed' ? 'failed' : 'done', bot.statusDetail, 'collecting');
    return;
  }
  // Of two jobs that got this far, the one that ends the bot sends the summary.
  if (!(await finishBot(db, bot.id, 'done', bot.statusDetail, 'collecting'))) return;
  try {
    await env.PROCESSING_QUEUE.send({ kind: 'summarize', meetingId: meeting.id });
  } catch (error) {
    // Back to `collecting`, so the queue's retry of this job sends it again.
    // Should this write fail too, the hourly sweep of meetings stuck in
    // `processing` queues the summary.
    await db.update(meetingBots).set({ status: 'collecting', updatedAt: Date.now() })
      .where(and(eq(meetingBots.id, bot.id), eq(meetingBots.status, 'done')));
    throw error;
  }
}

/**
 * Names each transcript line after who the meeting page showed speaking.
 * Best effort: a timeline that can't be read or matched leaves the lines
 * unnamed rather than failing a meeting whose transcript is fine.
 */
async function nameSpeakers(db: AppDb, env: Pick<BotEnv, 'AUDIO_BUCKET'>, bot: MeetingBot, meetingId: string): Promise<Record<string, string>> {
  try {
    const { speakers } = await readTimeline(env.AUDIO_BUCKET, speakersKey(bot, meetingId));
    if (!speakers.length) return {};
    const lines = await db.select({ id: transcriptSegments.id, startMs: transcriptSegments.startMs, endMs: transcriptSegments.endMs })
      .from(transcriptSegments)
      .where(and(eq(transcriptSegments.meetingId, meetingId), eq(transcriptSegments.isEdited, false)));
    const { assignments, speakerNames } = attributeSpeakers(lines, speakers);
    await runBatched(db, [...assignments].map(([id, speakerId]) =>
      db.update(transcriptSegments).set({ speakerId }).where(and(eq(transcriptSegments.id, id), eq(transcriptSegments.isEdited, false)))));
    return speakerNames;
  } catch (error) {
    console.error(JSON.stringify({ message: 'notetaker speaker names failed', botId: bot.id, error: error instanceof Error ? error.message : String(error) }));
    return {};
  }
}

/**
 * Ends a bot, but only from the status it was read in, so a move made
 * meanwhile (a cancel, another job) wins. True when this call ended it.
 */
export async function finishBot(db: AppDb, botId: string, status: 'done' | 'failed', detail: string | null, from: BotStatus | BotStatus[]) {
  const changed = await db.update(meetingBots).set({ status, statusDetail: detail, updatedAt: Date.now() })
    .where(and(eq(meetingBots.id, botId), inArray(meetingBots.status, Array.isArray(from) ? from : [from])))
    .returning({ id: meetingBots.id });
  return changed.length > 0;
}

/** Called when the collect job runs out of queue retries. */
export async function failCollection(db: AppDb, botId: string, reason: string) {
  const bot = await botById(db, botId);
  if (!bot || TERMINAL_BOT_STATUSES.includes(bot.status)) return;
  if (!(await finishBot(db, bot.id, 'failed', 'collect_failed', bot.status))) return;
  if (bot.meetingId) await failMeeting(db, bot.meetingId, `The notetaker's recording could not be collected: ${reason.slice(0, 300)}`);
}

/**
 * Queues collection again for a bot whose collect job was lost (its queue
 * send failed after the move to `collecting`): untouched since
 * `staleBefore`. Touching the row first keeps two callers from both sending.
 */
async function requeueCollection(db: AppDb, env: Pick<BotIngestEnv, 'PROCESSING_QUEUE'>, botId: string, staleBefore: number) {
  const claimed = await db.update(meetingBots).set({ updatedAt: Date.now() })
    .where(and(eq(meetingBots.id, botId), eq(meetingBots.status, 'collecting'), lt(meetingBots.updatedAt, staleBefore)))
    .returning({ id: meetingBots.id });
  if (!claimed.length) return false;
  await env.PROCESSING_QUEUE.send({ kind: 'collect-bot-recording', botId });
  return true;
}

/**
 * For the processing Worker's hourly cron: re-queues collection for bots
 * stuck in `collecting`, whose collect job was lost. Returns how many.
 */
export async function requeueStaleCollections(env: Pick<ProcessingEnv, 'DB' | 'PROCESSING_QUEUE'>, now = Date.now()) {
  const db = botDatabase(env.DB);
  const staleBefore = now - STALE_COLLECTION_MS;
  const stale = await db.select({ id: meetingBots.id }).from(meetingBots)
    .where(and(eq(meetingBots.status, 'collecting'), lt(meetingBots.updatedAt, staleBefore)))
    .limit(200);
  let requeued = 0;
  for (const bot of stale) if (await requeueCollection(db, env, bot.id, staleBefore)) requeued += 1;
  return requeued;
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
/** One start attempt's limits: to get a container instance, then for the bot to listen on its port. */
export const START_INSTANCE_TIMEOUT_MS = 8 * 1_000;
export const START_PORTS_TIMEOUT_MS = 20 * 1_000;
/** The longest one start attempt can take, with slack, kept free before the watchdog's deadline. */
const START_ATTEMPT_ALLOWANCE_MS = START_INSTANCE_TIMEOUT_MS + START_PORTS_TIMEOUT_MS + 30 * 1_000;

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

/**
 * Whether a container that just started should be stopped: its bot was
 * cancelled (or ended) while it started, when there was nothing to stop yet.
 * A bot that has already reported in (`joining`) is fine.
 */
export async function startWasCancelled(db: AppDb, botId: string) {
  const bot = await botById(db, botId);
  return !bot || TERMINAL_BOT_STATUSES.includes(bot.status);
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
    // Should this send fail, the watchdog sends it again once the bot has
    // sat in `collecting` untouched (`COLLECT_STALE_MS`).
    if (moved.length) await env.PROCESSING_QUEUE.send({ kind: 'collect-bot-recording', botId: bot.id });
    return;
  }
  if (await finishBot(db, bot.id, 'failed', reason, bot.status) && bot.meetingId) await failMeeting(db, bot.meetingId, failureText(reason));
}

export type WatchVerdict = 'watch' | 'stop' | 'done';

/**
 * The bot's Durable Object asks this every few minutes while a bot is out,
 * and when its container stops. It replaces provider webhooks being lost:
 * the answer says whether to keep watching, stop the container, or let go.
 * It only lets go once no container is running.
 */
export async function watchBot(db: AppDb, env: BotIngestEnv, botId: string, running: boolean, now = Date.now()): Promise<WatchVerdict> {
  const bot = await botById(db, botId);
  if (!bot) return running ? 'stop' : 'done';
  if (bot.status === 'collecting') {
    // Each collect attempt touches the row; untouched this long, its job was lost.
    if (now - bot.updatedAt > COLLECT_STALE_MS) await requeueCollection(db, env, bot.id, now - COLLECT_STALE_MS);
    // Keep watching until collection ends the bot, so a lost job is noticed.
    if (!running) return 'watch';
  }
  if (TERMINAL_BOT_STATUSES.includes(bot.status) || bot.status === 'collecting') {
    if (!running) return 'done';
    // A finished bot's container is only shutting down: give it a moment from
    // when it finished (not from `updatedAt`, which collection keeps moving).
    // A cancelled or failed bot's container has no business running at all.
    const finished = bot.status === 'done' || bot.status === 'collecting';
    return finished && now - (bot.statusAt ?? bot.updatedAt) <= BOT_EXIT_GRACE_MS ? 'watch' : 'stop';
  }
  if (bot.status === 'scheduled' || bot.status === 'scheduling') {
    if (bot.statusDetail !== 'launching') return running ? 'stop' : 'done'; // not started yet: its alarm is still set
    if (now - bot.updatedAt < BOT_START_TIMEOUT_MS) return 'watch';
    // The bot may have reported in meanwhile: then it is watched as usual.
    if (!(await finishBot(db, bot.id, 'failed', 'bot_never_reported', bot.status))) return 'watch';
    return running ? 'stop' : 'done';
  }
  // In a call (or on the way in).
  if (!running) {
    await loseBot(db, env, bot, 'bot_error');
    return 'done';
  }
  const silentAfter = bot.status === 'waiting_room' ? BOT_LOBBY_SILENT_AFTER_MS : BOT_SILENT_AFTER_MS;
  if (now - bot.updatedAt > silentAfter) {
    await loseBot(db, env, bot, 'lost_track');
    return 'stop';
  }
  // A canary has proved its point after a couple of minutes in: SIGTERM makes it leave.
  if (bot.canary && bot.status === 'recording' && bot.statusAt !== null && now - bot.statusAt >= CANARY_STAY_MS) return 'stop';
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
