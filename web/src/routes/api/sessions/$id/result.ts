import { createFileRoute } from '@tanstack/react-router';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { meetingSegments, summaries, transcriptSegments, userNotes } from '@/db/schema';
import { resolveIngestActor } from '@/server/device-auth';
import { ownedMeeting, transcriptReady } from '@/server/session-ingest';
import { hasBothSides, parseSpeakerNames, speakerName } from '@/lib/transcription/two-track';

export const Route = createFileRoute('/api/sessions/$id/result')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        const meeting = await ownedMeeting(db, params.id, actor);
        if (!meeting) return Response.json({ error: 'not_found' }, { status: 404 });

        const [segments, summaryRows, noteRows, parts] = await Promise.all([
          db
            .select({
              startMs: transcriptSegments.startMs,
              text: transcriptSegments.text,
              rawText: transcriptSegments.rawText,
              speakerId: transcriptSegments.speakerId,
            })
            .from(transcriptSegments)
            .where(eq(transcriptSegments.meetingId, meeting.id))
            .orderBy(transcriptSegments.startMs),
          db.select().from(summaries).where(eq(summaries.meetingId, meeting.id)).limit(1),
          db.select().from(userNotes).where(eq(userNotes.meetingId, meeting.id)).limit(1),
          db
            .select({ status: meetingSegments.transcribeStatus })
            .from(meetingSegments)
            .where(eq(meetingSegments.meetingId, meeting.id)),
        ]);
        const summary = summaryRows[0];
        const names = parseSpeakerNames(meeting.speakerNamesJson);
        const labelled = hasBothSides(segments);
        const transcript = segments.map((segment) => ({
          startMs: segment.startMs,
          text: segment.text,
          rawText: segment.rawText,
          speaker: labelled && segment.speakerId ? speakerName(segment.speakerId, names) : null,
        }));
        return Response.json({
          meetingId: meeting.id,
          status: meeting.status,
          title: meeting.title,
          summaryOverrideMd: meeting.summaryOverrideMd,
          transcriptOverrideMd: meeting.transcriptOverrideMd,
          agentTranscriptMd: meeting.agentTranscriptMd,
          notesMd: noteRows[0]?.contentMd ?? '',
          transcriptReady: transcriptReady(meeting.status, parts),
          transcript,
          summary: summary
            ? {
                tldr: summary.tldr,
                decisionsJson: summary.decisionsJson,
                actionItemsJson: summary.actionItemsJson,
                followUpsJson: summary.followUpsJson,
                openQuestionsJson: summary.openQuestionsJson,
              }
            : null,
        });
      },
    },
  },
});
