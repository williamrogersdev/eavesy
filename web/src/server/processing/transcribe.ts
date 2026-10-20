import { guardedImportWrite } from './import-guard';
import { createAiRunner } from '@/lib/ai/credit-runner';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { meetings, meetingSegments, summaries, transcriptSegments, users } from '@/db/schema';
import { encode } from '@/db/codec';
import * as projectsRepo from '@/db/repo/projects';
import { MODELS } from '@/lib/ai/client';
import { summarizeMeeting } from '@/lib/ai/summarize';
import { combinedContext, projectTerms } from '@/lib/projects';
import { resolveModelPlan } from '@/lib/providers/router';
import { retryLanguage, spokenLanguages, whisperLanguage } from '@/lib/transcription/language';
import { transcribeAudioFile } from '@/lib/transcription/transcribe-file';
import { WorkersAiSegmentTranscriber } from '@/lib/transcription/provider/workers-ai';
import { parseVocabulary } from '@/lib/transcription/vocabulary';
import {
  ECHO_WINDOW_MS,
  findEchoLines,
  isHallucination,
  isSilentTrack,
  speakerForTrack,
} from '@/lib/transcription/two-track';
import { openUserKeys } from '@/server/secret-box';
import { recordFirstTranscript } from '@/server/transcript-latency';
import {
  type Db,
  type ProcessingEnv,
  SEGMENT_CLAIM_TTL_MS,
  SegmentBusyError,
  runBatched,
} from './shared';
import { logMeetingComplete } from './summarize';

/** Rolling notes refresh each time the transcribed audio crosses another interval. */
export const ROLLING_NOTES_EVERY_MS = 4 * 60 * 1_000;
/** Each refresh also rereads this much from before the interval, for continuity. */
export const ROLLING_NOTES_OVERLAP_MS = 60 * 1_000;

/**
 * Whether this segment's audio crosses a rolling-notes boundary. It depends only
 * on where the segment sits, so it fires once per boundary whatever the segment
 * length and in whatever order segments finish.
 */
export function crossesRollingNotesBoundary(segment: { offsetMs: number; durationMs: number }) {
  const end = segment.offsetMs + segment.durationMs;
  return Math.floor(end / ROLLING_NOTES_EVERY_MS) > Math.floor(segment.offsetMs / ROLLING_NOTES_EVERY_MS);
}

export async function handleProcessRecording(meetingId: string, db: Db, env: ProcessingEnv) {
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
  const project = await projectsRepo.getForMeeting(db, meeting);
  const transcription = await transcribeAudioFile({
    audio: new Uint8Array(await object.arrayBuffer()),
    language: meeting.language,
    contextBlurb: meeting.contextBlurb,
    vocabulary: [...projectTerms(project), ...parseVocabulary(userRow?.customVocabularyJson).reverse()],
    spoken: userRow ? spokenLanguages(userRow) : [],
    ai: env.AI,
  });
  const language = whisperLanguage(meeting.language) ?? transcription.language ?? null;

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
        language,
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
          language,
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
      contextBlurb: combinedContext(meeting.contextBlurb, project) ?? undefined,
      openRouter: plan.openRouter,
      byoApiKey: plan.summary.apiKey ?? env.ANTHROPIC_API_KEY,
      notesLanguage: userRow?.notesLanguage,
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
    if (fullText.trim()) await env.PROCESSING_QUEUE.send({ kind: 'agent-transcript', meetingId });
  }
}

export async function handleTranscribeSegment(
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
    const micOnly = track === 'mic' && !(await hasSystemTrack(db, meetingId));
    if (!isSilentTrack(track, segment.activeMs, { micOnly })) {
      const object = await env.AUDIO_BUCKET.get(segment.r2Key);
      if (!object) throw new Error(`segment object missing: ${segment.r2Key}`);
      const audio = new Uint8Array(await object.arrayBuffer());
      const transcriber = new WorkersAiSegmentTranscriber(meeting.source === 'import' ? createAiRunner(env, 'import-transcription') : env.AI);
      const prefs = await userPrefs(db, meeting.userId);
      const request = {
        audio,
        language: meeting.language,
        contextBlurb: meeting.contextBlurb,
        vocabulary: [
          ...projectTerms(await projectsRepo.getForMeeting(db, meeting)),
          ...prefs.vocabulary,
        ],
      };
      let transcription = await transcriber.transcribe(request);
      let language = whisperLanguage(meeting.language) ?? transcription.language;
      if (!whisperLanguage(meeting.language) && transcription.segments.length > 0) {
        const retry = retryLanguage({
          setting: meeting.language,
          detected: transcription.language,
          probability: transcription.languageProbability,
          established: await establishedLanguage(db, meetingId),
          spoken: prefs.spoken,
        });
        if (retry) {
          const again = await transcriber.transcribe({ ...request, language: retry });
          if (again.segments.length > 0) {
            transcription = again;
            language = again.language ?? retry;
          }
        }
      }
      const speakerId = speakerForTrack(track);
      const glossary = request.vocabulary;
      let lines = transcription.segments.filter(
        (relative) => !isHallucination(relative, { lenient: micOnly, glossary }),
      );
      // Whisper's VAD can cut a quiet mic down to nothing. A mic-only clip is
      // the user's own note, so give it one more pass without VAD, keeping the
      // strict filter so silence does not turn into "Thank you."
      if (micOnly && lines.length === 0 && segment.activeMs !== 0) {
        const retry = await transcriber.transcribe({ ...request, language, vadFilter: false });
        language ??= retry.language;
        lines = retry.segments.filter((relative) => !isHallucination(relative, { glossary }));
      }

      const current = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
      if (!current[0] || current[0].deletedAt || (meeting.source === 'import' && current[0].status === 'failed')) return;
      const writes = lines.map((relative) => {
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
            language: language ?? null,
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
              language: language ?? null,
              isFinal: true,
            },
          });
      });
      if (meeting.source === 'import') {
        // Completed batches remain available for resume; every later write
        // rechecks cancellation. Cancelled recordings stay excluded from memory.
        for (let at = 0; at < writes.length; at += 50) {
          await env.DB.batch(writes.slice(at, at + 50).map(write => guardedImportWrite(env, write.toSQL(), meetingId)));
        }
      } else await runBatched(db, writes);
      if (lines.length > 0) await recordFirstTranscript(db, meeting, segment);
    }

    if (track !== 'mixed') {
      await removeEcho(db, meetingId, {
        fromMs: segment.offsetMs - ECHO_WINDOW_MS,
        toMs: segment.offsetMs + segment.durationMs + ECHO_WINDOW_MS,
      });
    }

    // Stamped after echo removal, so a live client that reads this range sees
    // it already cleaned up.
    await db
      .update(meetingSegments)
      .set({ transcribeStatus: 'complete', transcribedAt: Date.now() })
      .where(ownClaim);

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
    if (
      meeting.source !== 'import' && siblingsPending.length === 0 &&
      crossesRollingNotesBoundary(segment) &&
      (await claimRollingNotes(db, meetingId, idx))
    ) {
      await env.PROCESSING_QUEUE.send({
        kind: 'rolling-summarize',
        meetingId,
        throughIdx: idx,
        throughMs: segment.offsetMs + segment.durationMs,
      });
    }
  } catch (error) {
    await db
      .update(meetingSegments)
      .set({ transcribeStatus: 'pending', transcribeClaimedAt: null })
      .where(ownClaim);
    throw error;
  }
}

async function userPrefs(db: Db, userId: string): Promise<{ vocabulary: string[]; spoken: string[] }> {
  const row = await db
    .select({
      customVocabularyJson: users.customVocabularyJson,
      spokenLanguagesJson: users.spokenLanguagesJson,
      defaultLanguage: users.defaultLanguage,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return {
    vocabulary: parseVocabulary(row[0]?.customVocabularyJson).reverse(),
    spoken: row[0] ? spokenLanguages(row[0]) : [],
  };
}

/** The language most of the meeting has been spoken in so far, by amount of text. */
async function establishedLanguage(db: Db, meetingId: string): Promise<string | undefined> {
  const weight = sql<number>`sum(length(${transcriptSegments.text}))`;
  const row = await db
    .select({ language: transcriptSegments.language, weight })
    .from(transcriptSegments)
    .where(and(eq(transcriptSegments.meetingId, meetingId), isNotNull(transcriptSegments.language)))
    .groupBy(transcriptSegments.language)
    .orderBy(desc(weight))
    .limit(1);
  return row[0]?.language ?? undefined;
}

/** Whether any part of the meeting recorded the computer's audio: a two-sided call. */
async function hasSystemTrack(db: Db, meetingId: string): Promise<boolean> {
  const row = await db
    .select({ id: meetingSegments.id })
    .from(meetingSegments)
    .where(and(eq(meetingSegments.meetingId, meetingId), eq(meetingSegments.track, 'system')))
    .limit(1);
  return row.length > 0;
}

/**
 * Both tracks of a segment can finish together and each see no sibling still
 * pending; only the one whose conditional update lands enqueues the notes.
 * D1 runs writes one at a time, so exactly one claim per segment index wins.
 */
export async function claimRollingNotes(db: Db, meetingId: string, idx: number): Promise<boolean> {
  const claimed = await db
    .update(meetings)
    .set({ rollingNotesAt: idx })
    .where(
      and(
        eq(meetings.id, meetingId),
        or(isNull(meetings.rollingNotesAt), lt(meetings.rollingNotesAt, idx)),
      ),
    )
    .returning({ id: meetings.id });
  return claimed.length > 0;
}

export async function removeEcho(db: Db, meetingId: string, range?: { fromMs: number; toMs: number }) {
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
