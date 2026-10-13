import { createFileRoute } from '@tanstack/react-router';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import { meetings } from '@/db/schema';
import { resolveActor } from '@/server/auth';

const schema = z.object({ contentMd: z.string().min(1).max(200_000) });

export const Route = createFileRoute('/api/meetings/$id/brief')({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const parsed = schema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request' }, { status: 400 });
        }
        const { contentMd } = parsed.data;
        const db = getDb();
        const result = await db
          .update(meetings)
          .set({
            summaryOverrideMd: contentMd,
            localFilesUpdatedAt: Date.now(),
            updatedAt: Date.now(),
          })
          .where(and(eq(meetings.id, params.id), eq(meetings.userId, actor.userId)));
        if (!result.meta.changes) return Response.json({ error: 'not_found' }, { status: 404 });
        await activityRepo.log(db, {
          userId: actor.userId,
          eventType: 'meeting.edit_brief',
          meetingId: params.id,
        });
        return Response.json({ ok: true });
      },
      DELETE: async ({ params }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        const result = await db
          .update(meetings)
          .set({ summaryOverrideMd: null, updatedAt: Date.now() })
          .where(and(eq(meetings.id, params.id), eq(meetings.userId, actor.userId)));
        if (!result.meta.changes) return Response.json({ error: 'not_found' }, { status: 404 });
        return Response.json({ ok: true });
      },
    },
  },
});
