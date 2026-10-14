import { and, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { drizzle } from 'drizzle-orm/d1';
import type {
  D1Database,
  MessageBatch,
  Queue,
  R2Bucket,
  VectorizeIndex,
} from '@cloudflare/workers-types';
import * as schema from '@/db/schema';
import {
  activityLog,
  captures,
  dictations,
  embeddings,
  meetings,
  meetingSegments,
  meetingUploads,
  summaries,
  transcriptSegments,
  users,
} from '@/db/schema';
import { encode } from '@/db/codec';
import { ulid } from '@/db/ids';
import { clock, MIN_CHAPTER_MEETING_MS, validateChapters } from '@/lib/ai/chapters';
import { anthropicForUser } from '@/lib/ai/client';
import { embedTexts, type WorkersAiRunner } from '@/lib/ai/embed';
import { MODELS } from '@/lib/ai/client';
import { MEETING_SUMMARY_MODEL, requestMeetingSummary } from '@/lib/ai/meeting-summary';
import { summarizeMeeting } from '@/lib/ai/summarize';
import { resolveModelPlan } from '@/lib/providers/router';
import { transcribeAudioFile } from '@/lib/transcription/transcribe-file';
import { WorkersAiSegmentTranscriber } from '@/lib/transcription/provider/workers-ai';
import {
  ECHO_WINDOW_MS,
  findEchoLines,
  hasBothSides,
  isHallucination,
  isSilentTrack,
  parseSpeakerNames,
  speakerForTrack,
  speakerName,
} from '@/lib/transcription/two-track';
import { reportError } from '@/server/observability';
import { isSealed, openUserKeys, sealSecret } from '@/server/secret-box';
import { recordFirstTranscript } from '@/server/transcript-latency';
import type { QueueMessage } from '@/server/queue';

export interface ProcessingEnv {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  VECTORIZE: VectorizeIndex;
  PROCESSING_QUEUE: Queue<QueueMessage>;
  AI: WorkersAiRunner;
  ANTHROPIC_API_KEY: string;
}

export type ProcessingMessage = QueueMessage;
type Db = ReturnType<typeof drizzle<typeof schema>>;
export const MAX_ATTEMPTS = 5;
export const SUMMARY_WAIT_LIMIT_MS = 6 * 60 * 60 * 1_000;
export const DEAD_LETTER_QUEUE = 'eavesy-processing-dlq';
// A queue consumer can run for at most 15 minutes, so a claim older than that
// belongs to a worker that died without releasing it.
export const SEGMENT_CLAIM_TTL_MS = 15 * 60 * 1_000;
const SEGMENT_BUSY_RETRY_SECONDS = 300;

class SegmentBusyError extends Error {
  constructor() {
    super('segment is being transcribed by another job');
  }
}

export interface TerminalProcessingFailure {
  kind: ProcessingMessage['kind'];
  outcome: 'recorded' | 'recording-failed';
}

type TerminalFailureReporter = (failure: TerminalProcessingFailure) => void;

export async function queue(batch: MessageBatch<ProcessingMessage>, env: ProcessingEnv) {
  if (batch.queue === DEAD_LETTER_QUEUE) {
    await deadLetterQueue(batch, env);
    return;
  }
  for (const message of batch.messages) {
    try {
      await handle(message.body, env);
      message.ack();
    } catch (error) {
      if (error instanceof SegmentBusyError) {
        // Another job holds the claim. Check back after it should have finished;
        // by then the segment is complete or the claim is stale and reclaimable.
        if (message.attempts < MAX_ATTEMPTS) {
          message.retry({ delaySeconds: SEGMENT_BUSY_RETRY_SECONDS });
          continue;
        }
        // Out of retries, but the claim may belong to a worker that died and
        // won't go stale for a few more minutes. Start a fresh message rather
        // than drop the segment; the cron sweep is the backstop if this fails.
        try {
          await env.PROCESSING_QUEUE.send(message.body, { delaySeconds: SEGMENT_BUSY_RETRY_SECONDS });
          console.warn(
            JSON.stringify({ message: 'segment busy past retry budget; requeued', job: message.body }),
          );
          message.ack();
        } catch (sendError) {
          reportError('could not requeue busy segment', sendError, { job: message.body });
          message.retry({ delaySeconds: SEGMENT_BUSY_RETRY_SECONDS });
        }
        continue;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const terminal = message.attempts >= MAX_ATTEMPTS;
      if (terminal) {
        reportError('processing queue job failed permanently', error, {
          job: message.body,
          attempts: message.attempts,
        });
      } else {
        console.error(
          JSON.stringify({
            message: 'processing queue job failed',
            job: message.body,
            attempts: message.attempts,
            error: reason,
          }),
        );
      }
      if (!terminal) {
        message.retry({ delaySeconds: Math.min(300, 30 * message.attempts) });
        continue;
      }
      try {
        await handleTerminalFailure(message.body, env, reason);
        message.ack();
      } catch (recordError) {
        reportError('could not record terminal failure', recordError, { job: message.body });
        message.retry({ delaySeconds: 300 });
      }
    }
  }
}

async function handleTerminalFailure(message: ProcessingMessage, env: ProcessingEnv, reason: string) {
  const db = drizzle(env.DB, { schema });
  switch (message.kind) {
    case 'transcribe-segment':
      await db
        .update(meetingSegments)
        .set({ transcribeStatus: 'failed' })
        .where(
          and(
            eq(meetingSegments.meetingId, message.meetingId),
            eq(meetingSegments.idx, message.idx),
            eq(meetingSegments.track, message.track ?? 'mixed'),
          ),
        );
      return;
    case 'process-recording':
      await recordTerminalFailure(message, env);
      return;
    case 'summarize':
      await db
        .update(meetings)
        .set({ status: 'failed', statusError: `Summary failed: ${reason.slice(0, 500)}`, updatedAt: Date.now() })
        .where(eq(meetings.id, message.meetingId));
      return;
    case 'rolling-summarize':
    case 'embed':
    case 'embed-dictation':
    case 'cleanup-anonymous':
    case 'purge-meeting':
    case 'purge-account':
      return;
    default: {
      const unhandled: never = message;
      throw new Error(`unhandled queue message kind: ${(unhandled as { kind: string }).kind}`);
    }
  }
}

export async function deadLetterQueue(
  batch: MessageBatch<ProcessingMessage>,
  env: ProcessingEnv,
  report: TerminalFailureReporter = () => undefined,
) {
  for (const message of batch.messages) {
    try {
      const failure = await recordTerminalFailure(message.body, env);
      console.error(
        JSON.stringify({
          message: 'processing job exhausted retries',
          jobKind: failure.kind,
          outcome: failure.outcome,
          queueMessageId: message.id,
        }),
      );
      report(failure);
      message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'could not persist terminal processing failure',
          jobKind: message.body.kind,
          queueMessageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      message.retry({ delaySeconds: 60 });
    }
  }
}

async function recordTerminalFailure(
  message: ProcessingMessage,
  env: ProcessingEnv,
): Promise<TerminalProcessingFailure> {
  const terminalMeetingKinds = new Set<ProcessingMessage['kind']>([
    'process-recording',
    'transcribe-segment',
    'rolling-summarize',
    'summarize',
  ]);

  if ('meetingId' in message && terminalMeetingKinds.has(message.kind)) {
    const update = await env.DB.prepare(
      `UPDATE meetings
          SET status = 'failed',
              status_error = ?,
              updated_at = ?
        WHERE id = ?
          AND status IN ('recording', 'queued', 'uploading', 'processing')`,
    )
      .bind(
        `Automatic ${message.kind} processing failed after retries. The uploaded recording has been preserved.`,
        Date.now(),
        message.meetingId,
      )
      .run();
    if ((update.meta.changes ?? 0) === 0) {
      return { kind: message.kind, outcome: 'recorded' };
    }
    await env.DB.prepare(
      `INSERT OR IGNORE INTO activity_log
        (id, user_id, event_type, meeting_id, metadata_json, created_at)
       SELECT ?, user_id, 'meeting.fail', id, ?, ?
         FROM meetings
        WHERE id = ?`,
    )
      .bind(
        `act_dlq_${message.kind}_${message.meetingId}`,
        encode({ reason: 'automatic_retries_exhausted', jobKind: message.kind }),
        Date.now(),
        message.meetingId,
      )
      .run();
    return { kind: message.kind, outcome: 'recording-failed' };
  }

  return { kind: message.kind, outcome: 'recorded' };
}

async function handle(message: ProcessingMessage, env: ProcessingEnv) {
  const db = drizzle(env.DB, { schema });
  switch (message.kind) {
    case 'process-recording':
      await handleProcessRecording(message.meetingId, db, env);
      return;
    case 'transcribe-segment':
      await handleTranscribeSegment(message.meetingId, message.idx, message.track ?? 'mixed', db, env);
      return;
    case 'rolling-summarize':
      await handleSummarize(message.meetingId, db, env, { final: false, throughIdx: message.throughIdx });
      return;
    case 'summarize':
      await handleSummarize(message.meetingId, db, env, {
        final: true,
        waitingSince: message.waitingSince ?? Date.now(),
      });
      return;
    case 'embed':
      await handleEmbedMeeting(message.meetingId, db, env);
      return;
    case 'embed-dictation':
      await handleEmbedDictation(message.dictationId, db, env);
      return;
    case 'cleanup-anonymous':
    case 'purge-meeting':
      await handleCleanup(message.meetingId, db, env);
      return;
    case 'purge-account':
      await handlePurgeAccount(message.userId, db, env);
      return;
    default: {
      const unhandled: never = message;
      throw new Error(
        `unhandled queue message kind: ${(unhandled as { kind: string }).kind}`,
      );
    }
  }
}

async function handleProcessRecording(meetingId: string, db: Db, env: ProcessingEnv) {
  const meeting = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  if (!meeting) return;
  const userRow = (await db.select().from(users).where(eq(users.id, meeting.userId)).limit(1))[0];
  const user = userRow ? await openUserKeys(userRow) : undefined;
  if (meeting.status === 'complete') {
    if (!user?.isAnonymous) await env.PROCESSING_QUEUE.send({ kind: 'embed', meetingId });
    return;
  }
  if (!meeting.audioR2Key) throw new Error('recording has no audio object');

  const object = await env.AUDIO_BUCKET.get(meeting.audioR2Key);
  if (!object) throw new Error('recording audio object is missing');
  const transcription = await transcribeAudioFile({
    audio: new Uint8Array(await object.arrayBuffer()),
    language: meeting.language,
    ai: env.AI,
  });

  await runBatched(db, transcription.segments.map((segment, index) => {
    const id = `web_${meetingId}_${index}_${segment.startMs}`;
    return db
      .insert(transcriptSegments)
      .values({
        id,
        meetingId,
        startMs: segment.startMs,
        endMs: segment.endMs,
        speakerId: segment.speakerId,
        text: segment.text,
        confidence: segment.confidence,
        isEdited: false,
        isFinal: true,
      })
      .onConflictDoUpdate({
        target: transcriptSegments.id,
        set: {
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          confidence: segment.confidence,
          isFinal: true,
        },
      });
  }));

  if (transcription.segments.length > 0) await recordFirstTranscript(db, meeting);

  const fullText = transcription.segments
    .map((segment) => `${segment.speakerId ? `${segment.speakerId}: ` : ''}${segment.text}`)
    .join('\n');
  const now = Date.now();
  if (fullText.trim()) {
    const plan = resolveModelPlan(user);
    const summary = await summarizeMeeting({
      transcript: fullText,
      contextBlurb: meeting.contextBlurb ?? undefined,
      openRouter: plan.openRouter,
      byoApiKey: plan.summary.apiKey ?? env.ANTHROPIC_API_KEY,
    });
    const generatedByModel = plan.openRouter
      ? 'openrouter:anthropic/claude-sonnet-4.6'
      : plan.summary.apiKey
        ? `byo-anthropic:${MODELS.summary}`
        : MODELS.summary;
    const values = {
      tldr: summary.tldr,
      decisionsJson: encode(summary.decisions),
      actionItemsJson: encode(summary.actionItems),
      followUpsJson: encode(summary.followUps),
      openQuestionsJson: encode(summary.openQuestions),
      topicsJson: encode(summary.topics),
      mentionsJson: encode(summary.mentions),
      generatedByModel,
      generatedAt: now,
    };
    await db
      .insert(summaries)
      .values({ id: `summary_${meetingId}`, meetingId, ...values })
      .onConflictDoUpdate({ target: summaries.meetingId, set: values });
    await db
      .update(meetings)
      .set({
        title: summary.title,
        description: summary.description,
        status: 'complete',
        statusError: null,
        audioDurationSec: transcription.durationSec,
        updatedAt: now,
      })
      .where(eq(meetings.id, meetingId));
  } else {
    await db
      .update(meetings)
      .set({
        title: 'Empty recording',
        status: 'complete',
        statusError: null,
        audioDurationSec: transcription.durationSec,
        updatedAt: now,
      })
      .where(eq(meetings.id, meetingId));
  }

  await logMeetingComplete(db, meeting.userId, meetingId, now);

  if (!user?.isAnonymous) {
    await env.PROCESSING_QUEUE.send({ kind: 'embed', meetingId });
  }
}

async function handleTranscribeSegment(
  meetingId: string,
  idx: number,
  track: 'mixed' | 'mic' | 'system',
  db: Db,
  env: ProcessingEnv,
) {
  const segment = (
    await db
      .select()
      .from(meetingSegments)
      .where(
        and(
          eq(meetingSegments.meetingId, meetingId),
          eq(meetingSegments.idx, idx),
          eq(meetingSegments.track, track),
        ),
      )
      .limit(1)
  )[0];
  if (!segment || segment.transcribeStatus === 'complete') return;
  const meeting = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  if (!meeting) return;

  // Queue delivery is at-least-once and segment retries re-enqueue, so two jobs
  // can arrive together. Only the one whose conditional update lands transcribes.
  const claimedAt = Date.now();
  const claimed = await db
    .update(meetingSegments)
    .set({ transcribeStatus: 'processing', transcribeClaimedAt: claimedAt })
    .where(
      and(
        eq(meetingSegments.id, segment.id),
        or(
          inArray(meetingSegments.transcribeStatus, ['pending', 'failed']),
          and(
            eq(meetingSegments.transcribeStatus, 'processing'),
            or(
              isNull(meetingSegments.transcribeClaimedAt),
              lt(meetingSegments.transcribeClaimedAt, claimedAt - SEGMENT_CLAIM_TTL_MS),
            ),
          ),
        ),
      ),
    )
    .returning({ id: meetingSegments.id });
  if (claimed.length === 0) {
    const current = (
      await db
        .select({ status: meetingSegments.transcribeStatus })
        .from(meetingSegments)
        .where(eq(meetingSegments.id, segment.id))
        .limit(1)
    )[0];
    if (!current || current.status === 'complete') return;
    throw new SegmentBusyError();
  }
  const ownClaim = and(
    eq(meetingSegments.id, segment.id),
    eq(meetingSegments.transcribeClaimedAt, claimedAt),
  );
  try {
    if (!isSilentTrack(track, segment.activeMs)) {
      const object = await env.AUDIO_BUCKET.get(segment.r2Key);
      if (!object) throw new Error(`segment object missing: ${segment.r2Key}`);
      const audio = new Uint8Array(await object.arrayBuffer());
      const transcription = await new WorkersAiSegmentTranscriber(env.AI).transcribe({
        audio,
        language: meeting.language,
        contextBlurb: meeting.contextBlurb,
      });
      const speakerId = speakerForTrack(track);
      const lines = transcription.segments.filter((relative) => !isHallucination(relative));

      await runBatched(db, lines.map((relative) => {
        const relativeStart = Math.max(0, relative.startMs);
        const absoluteStart = segment.offsetMs + relativeStart;
        const absoluteEnd = Math.max(
          absoluteStart,
          segment.offsetMs + (relative.endMs || segment.durationMs),
        );
        const id =
          track === 'mixed'
            ? `seg_${meetingId}_${idx}_${relativeStart}`
            : `seg_${meetingId}_${idx}_${track}_${relativeStart}`;
        return db
          .insert(transcriptSegments)
          .values({
            id,
            meetingId,
            startMs: absoluteStart,
            endMs: absoluteEnd,
            speakerId,
            text: relative.text,
            confidence: relative.confidence,
            isFinal: true,
            isEdited: false,
          })
          .onConflictDoUpdate({
            target: transcriptSegments.id,
            set: {
              startMs: absoluteStart,
              endMs: absoluteEnd,
              speakerId,
              text: relative.text,
              confidence: relative.confidence,
              isFinal: true,
            },
          });
      }));
      if (lines.length > 0) await recordFirstTranscript(db, meeting, segment);
    }

    await db
      .update(meetingSegments)
      .set({ transcribeStatus: 'complete' })
      .where(ownClaim);

    if (track !== 'mixed') {
      await removeEcho(db, meetingId, {
        fromMs: segment.offsetMs - ECHO_WINDOW_MS,
        toMs: segment.offsetMs + segment.durationMs + ECHO_WINDOW_MS,
      });
    }

    const siblingsPending = await db
      .select({ id: meetingSegments.id })
      .from(meetingSegments)
      .where(
        and(
          eq(meetingSegments.meetingId, meetingId),
          eq(meetingSegments.idx, idx),
          ne(meetingSegments.transcribeStatus, 'complete'),
        ),
      )
      .limit(1);
    if (siblingsPending.length === 0 && (idx + 1) % 3 === 0) {
      await env.PROCESSING_QUEUE.send({ kind: 'rolling-summarize', meetingId, throughIdx: idx });
    }
  } catch (error) {
    await db
      .update(meetingSegments)
      .set({ transcribeStatus: 'pending', transcribeClaimedAt: null })
      .where(ownClaim);
    throw error;
  }
}

async function removeEcho(db: Db, meetingId: string, range?: { fromMs: number; toMs: number }) {
  const lines = await db
    .select({
      id: transcriptSegments.id,
      speakerId: transcriptSegments.speakerId,
      startMs: transcriptSegments.startMs,
      endMs: transcriptSegments.endMs,
      text: transcriptSegments.text,
      isEdited: transcriptSegments.isEdited,
    })
    .from(transcriptSegments)
    .where(
      range
        ? and(
            eq(transcriptSegments.meetingId, meetingId),
            gte(transcriptSegments.endMs, range.fromMs),
            lte(transcriptSegments.startMs, range.toMs),
          )
        : eq(transcriptSegments.meetingId, meetingId),
    );
  const echoes = new Set(findEchoLines(lines));
  const doomed = lines.filter((line) => echoes.has(line.id) && !line.isEdited).map((line) => line.id);
  for (let i = 0; i < doomed.length; i += 50) {
    await db.delete(transcriptSegments).where(inArray(transcriptSegments.id, doomed.slice(i, i + 50)));
  }
}

function transcriptText(
  lines: { speakerId: string | null; startMs: number; text: string }[],
  speakerNamesJson: string | null,
  opts: { timestamps?: boolean } = {},
) {
  const labelled = hasBothSides(lines);
  const names = parseSpeakerNames(speakerNamesJson);
  const text = lines
    .map((line) => {
      const time = opts.timestamps ? `[${clock(line.startMs)}] ` : '';
      const who = labelled && line.speakerId ? `${speakerName(line.speakerId, names)}: ` : '';
      return `${time}${who}${line.text}`;
    })
    .join('\n');
  return { text, recorderName: labelled ? speakerName('you', names) : undefined };
}

async function handleSummarize(
  meetingId: string,
  db: Db,
  env: ProcessingEnv,
  mode: { final: boolean; throughIdx?: number; waitingSince?: number },
) {
  const meeting = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  if (!meeting) return;
  if (meeting.status === 'complete') {
    if (mode.final) await env.PROCESSING_QUEUE.send({ kind: 'embed', meetingId });
    return;
  }

  if (!mode.final && !['recording', 'uploading'].includes(meeting.status)) return;
  let failedSegments = 0;
  if (mode.final) {
    const states = await db
      .select({ status: meetingSegments.transcribeStatus })
      .from(meetingSegments)
      .where(eq(meetingSegments.meetingId, meetingId));
    const inFlight = states.filter((row) => row.status === 'pending' || row.status === 'processing').length;
    failedSegments = states.filter((row) => row.status === 'failed').length;
    const waitingSince = mode.waitingSince ?? Date.now();
    if (inFlight > 0 && Date.now() - waitingSince < SUMMARY_WAIT_LIMIT_MS) {
      await env.PROCESSING_QUEUE.send(
        { kind: 'summarize', meetingId, waitingSince },
        { delaySeconds: 60 },
      );
      return;
    }
    failedSegments += inFlight;
    await removeEcho(db, meetingId);
  }

  let segments = await db
    .select()
    .from(transcriptSegments)
    .where(eq(transcriptSegments.meetingId, meetingId))
    .orderBy(transcriptSegments.startMs);
  const prior = (
    await db.select().from(summaries).where(eq(summaries.meetingId, meetingId)).limit(1)
  )[0];

  if (!mode.final && mode.throughIdx !== undefined) {
    const firstWindowSegment = (
      await db
        .select()
        .from(meetingSegments)
        .where(
          and(
            eq(meetingSegments.meetingId, meetingId),
            gte(meetingSegments.idx, Math.max(0, mode.throughIdx - 2)),
          ),
        )
        .orderBy(meetingSegments.idx)
        .limit(1)
    )[0];
    if (firstWindowSegment) {
      segments = segments.filter((segment) => segment.startMs >= firstWindowSegment.offsetMs);
    }
  }
  const partial = failedSegments > 0
    ? `${failedSegments} part${failedSegments === 1 ? '' : 's'} of this recording could not be transcribed; the transcript has gaps.`
    : null;
  if (segments.length === 0) {
    if (mode.final) {
      const now = Date.now();
      await db
        .update(meetings)
        .set(failedSegments > 0
          ? { status: 'failed', statusError: 'The recording could not be transcribed.', updatedAt: now }
          : { status: 'complete', statusError: null, updatedAt: now })
        .where(eq(meetings.id, meetingId));
      if (failedSegments === 0) await logMeetingComplete(db, meeting.userId, meetingId, now);
    }
    return;
  }

  const lastLineEnd = segments.reduce((end, segment) => Math.max(end, segment.endMs), 0);
  const meetingMs = Math.max(lastLineEnd, (meeting.durationSec ?? 0) * 1_000);
  const wantChapters = mode.final && meetingMs >= MIN_CHAPTER_MEETING_MS;
  const rendered = transcriptText(segments, meeting.speakerNamesJson, { timestamps: wantChapters });
  let transcript = rendered.text;
  let priorSummary = prior?.tldr ?? '';
  if (mode.final && transcript.length > 600_000 && priorSummary) {
    transcript = transcript.slice(-80_000);
    priorSummary = `${priorSummary}\n\nThe transcript below is the final tail of the session.`;
  }

  const userRow = (await db.select().from(users).where(eq(users.id, meeting.userId)).limit(1))[0];
  const plan = resolveModelPlan(userRow ? await openUserKeys(userRow) : undefined);
  const parsed = await requestMeetingSummary(anthropicForUser(plan.summary.apiKey ?? env.ANTHROPIC_API_KEY), {
    transcript,
    contextBlurb: meeting.contextBlurb,
    priorSummary,
    rolling: !mode.final,
    recorderName: rendered.recorderName,
    chapters: wantChapters,
  });
  const generatedByModel = plan.summary.apiKey
    ? `byo-anthropic:${MEETING_SUMMARY_MODEL}`
    : MEETING_SUMMARY_MODEL;
  const now = Date.now();
  const values = {
    ...summaryValues(parsed),
    ...(wantChapters
      ? {
          chaptersJson: encode(
            validateChapters(parsed.chapters, segments.map((segment) => segment.startMs), meetingMs),
          ),
        }
      : {}),
  };
  await db
    .insert(summaries)
    .values({
      id: ulid(),
      meetingId,
      ...values,
      generatedByModel,
      generatedAt: now,
    })
    .onConflictDoUpdate({
      target: summaries.meetingId,
      set: { ...values, generatedByModel, generatedAt: now },
      setWhere: mode.final
        ? undefined
        : sql`(select status from meetings where id = ${meetingId}) in ('recording', 'uploading')`,
    });

  const title = stringValue(parsed.title, meeting.title);
  const description = stringValue(parsed.description, meeting.description);
  if (mode.final) {
    await db
      .update(meetings)
      .set({ title, description, status: 'complete', statusError: partial, updatedAt: now })
      .where(eq(meetings.id, meetingId));
    await logMeetingComplete(db, meeting.userId, meetingId, now);
    await env.PROCESSING_QUEUE.send({ kind: 'embed', meetingId });
  } else {
    await db
      .update(meetings)
      .set({
        title,
        description,
        rollingNotesAt: mode.throughIdx,
        updatedAt: now,
      })
      .where(and(eq(meetings.id, meetingId), inArray(meetings.status, ['recording', 'uploading'])));
  }
}

async function logMeetingComplete(db: Db, userId: string, meetingId: string, now: number) {
  await db
    .insert(activityLog)
    .values({
      id: `act_complete_${meetingId}`,
      userId,
      eventType: 'meeting.complete',
      meetingId,
      metadataJson: '{}',
      createdAt: now,
    })
    .onConflictDoNothing();
}

function summaryValues(parsed: Record<string, unknown>) {
  return {
    tldr: stringValue(parsed.tldr, ''),
    decisionsJson: encode(records(parsed.decisions).map((item) => ({ text: stringValue(item.text, '') }))),
    actionItemsJson: encode(
      records(parsed.actionItems).map((item) => ({
        text: stringValue(item.text, ''),
        owner: optionalString(item.owner),
        due: optionalString(item.due),
        completed: false,
      })),
    ),
    followUpsJson: encode(records(parsed.followUps).map((item) => ({ text: stringValue(item.text, '') }))),
    openQuestionsJson: encode(
      records(parsed.openQuestions).map((item) => ({ text: stringValue(item.text, '') })),
    ),
    topicsJson: encode(Array.isArray(parsed.topics) ? parsed.topics.map((topic) => String(topic)) : []),
    mentionsJson: encode(
      records(parsed.mentions).map((item) => ({
        entity: stringValue(item.entity, ''),
        type: ['person', 'product', 'company', 'project'].includes(String(item.type))
          ? String(item.type)
          : 'person',
      })),
    ),
  };
}

async function handleEmbedMeeting(meetingId: string, db: Db, env: ProcessingEnv) {
  const meeting = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  if (!meeting) return;
  const segments = await db
    .select()
    .from(transcriptSegments)
    .where(eq(transcriptSegments.meetingId, meetingId))
    .orderBy(transcriptSegments.startMs);
  await replaceEmbeddings(db, env, {
    userId: meeting.userId,
    sourceType: 'meeting',
    sourceId: meeting.id,
    text: transcriptText(segments, meeting.speakerNamesJson).text,
  });
}

async function handleEmbedDictation(dictationId: string, db: Db, env: ProcessingEnv) {
  const dictation = (
    await db.select().from(dictations).where(eq(dictations.id, dictationId)).limit(1)
  )[0];
  if (!dictation) return;
  await replaceEmbeddings(db, env, {
    userId: dictation.userId,
    sourceType: 'dictation',
    sourceId: dictation.id,
    text: dictation.cleanedText || dictation.transcript,
  });
}

async function replaceEmbeddings(
  db: Db,
  env: ProcessingEnv,
  source: { userId: string; sourceType: 'meeting' | 'dictation'; sourceId: string; text: string },
) {
  const chunks = chunkText(source.text, 2_000);
  if (chunks.length === 0) return;
  const vectors = await embedTexts(env.AI, chunks);
  const previous = await db
    .select({ id: embeddings.id })
    .from(embeddings)
    .where(and(eq(embeddings.sourceType, source.sourceType), eq(embeddings.sourceId, source.sourceId)));
  if (previous.length > 0) await env.VECTORIZE.deleteByIds(previous.map((row) => row.id));
  await db
    .delete(embeddings)
    .where(and(eq(embeddings.sourceType, source.sourceType), eq(embeddings.sourceId, source.sourceId)));

  const now = Date.now();
  const vectorRows = vectors.map((values, chunkIdx) => ({
    id: `${source.sourceId}__${chunkIdx}`,
    values,
    metadata: { userId: source.userId, sourceType: source.sourceType, sourceId: source.sourceId, chunkIdx },
  }));
  await runBatched(db, chunks.map((chunk, chunkIdx) =>
    db.insert(embeddings).values({
      id: vectorRows[chunkIdx].id,
      userId: source.userId,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      chunkIdx,
      contentExcerpt: chunk.slice(0, 280),
      createdAt: now,
    }),
  ));
  await env.VECTORIZE.upsert(vectorRows);
}

async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function deleteEmbeddings(
  sourceType: 'meeting' | 'dictation',
  sourceId: string,
  db: Db,
  env: ProcessingEnv,
) {
  const rows = await db
    .select({ id: embeddings.id })
    .from(embeddings)
    .where(and(eq(embeddings.sourceType, sourceType), eq(embeddings.sourceId, sourceId)));
  if (!rows.length) return;
  await env.VECTORIZE.deleteByIds(rows.map((row) => row.id));
  await db.delete(embeddings).where(and(eq(embeddings.sourceType, sourceType), eq(embeddings.sourceId, sourceId)));
}

async function handleCleanup(meetingId: string, db: Db, env: ProcessingEnv) {
  const meeting = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  if (!meeting) return;
  if (meeting.audioR2Key) await env.AUDIO_BUCKET.delete(meeting.audioR2Key);
  const upload = (await db.select().from(meetingUploads).where(eq(meetingUploads.meetingId, meetingId)).limit(1))[0];
  if (upload && upload.state !== 'complete') {
    try {
      await env.AUDIO_BUCKET.resumeMultipartUpload(
        `users/${meeting.userId}/meetings/${meetingId}/audio.${meeting.audioFormat === 'webm' || meeting.audioFormat === 'opus' ? meeting.audioFormat : 'm4a'}`,
        upload.uploadId,
      ).abort();
    } catch {
      // Already completed or expired; nothing left to abort.
    }
  }
  const segmentKeys = await db
    .select({ key: meetingSegments.r2Key })
    .from(meetingSegments)
    .where(eq(meetingSegments.meetingId, meetingId));
  for (let i = 0; i < segmentKeys.length; i += 1000) {
    await env.AUDIO_BUCKET.delete(segmentKeys.slice(i, i + 1000).map((row) => row.key));
  }
  await deletePrefix(env.AUDIO_BUCKET, `users/${meeting.userId}/meetings/${meetingId}/`);
  await deleteEmbeddings('meeting', meetingId, db, env);
  await db.delete(meetings).where(eq(meetings.id, meetingId));
}

async function handlePurgeAccount(userId: string, db: Db, env: ProcessingEnv) {
  const owned = await db.select({ id: meetings.id }).from(meetings).where(eq(meetings.userId, userId));
  for (const meeting of owned) await handleCleanup(meeting.id, db, env);

  const vectorIds = await db.select({ id: embeddings.id }).from(embeddings).where(eq(embeddings.userId, userId));
  for (let i = 0; i < vectorIds.length; i += 500) {
    await env.VECTORIZE.deleteByIds(vectorIds.slice(i, i + 500).map((row) => row.id));
  }
  await deletePrefix(env.AUDIO_BUCKET, `users/${userId}/`);
  await deletePrefix(env.AUDIO_BUCKET, `anonymous/${userId}/`);

  for (const table of [
    'embeddings',
    'captures',
    'dictations',
    'calendar_events',
    'calendar_connections',
    'speakers',
    'folders',
    'prompt_templates',
    'mcp_tokens',
    'device_tokens',
    'devices',
    'activity_log',
    'subscriptions',
  ]) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId).run();
  }
  await env.DB.prepare('DELETE FROM device_pairing_codes WHERE claimed_by_user_id = ?').bind(userId).run();
  await db.delete(users).where(eq(users.id, userId));
}

const STALE_SEGMENT_SWEEP_LIMIT = 100;

/**
 * Queue segments whose transcription claim outlived any possible consumer.
 * Without this, a segment whose worker died after its queue message gave up
 * would stay 'processing' and leave a gap in the transcript.
 *
 * Each row is sent first and reset to 'pending' only after its send succeeds,
 * so a failed send leaves the row stale for the next sweep. Failures are
 * reported, never thrown: the rest of the cron must still run.
 */
export async function recoverStaleSegments(env: ProcessingEnv, now = Date.now()) {
  const db = drizzle(env.DB, { schema });
  const stale = and(
    eq(meetingSegments.transcribeStatus, 'processing'),
    or(isNull(meetingSegments.transcribeClaimedAt), lt(meetingSegments.transcribeClaimedAt, now - SEGMENT_CLAIM_TTL_MS)),
  );
  let candidates;
  try {
    candidates = await db
      .select({
        id: meetingSegments.id,
        meetingId: meetingSegments.meetingId,
        idx: meetingSegments.idx,
        track: meetingSegments.track,
      })
      .from(meetingSegments)
      .where(stale)
      .limit(STALE_SEGMENT_SWEEP_LIMIT);
  } catch (error) {
    reportError('could not look up stale segment claims', error);
    return;
  }
  let requeued = 0;
  for (const { id, ...segment } of candidates) {
    try {
      await env.PROCESSING_QUEUE.send({ kind: 'transcribe-segment', ...segment });
      // Conditional on still being stale: if the message was already picked up
      // and claimed, the fresh claim is left alone.
      await db
        .update(meetingSegments)
        .set({ transcribeStatus: 'pending', transcribeClaimedAt: null })
        .where(and(eq(meetingSegments.id, id), stale));
      requeued += 1;
    } catch (error) {
      reportError('could not requeue stale segment claim', error, { segment });
    }
  }
  if (candidates.length > 0) {
    console.warn(
      JSON.stringify({ message: 'requeued stale segment claims', count: requeued, failed: candidates.length - requeued }),
    );
  }
}

export async function sealLegacyKeys(env: ProcessingEnv) {
  const db = drizzle(env.DB, { schema });
  const rows = await db
    .select({
      id: users.id,
      byoAnthropicKey: users.byoAnthropicKey,
      byoDeepgramKey: users.byoDeepgramKey,
      byoOpenRouterKey: users.byoOpenRouterKey,
    })
    .from(users)
    .where(
      // The first term matches users_byo_keys_idx exactly, so only users who
      // ever saved a key are read.
      sql`(byo_anthropic_key IS NOT NULL OR byo_deepgram_key IS NOT NULL OR byo_openrouter_key IS NOT NULL)
        AND ((${users.byoAnthropicKey} IS NOT NULL AND ${users.byoAnthropicKey} NOT LIKE 'enc:%')
        OR (${users.byoDeepgramKey} IS NOT NULL AND ${users.byoDeepgramKey} NOT LIKE 'enc:%')
        OR (${users.byoOpenRouterKey} IS NOT NULL AND ${users.byoOpenRouterKey} NOT LIKE 'enc:%'))`,
    )
    .limit(200);
  let sealed = 0;
  for (const row of rows) {
    const patch = {
      byoAnthropicKey: await sealSecret(row.byoAnthropicKey),
      byoDeepgramKey: await sealSecret(row.byoDeepgramKey),
      byoOpenRouterKey: await sealSecret(row.byoOpenRouterKey),
    };
    if (![patch.byoAnthropicKey, patch.byoDeepgramKey, patch.byoOpenRouterKey].some(isSealed)) continue;
    await db.update(users).set(patch).where(eq(users.id, row.id));
    sealed += 1;
  }
  return sealed;
}

export const PURGE_AFTER_MS = 24 * 60 * 60 * 1_000;

export async function purgeDeleted(env: ProcessingEnv, now = Date.now()) {
  const db = drizzle(env.DB, { schema });
  const cutoff = now - PURGE_AFTER_MS;

  const deletedMeetings = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(lte(meetings.deletedAt, cutoff))
    .limit(200);
  for (const meeting of deletedMeetings) {
    await env.PROCESSING_QUEUE.send({ kind: 'purge-meeting', meetingId: meeting.id });
  }

  const deletedCaptures = await db
    .select({ id: captures.id, r2Key: captures.r2Key })
    .from(captures)
    .where(lte(captures.deletedAt, cutoff))
    .limit(200);
  for (const capture of deletedCaptures) {
    await env.AUDIO_BUCKET.delete(capture.r2Key);
    await db.delete(captures).where(eq(captures.id, capture.id));
  }

  const deletedDictations = await db
    .select({ id: dictations.id, audioR2Key: dictations.audioR2Key })
    .from(dictations)
    .where(lte(dictations.deletedAt, cutoff))
    .limit(200);
  for (const dictation of deletedDictations) {
    if (dictation.audioR2Key) await env.AUDIO_BUCKET.delete(dictation.audioR2Key);
    await deleteEmbeddings('dictation', dictation.id, db, env);
    await db.delete(dictations).where(eq(dictations.id, dictation.id));
  }

  return {
    meetings: deletedMeetings.length,
    captures: deletedCaptures.length,
    dictations: deletedDictations.length,
  };
}

const D1_BATCH_SIZE = 50;

/** Sends row writes to D1 in batches: one round trip per 50 rows, not per row. */
async function runBatched(db: Db, statements: BatchItem<'sqlite'>[]) {
  for (let i = 0; i < statements.length; i += D1_BATCH_SIZE) {
    const [first, ...rest] = statements.slice(i, i + D1_BATCH_SIZE);
    await db.batch([first, ...rest]);
  }
}

function chunkText(text: string, maxChars: number): string[] {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buffer = '';
  for (const line of lines) {
    if (buffer && buffer.length + line.length + 1 > maxChars) {
      chunks.push(buffer);
      buffer = '';
    }
    buffer += `${buffer ? '\n' : ''}${line}`;
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
