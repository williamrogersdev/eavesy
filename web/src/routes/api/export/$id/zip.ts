import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import * as meetingsRepo from '@/db/repo/meetings';
import { meetingFolderFiles, zipInputFor } from '@/lib/export/zip';
import { zipStream, type ZipEntry } from '@/lib/export/zip-stream';
import { folderName } from '@/lib/export/meeting-folder';
import { resolveActor } from '@/server/auth';
import { getAudio } from '@/server/r2';
import { guardBurst, guardUserQuota } from '@/server/rate-limit';

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

        const limited =
          (await guardBurst(actor.userId, 'meeting-export')) ??
          (await guardUserQuota(actor.userId, 'meeting-export'));
        if (limited) return limited;

        const { meeting } = data;

        // The audio is piped from R2 into the archive, never held in memory.
        let audio: { filename: string; contentType: string; size: number; body: ReadableStream<Uint8Array> } | undefined;
        if (meeting.audioR2Key) {
          try {
            const obj = await getAudio(meeting.audioR2Key);
            if (obj) {
              audio = {
                filename: `audio.${meeting.audioFormat ?? 'webm'}`,
                contentType: obj.httpMetadata?.contentType ?? 'audio/webm',
                size: obj.size,
                body: obj.body as unknown as ReadableStream<Uint8Array>,
              };
            }
          } catch (err) {
            console.warn('audio fetch failed; zip excludes audio', err);
          }
        }

        const input = zipInputFor(data, audio && { filename: audio.filename, contentType: audio.contentType });
        const encoder = new TextEncoder();
        const entries: ZipEntry[] = meetingFolderFiles(input).map((file) => {
          const bytes = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
          return { name: file.name, size: bytes.byteLength, data: bytes };
        });
        if (audio) {
          const body = audio.body;
          entries.push({ name: `${folderName(input.meeting)}/${audio.filename}`, size: audio.size, data: () => body });
        }
        const archive = zipStream(entries);

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

        // FixedLengthStream gives the response its Content-Length and errors
        // the download if the archive comes out a different size.
        return new Response(archive.stream.pipeThrough(new FixedLengthStream(archive.length)), {
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
