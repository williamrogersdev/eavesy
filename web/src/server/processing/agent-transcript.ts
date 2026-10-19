import { eq } from 'drizzle-orm';
import { meetings, transcriptSegments, users } from '@/db/schema';
import * as projectsRepo from '@/db/repo/projects';
import { buildAgentTranscript } from '@/lib/ai/agent-transcript';
import { anthropicForUser } from '@/lib/ai/client';
import { combinedContext } from '@/lib/projects';
import { resolveModelPlan } from '@/lib/providers/router';
import { toTurns, transcriptKind } from '@/lib/transcription/agent-transcript';
import { parseVocabulary } from '@/lib/transcription/vocabulary';
import { parseSpeakerNames, speakerName } from '@/lib/transcription/two-track';
import { reportError } from '@/server/observability';
import { openUserKeys } from '@/server/secret-box';
import type { Db, ProcessingEnv } from './shared';

export async function handleAgentTranscript(
  meetingId: string,
  db: Db,
  env: ProcessingEnv,
  opts: { onlyIfMissing?: boolean } = {},
) {
  const meeting = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  if (!meeting || meeting.deletedAt || meeting.status !== 'complete') return;
  if (opts.onlyIfMissing && meeting.agentTranscriptMd) return;

  const lines = await readLines(db, meetingId);
  if (lines.length === 0) return;
  const builtFrom = fingerprint(meeting, lines);

  const kind = transcriptKind(lines);
  const names = parseSpeakerNames(meeting.speakerNamesJson);
  const turns = toTurns(lines, kind, names);
  if (turns.length === 0) return;

  const project = await projectsRepo.getForMeeting(db, meeting);
  const userRow = (await db.select().from(users).where(eq(users.id, meeting.userId)).limit(1))[0];
  const plan = resolveModelPlan(userRow ? await openUserKeys(userRow) : undefined);
  const apiKey = plan.summary.apiKey ?? env.ANTHROPIC_API_KEY;

  const result = await buildAgentTranscript(apiKey ? anthropicForUser(apiKey) : null, {
    turns,
    kind,
    context: combinedContext(meeting.contextBlurb, project, parseVocabulary(userRow?.customVocabularyJson)),
    meta: {
      title: meeting.title,
      startedAt: meeting.startedAt,
      project: project?.name,
      recorderName: kind === 'conversation' ? speakerName('you', names) : undefined,
    },
  });
  if (apiKey && result.fallbackChunks > 0) {
    reportError('agent transcript used plain cleanup', new Error('cleanup fallback'), {
      meetingId,
      fallbackChunks: result.fallbackChunks,
    });
  }

  // An edit while the model ran queued its own rebuild: leave the write to it,
  // so a copy of the old lines never lands after a copy of the new ones.
  const now = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  if (!now || fingerprint(now, await readLines(db, meetingId)) !== builtFrom) return;

  await db
    .update(meetings)
    .set({ agentTranscriptMd: result.markdown, transcriptKind: kind, updatedAt: Date.now() })
    .where(eq(meetings.id, meetingId));
}

function readLines(db: Db, meetingId: string) {
  return db
    .select({
      speakerId: transcriptSegments.speakerId,
      startMs: transcriptSegments.startMs,
      endMs: transcriptSegments.endMs,
      text: transcriptSegments.text,
    })
    .from(transcriptSegments)
    .where(eq(transcriptSegments.meetingId, meetingId))
    .orderBy(transcriptSegments.startMs);
}

/** What a refresh rebuilds the cleaned transcript for: lines, speaker names and project. */
function fingerprint(
  meeting: { speakerNamesJson: string | null; folderId: string | null },
  lines: { speakerId: string | null; startMs: number; text: string }[],
): string {
  return JSON.stringify([
    meeting.speakerNamesJson,
    meeting.folderId,
    lines.map((line) => [line.speakerId, line.startMs, line.text]),
  ]);
}
