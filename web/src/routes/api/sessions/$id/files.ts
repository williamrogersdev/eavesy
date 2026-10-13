import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as notesRepo from '@/db/repo/notes';
import { meetings } from '@/db/schema';
import { resolveIngestActor } from '@/server/device-auth';
import { ownedMeeting } from '@/server/session-ingest';
import { eq } from 'drizzle-orm';

const editSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('notes'),
    contentMd: z.string().max(50_000),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    role: z.enum(['summary', 'transcript']),
    contentMd: z.string().max(5 * 1024 * 1024),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);

export const Route = createFileRoute('/api/sessions/$id/files')({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const body = editSchema.parse(await request.json());
        const db = getDb();
        const meeting = await ownedMeeting(db, params.id, actor);
        if (!meeting) return Response.json({ error: 'not_found' }, { status: 404 });

        const now = Date.now();
        if (body.role === 'notes') {
          await notesRepo.upsert(db, {
            meetingId: meeting.id,
            contentMd: notesBody(body.contentMd),
          });
          await db
            .update(meetings)
            .set({ localFilesUpdatedAt: now, updatedAt: now })
            .where(eq(meetings.id, meeting.id));
        } else {
          await db
            .update(meetings)
            .set({
              ...(body.role === 'summary'
                ? { summaryOverrideMd: body.contentMd }
                : { transcriptOverrideMd: body.contentMd }),
              localFilesUpdatedAt: now,
              updatedAt: now,
            })
            .where(eq(meetings.id, meeting.id));
        }
        return Response.json({ ok: true, contentHash: body.contentHash, updatedAt: now });
      },
    },
  },
});

function notesBody(markdown: string): string {
  return markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '')
    .replace(/^# Notes\s*\r?\n+/, '')
    .trim();
}
