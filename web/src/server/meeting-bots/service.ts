import { and, desc, eq, inArray, isNull, lt, notInArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { meetingBots, meetings, providerWebhookEvents, transcriptSegments, users } from '@/db/schema';
import { pid } from '@/db/ids';
import * as projectsRepo from '@/db/repo/projects';
import type { AppDb } from '@/db/client';
import { type ProcessingEnv, runBatched } from '@/server/processing/shared';
import {
  type RecallEnv,
  RecallError,
  createBot,
  deleteBotMedia,
  download,
  getBot,
  recallConfigured,
  removeBot,
  verifyWebhook,
} from './recall';
import { convertRecallTranscript } from './transcript';

export type BotEnv = ProcessingEnv & RecallEnv;
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

/** Bots one account may have scheduled or in calls at once. */
export const ACTIVE_BOT_LIMIT = 10;
/** Collection checks back this often while the provider finishes the transcript, for up to an hour. */
export const COLLECT_RETRY_SECONDS = 60;
export const MAX_COLLECT_ATTEMPTS = 60;
/** The whole-file Whisper fallback loads the audio into memory; past this it isn't attempted. */
const WHISPER_FALLBACK_MAX_BYTES = 20 * 1024 * 1024;
const BOT_NAME = 'Eavesy Notetaker';

const PLATFORM_LABEL: Record<BotPlatform, string> = { zoom: 'Zoom', meet: 'Google Meet', teams: 'Teams' };

/** Accepts only links to the meeting platforms the provider can join, over HTTPS. */
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

export async function scheduleBot(db: AppDb, env: RecallEnv, userId: string, input: unknown, now = Date.now()): Promise<Response> {
  if (!recallConfigured(env)) return json({ error: 'The notetaker is not available on this server.' }, 503);
  const parsed = scheduleSchema.safeParse(input);
  if (!parsed.success) return json({ error: 'Invalid notetaker request' }, 400);
  const target = parseMeetingUrl(parsed.data.meetingUrl);
  if (!target) return json({ error: 'Paste a Zoom, Google Meet or Microsoft Teams meeting link.' }, 400);
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
  // The row exists before the provider call, so a bot Recall creates is never untracked.
  await db.insert(meetingBots).values({
    id,
    userId,
    provider: 'recall',
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
    const created = await createBot(env, { meetingUrl: target.url, joinAt, botName: BOT_NAME, eavesyBotId: id, now });
    await db.update(meetingBots)
      .set({ providerBotId: created.id, status: 'scheduled', updatedAt: Date.now() })
      .where(and(eq(meetingBots.id, id), eq(meetingBots.status, 'scheduling')));
  } catch (error) {
    const uncertain = error instanceof RecallError && error.uncertain;
    console.error(JSON.stringify({ message: 'notetaker schedule failed', botId: id, uncertain, error: error instanceof Error ? error.message : String(error) }));
    if (uncertain) {
      // Recall may have the bot. Its webhooks carry our id, so they still find this row;
      // the reconcile sweep fails it if none ever arrive.
      await db.update(meetingBots).set({ statusDetail: 'provider_unconfirmed', updatedAt: Date.now() }).where(eq(meetingBots.id, id));
      const row = (await db.select().from(meetingBots).where(eq(meetingBots.id, id)).limit(1))[0];
      return json({ bot: publicBot(row), warning: 'The notetaker service did not confirm in time. It may still join; this page will update.' }, 202);
    }
    await db.update(meetingBots).set({ status: 'failed', statusDetail: 'provider_rejected', updatedAt: Date.now() }).where(eq(meetingBots.id, id));
    const status = error instanceof RecallError && error.status === 400 ? 400 : 502;
    return json({ error: status === 400 ? 'The notetaker could not use that meeting link.' : 'The notetaker service is unavailable. Please retry.' }, status);
  }
  const row = (await db.select().from(meetingBots).where(eq(meetingBots.id, id)).limit(1))[0];
  return json({ bot: publicBot(row) }, 201);
}

/** Cancels a bot that hasn't joined, or makes one in a call leave and keep what it recorded. */
export async function cancelBot(db: AppDb, env: RecallEnv, userId: string, botId: string): Promise<Response> {
  const bot = (await db.select().from(meetingBots).where(and(eq(meetingBots.id, botId), eq(meetingBots.userId, userId))).limit(1))[0];
  if (!bot) return json({ error: 'Notetaker not found' }, 404);
  if (TERMINAL_BOT_STATUSES.includes(bot.status) || bot.status === 'collecting') return json({ bot: publicBot(bot), duplicate: true });
  const inCall = IN_CALL_STATUSES.includes(bot.status);
  if (bot.providerBotId) {
    try {
      await removeBot(env, bot.providerBotId, inCall);
    } catch (error) {
      // 404: Recall no longer has it, so there is nothing left to stop.
      if (!(error instanceof RecallError && error.status === 404)) {
        console.error(JSON.stringify({ message: 'notetaker cancel failed', botId, error: error instanceof Error ? error.message : String(error) }));
        return json({ error: 'Could not reach the notetaker service. Please retry.' }, 502);
      }
    }
  }
  if (inCall) {
    // Leaving ends the call for the bot; its webhooks bring the recording in as usual.
    await db.update(meetingBots).set({ statusDetail: 'leave_requested', updatedAt: Date.now() }).where(eq(meetingBots.id, botId));
  } else {
    await db.update(meetingBots)
      .set({ status: 'cancelled', statusDetail: 'cancelled_by_user', updatedAt: Date.now() })
      .where(and(eq(meetingBots.id, botId), eq(meetingBots.status, bot.status)));
  }
  const row = (await db.select().from(meetingBots).where(eq(meetingBots.id, botId)).limit(1))[0];
  return json({ bot: publicBot(row) });
}

/** Maps a Recall status code to ours; null for codes that don't move the bot along. */
export function statusForCode(code: string): BotStatus | null {
  switch (code) {
    case 'joining_call': return 'joining';
    case 'in_waiting_room': return 'waiting_room';
    case 'in_call_not_recording':
    case 'recording_permission_allowed':
    case 'recording_permission_denied': return 'in_call';
    case 'in_call_recording': return 'recording';
    case 'call_ended': return 'call_ended';
    // Collection asks the provider whether anything was recorded, so a missed
    // recording webhook can't lose a meeting. A fatal error can still leave media.
    case 'done':
    case 'fatal': return 'collecting';
    default: return null;
  }
}

const FAILURE_TEXT: Record<string, string> = {
  recording_permission_denied: 'The host did not allow the notetaker to record.',
  bot_kicked_from_waiting_room: 'The notetaker was not admitted from the waiting room.',
  timeout_exceeded_waiting_room: 'Nobody admitted the notetaker from the waiting room.',
  timeout_exceeded_noone_joined: 'Nobody joined the meeting.',
  meeting_not_found: 'The meeting link did not lead to a meeting.',
  meeting_not_started: 'The meeting had not started.',
  meeting_password_incorrect: 'The meeting password in the link was not accepted.',
  meeting_link_expired: 'The meeting link has expired.',
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
 * Moves a bot to the status a provider event reports. Out-of-order and repeated
 * deliveries are ignored, so the webhook and the reconcile sweep can both call it.
 */
export async function applyStatus(db: AppDb, env: BotEnv, bot: MeetingBot, code: string, subCode: string | null, at: number) {
  if (TERMINAL_BOT_STATUSES.includes(bot.status) || bot.status === 'collecting') return bot.status;
  const next = statusForCode(code);
  if (!next) return bot.status;
  if (BOT_STATUS_ORDER[next] < BOT_STATUS_ORDER[bot.status]) return bot.status;
  if (bot.statusAt !== null && at < bot.statusAt && next === bot.status) return bot.status;

  if (next === 'recording') await ensureMeeting(db, bot, at);
  const changed = await db.update(meetingBots)
    .set({
      status: next,
      statusDetail: subCode ?? (code === 'recording_permission_denied' ? code : null),
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

interface RecallEvent {
  event: string;
  botId: string | null;
  eavesyBotId: string | null;
  code: string | null;
  subCode: string | null;
  at: number;
}

export function parseEvent(body: unknown): RecallEvent | null {
  const root = body as { event?: unknown; data?: { data?: Record<string, unknown>; bot?: { id?: unknown; metadata?: Record<string, unknown> } } } | null;
  if (!root || typeof root.event !== 'string') return null;
  const status = root.data?.data ?? {};
  const bot = root.data?.bot ?? {};
  const updated = typeof status.updated_at === 'string' ? Date.parse(status.updated_at) : NaN;
  return {
    event: root.event,
    botId: typeof bot.id === 'string' ? bot.id : null,
    eavesyBotId: typeof bot.metadata?.eavesy_bot_id === 'string' ? bot.metadata.eavesy_bot_id : null,
    code: typeof status.code === 'string' ? status.code : null,
    subCode: typeof status.sub_code === 'string' ? status.sub_code : null,
    at: Number.isFinite(updated) ? updated : Date.now(),
  };
}

async function findBot(db: AppDb, event: RecallEvent): Promise<MeetingBot | null> {
  if (event.botId) {
    const byProvider = (await db.select().from(meetingBots)
      .where(and(eq(meetingBots.provider, 'recall'), eq(meetingBots.providerBotId, event.botId))).limit(1))[0];
    if (byProvider) return byProvider;
  }
  if (!event.eavesyBotId) return null;
  const byOurs = (await db.select().from(meetingBots).where(eq(meetingBots.id, event.eavesyBotId)).limit(1))[0];
  if (!byOurs) return null;
  if (byOurs.providerBotId && event.botId && byOurs.providerBotId !== event.botId) return null;
  if (!byOurs.providerBotId && event.botId) {
    // The create call timed out but Recall made the bot: adopt it.
    await db.update(meetingBots)
      .set({ providerBotId: event.botId, status: byOurs.status === 'scheduling' ? 'scheduled' : byOurs.status, statusDetail: null })
      .where(eq(meetingBots.id, byOurs.id));
    return (await db.select().from(meetingBots).where(eq(meetingBots.id, byOurs.id)).limit(1))[0];
  }
  return byOurs;
}

/** POST /api/webhooks/recall. Unknown bots are acknowledged so Recall stops retrying. */
export async function handleWebhook(db: AppDb, env: BotEnv, request: Request, now = Date.now()): Promise<Response> {
  if (!recallConfigured(env)) return json({ error: 'not_configured' }, 404);
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > 256 * 1024) return json({ error: 'too_large' }, 413);
  const body = await request.text();
  if (body.length > 256 * 1024) return json({ error: 'too_large' }, 413);
  const deliveryId = await verifyWebhook(env.RECALL_WEBHOOK_SECRET, request.headers, body, now);
  if (!deliveryId) return json({ error: 'invalid_signature' }, 401);
  const eventKey = `recall:${deliveryId}`.slice(0, 200);
  const seen = await db.select({ id: providerWebhookEvents.id }).from(providerWebhookEvents).where(eq(providerWebhookEvents.id, eventKey)).limit(1);
  if (seen.length) return json({ ok: true, duplicate: true });

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const event = parseEvent(parsed);
  if (event?.event.startsWith('bot.') && event.code) {
    const bot = await findBot(db, event);
    if (bot) await applyStatus(db, env, bot, event.code, event.subCode, event.at);
  }
  // Recorded only after it was applied: a failure above makes Recall deliver it again.
  await db.insert(providerWebhookEvents).values({ id: eventKey, provider: 'recall', receivedAt: now }).onConflictDoNothing();
  return json({ ok: true });
}

export class BotMediaNotReady extends Error {}

/**
 * Queue job: copies the finished recording into Eavesy (transcript lines with
 * speaker names, and the mixed audio), then hands the meeting to the summary
 * pipeline. Safe to run again; each run rewrites the same rows.
 */
export async function collectBotRecording(db: AppDb, env: BotEnv, botId: string) {
  const bot = (await db.select().from(meetingBots).where(eq(meetingBots.id, botId)).limit(1))[0];
  if (!bot || bot.status !== 'collecting' || !bot.providerBotId) return;
  const remote = await getBot(env, bot.providerBotId);
  const recording = remote.recording;
  if (!recording) {
    const reason = remote.latest?.subCode ?? bot.statusDetail;
    await finishBot(db, bot, 'failed', reason ?? 'no_recording');
    if (bot.meetingId) await failMeeting(db, bot.meetingId, failureText(reason));
    return;
  }
  const pending = (s: string | null) => s === null || s === 'processing';
  if (pending(recording.transcript.status) || pending(recording.audio.status)) {
    // An unconfigured artifact stays null forever; give up waiting on it after the budget.
    if (bot.collectAttempts + 1 < MAX_COLLECT_ATTEMPTS) {
      await db.update(meetingBots).set({ collectAttempts: bot.collectAttempts + 1, updatedAt: Date.now() }).where(eq(meetingBots.id, bot.id));
      await env.PROCESSING_QUEUE.send({ kind: 'collect-bot-recording', botId }, { delaySeconds: COLLECT_RETRY_SECONDS });
      return;
    }
  }

  const meetingId = await ensureMeeting(db, bot, recording.startedAt ?? bot.statusAt ?? Date.now());
  const meeting = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  if (!meeting || meeting.deletedAt) {
    await finishBot(db, bot, 'done', 'meeting_deleted');
    await dropProviderMedia(env, bot);
    return;
  }

  let audio: { key: string; bytes: number } | null = null;
  if (recording.audio.status === 'done' && recording.audio.downloadUrl) {
    const key = `users/${bot.userId}/meetings/${meetingId}/bot/audio.mp3`;
    const response = await download(recording.audio.downloadUrl);
    const declared = Number(response.headers.get('content-length'));
    // R2 streams a body only when its length is known up front.
    const body = Number.isSafeInteger(declared) && declared > 0 && response.body && typeof FixedLengthStream !== 'undefined'
      ? response.body.pipeThrough(new FixedLengthStream(declared))
      : new Uint8Array(await response.arrayBuffer());
    const stored = await env.AUDIO_BUCKET.put(key, body as Parameters<BotEnv['AUDIO_BUCKET']['put']>[1], { httpMetadata: { contentType: 'audio/mpeg' } });
    audio = { key, bytes: stored?.size ?? declared };
  }

  let transcript = convertRecallTranscript([]);
  if (recording.transcript.status === 'done' && recording.transcript.downloadUrl) {
    transcript = convertRecallTranscript(await (await download(recording.transcript.downloadUrl)).json());
  }

  const now = Date.now();
  const durationMs = recording.startedAt && recording.completedAt
    ? recording.completedAt - recording.startedAt
    : transcript.lines.at(-1)?.endMs ?? 0;
  const useWhisper = transcript.lines.length === 0 && audio !== null && audio.bytes <= WHISPER_FALLBACK_MAX_BYTES;

  await db.delete(transcriptSegments).where(and(eq(transcriptSegments.meetingId, meetingId), eq(transcriptSegments.isEdited, false)));
  await runBatched(db, transcript.lines.map((line, index) => db.insert(transcriptSegments).values({
    id: `bot_${meetingId}_${index}`,
    meetingId,
    startMs: line.startMs,
    endMs: line.endMs,
    speakerId: line.speakerId,
    text: line.text,
    language: line.language,
    isEdited: false,
    isFinal: true,
  }).onConflictDoNothing()));

  await db.update(meetings).set({
    status: 'processing',
    statusError: null,
    endedAt: recording.completedAt ?? now,
    durationSec: Math.round(durationMs / 1_000),
    audioDurationSec: audio ? Math.round(durationMs / 1_000) : null,
    ...(audio ? { audioR2Key: audio.key, audioBytes: audio.bytes, audioFormat: 'mp3' as const } : {}),
    ...(transcript.language ? { language: transcript.language } : {}),
    // Names people already gave a speaker win over the meeting's display names.
    speakerNamesJson: JSON.stringify({ ...transcript.speakerNames, ...parseNames(meeting.speakerNamesJson) }),
    firstTranscriptAt: meeting.firstTranscriptAt ?? (transcript.lines.length ? now : null),
    updatedAt: now,
  }).where(eq(meetings.id, meetingId));

  if (useWhisper) {
    await env.PROCESSING_QUEUE.send({ kind: 'process-recording', meetingId });
  } else if (transcript.lines.length === 0 && recording.transcript.status !== 'done') {
    await failMeeting(db, meetingId, 'The meeting was recorded but could not be transcribed. The audio has been kept.');
  } else {
    await env.PROCESSING_QUEUE.send({ kind: 'summarize', meetingId });
  }
  await finishBot(db, bot, 'done', null);
  await dropProviderMedia(env, bot);
}

function parseNames(value: string | null): Record<string, string> {
  try {
    const parsed: unknown = value ? JSON.parse(value) : {};
    return typeof parsed === 'object' && parsed && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function finishBot(db: AppDb, bot: MeetingBot, status: 'done' | 'failed', detail: string | null) {
  await db.update(meetingBots).set({ status, statusDetail: detail, updatedAt: Date.now() }).where(eq(meetingBots.id, bot.id));
}

async function dropProviderMedia(env: RecallEnv, bot: MeetingBot) {
  if (!bot.providerBotId) return;
  try {
    await deleteBotMedia(env, bot.providerBotId);
  } catch (error) {
    // Recall's own retention still removes it; this only shortens how long it is kept.
    console.warn(JSON.stringify({ message: 'notetaker media delete failed', botId: bot.id, error: error instanceof Error ? error.message : String(error) }));
  }
}

/** Called when the collect job runs out of queue retries. */
export async function failCollection(db: AppDb, botId: string, reason: string) {
  const bot = (await db.select().from(meetingBots).where(eq(meetingBots.id, botId)).limit(1))[0];
  if (!bot || TERMINAL_BOT_STATUSES.includes(bot.status)) return;
  await finishBot(db, bot, 'failed', 'collect_failed');
  if (bot.meetingId) await failMeeting(db, bot.meetingId, `The notetaker's recording could not be collected: ${reason.slice(0, 300)}`);
}

/** Bots quiet this long are checked against the provider in case a webhook was lost. */
export const RECONCILE_AFTER_MS = 30 * 60 * 1_000;
/** A bot still unfinished this long after it was due is given up on. */
export const ABANDON_AFTER_MS = 24 * 60 * 60 * 1_000;

/** Hourly cron: catches up bots whose webhooks never arrived and expires the hopeless ones. */
export async function reconcileBots(db: AppDb, env: BotEnv, now = Date.now()) {
  if (!recallConfigured(env)) return;
  await db.delete(providerWebhookEvents).where(lt(providerWebhookEvents.receivedAt, now - 7 * 24 * 60 * 60 * 1_000));
  const quiet = await db.select().from(meetingBots)
    .where(and(
      notInArray(meetingBots.status, TERMINAL_BOT_STATUSES),
      lt(meetingBots.updatedAt, now - RECONCILE_AFTER_MS),
      or(isNull(meetingBots.joinAt), lt(meetingBots.joinAt, now)),
    ))
    .orderBy(meetingBots.updatedAt)
    .limit(50);
  for (const bot of quiet) {
    const due = bot.joinAt ?? bot.createdAt;
    try {
      if (bot.status === 'collecting') {
        // The collect job's message was lost; start it again.
        await db.update(meetingBots).set({ updatedAt: now }).where(eq(meetingBots.id, bot.id));
        await env.PROCESSING_QUEUE.send({ kind: 'collect-bot-recording', botId: bot.id });
        continue;
      }
      if (!bot.providerBotId) {
        if (now - due > 3 * 60 * 60 * 1_000) {
          await finishBot(db, bot, 'failed', 'provider_unconfirmed');
        }
        continue;
      }
      const remote = await getBot(env, bot.providerBotId);
      if (remote.latest) await applyStatus(db, env, bot, remote.latest.code, remote.latest.subCode, remote.latest.at);
      const after = (await db.select().from(meetingBots).where(eq(meetingBots.id, bot.id)).limit(1))[0];
      if (after && !TERMINAL_BOT_STATUSES.includes(after.status) && after.status !== 'collecting' && now - due > ABANDON_AFTER_MS) {
        await finishBot(db, after, 'failed', 'lost_track');
        if (after.meetingId) await failMeeting(db, after.meetingId, 'The notetaker stopped reporting before the meeting finished.');
      } else if (after && after.status === bot.status) {
        await db.update(meetingBots).set({ updatedAt: now }).where(eq(meetingBots.id, bot.id));
      }
    } catch (error) {
      console.error(JSON.stringify({ message: 'notetaker reconcile failed', botId: bot.id, error: error instanceof Error ? error.message : String(error) }));
      if (error instanceof RecallError && error.status === 404) await finishBot(db, bot, 'failed', 'provider_missing');
    }
  }
}

/** Account deletion: stop every bot still headed to or sitting in a call, then forget them. */
export async function purgeAccountBots(db: AppDb, env: RecallEnv, userId: string) {
  const bots = await db.select().from(meetingBots).where(eq(meetingBots.userId, userId));
  for (const bot of bots) {
    if (!bot.providerBotId || TERMINAL_BOT_STATUSES.includes(bot.status) || bot.status === 'collecting') continue;
    try {
      await removeBot(env, bot.providerBotId, IN_CALL_STATUSES.includes(bot.status));
    } catch (error) {
      // Retry the purge while Recall is unreachable; a refusal (already gone, already left) is final.
      const transient = error instanceof RecallError && (error.status === null || error.status >= 500);
      if (transient && recallConfigured(env)) throw error;
    }
  }
  await db.delete(meetingBots).where(eq(meetingBots.userId, userId));
}
