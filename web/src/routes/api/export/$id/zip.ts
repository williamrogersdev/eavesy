import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import * as meetingsRepo from '@/db/repo/meetings';
import { buildMeetingZip, zipInputFor } from '@/lib/export/zip';
import { folderName } from '@/lib/export/meeting-folder';
import { resolveActor } from '@/server/auth';
import { getAudio } from '@/server/r2';

export const Route = createFileRoute('/api/export/$id/zip')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { id } = params;
        const url = new URL(request.url);

        let actor;
        try {
          actor = await resolveActor({
            anonymousSessionToken: url.searchParams.get('anonymousSessionToken') ?? undefined,
          });
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const db = getDb();
        const data = await meetingsRepo.getFull(db, {
          meetingId: id,
          userId: actor.userId,
        });
        if (!data) return Response.json({ error: 'not found' }, { status: 404 });

        const { meeting } = data;

        let audioOriginal: { filename: string; data: Uint8Array; contentType: string } | undefined;
        if (meeting.audioR2Key) {
          try {
            const obj = await getAudio(meeting.audioR2Key);
            if (obj) {
              const buf = new Uint8Array(await obj.arrayBuffer());
              const ext = meeting.audioFormat ?? 'webm';
              audioOriginal = {
                filename: `audio.${ext}`,
                data: buf,
                contentType: obj.httpMetadata?.contentType ?? 'audio/webm',
              };
            }
          } catch (err) {
            console.warn('audio fetch failed; zip excludes audio', err);
          }
        }

        const zipBytes = await buildMeetingZip(zipInputFor(data, audioOriginal));

        await activityRepo.log(db, {
          userId: actor.userId,
          eventType: 'meeting.export',
          meetingId: id,
          metadata: { format: 'zip' },
        });

        const filename = `${folderName({
          id: meeting.id,
          title: meeting.title,
          description: '',
          startedAt: meeting.startedAt,
        })}.zip`;

        return new Response(new Uint8Array(zipBytes), {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-store',
          },
        });
      },
    },
  },
});
