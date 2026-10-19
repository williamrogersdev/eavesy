import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  activityLog,
  meetings,
  meetingSegments,
  summaries,
  transcriptSegments,
  users,
} from '@/db/schema';
import { encode } from '@/db/codec';
import { ulid } from '@/db/ids';
import { clock, MIN_CHAPTER_MEETING_MS, validateChapters } from '@/lib/ai/chapters';
import { anthropicForUser } from '@/lib/ai/client';
import { requestMeetingSummary, summaryModel } from '@/lib/ai/meeting-summary';
import { resolveModelPlan } from '@/lib/providers/router';
import { hasBothSides, parseSpeakerNames, speakerName } from '@/lib/transcription/two-track';
import { openUserKeys } from '@/server/secret-box';
import {
  type Db,
  type ProcessingEnv,
  SUMMARY_WAIT_LIMIT_MS,
  optionalString,
  records,
  stringValue,
} from './shared';
import { ROLLING_NOTES_EVERY_MS, ROLLING_NOTES_OVERLAP_MS, removeEcho } from './transcribe';

/**
 * How long the final summary waits before checking segments again. Right after
 * stop usually only the last segment or two are left and Whisper takes seconds,
 * so check back quickly at first instead of always adding a minute.
 */
export function summaryRetryDelaySeconds(inFlight: number, waitedMs: number) {
  if (inFlight <= 4 && waitedMs < 10 * 1_000) return 2;
  if (inFlight <= 4 && waitedMs < 30 * 1_000) return 5;
  if (inFlight <= 4 && waitedMs < 2 * 60 * 1_000) return 10;
  if (waitedMs < 5 * 60 * 1_000) return 30;
  return 60;
}

export function transcriptText(
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

export async function handleSummarize(
  meetingId: string,
  db: Db,
  env: ProcessingEnv,
  mode: { final: boolean; throughIdx?: number; throughMs?: number; waitingSince?: number },
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
        { delaySeconds: summaryRetryDelaySeconds(inFlight, Date.now() - waitingSince) },
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

  if (!mode.final && mode.throughMs !== undefined) {
    const from = mode.throughMs - ROLLING_NOTES_EVERY_MS - ROLLING_NOTES_OVERLAP_MS;
    segments = segments.filter((segment) => segment.startMs >= from);
  } else if (!mode.final && mode.throughIdx !== undefined) {
    // Jobs queued before time-based notes: the window is the last three segments.
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

  if (mode.final && (await isQuickNote(db, meetingId, meetingMs, segments))) {
    // A dictation or short voice note: the words are the whole point and a
    // summary of two sentences is noise. Finish now instead of waiting on Claude.
    const now = Date.now();
    await db
      .update(meetings)
      .set({ title: quickNoteTitle(segments, meeting.title), status: 'complete', statusError: partial, updatedAt: now })
      .where(eq(meetings.id, meetingId));
    await logMeetingComplete(db, meeting.userId, meetingId, now);
    await env.PROCESSING_QUEUE.send({ kind: 'embed', meetingId });
    return;
  }
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
    notesLanguage: userRow?.notesLanguage,
  });
  const model = summaryModel(!mode.final);
  const generatedByModel = plan.summary.apiKey ? `byo-anthropic:${model}` : model;
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

/** A recording this short, from the mic alone, is a note: no summary. */
export const QUICK_NOTE_MAX_MS = 60_000;
const QUICK_NOTE_MAX_WORDS = 150;

async function isQuickNote(db: Db, meetingId: string, meetingMs: number, lines: { text: string }[]) {
  if (meetingMs > QUICK_NOTE_MAX_MS) return false;
  const words = lines.reduce((count, line) => count + line.text.split(/\s+/).filter(Boolean).length, 0);
  if (words > QUICK_NOTE_MAX_WORDS) return false;
  const tracks = await db
    .selectDistinct({ track: meetingSegments.track })
    .from(meetingSegments)
    .where(eq(meetingSegments.meetingId, meetingId));
  return tracks.length > 0 && tracks.every((row) => row.track === 'mic');
}

/** The note's first few words, so History shows something better than "Voice memo". */
export function quickNoteTitle(lines: { text: string }[], fallback: string) {
  const words = lines.map((line) => line.text).join(' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return fallback;
  const head = words.slice(0, 8).join(' ').replace(/[.,;:!?]+$/, '');
  return words.length > 8 ? `${head}…` : head;
}

export async function logMeetingComplete(db: Db, userId: string, meetingId: string, now: number) {
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
