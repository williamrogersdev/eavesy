import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as meetingsRepo from '@/db/repo/meetings';
import * as notesRepo from '@/db/repo/notes';
import { resolveActor } from '@/server/auth';

const schema = z.object({
  meetingId: z.string().min(1),
  contentMd: z.string().max(50_000),
});

export const Route = createFileRoute('/api/notes')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsedBody = schema.safeParse(await request.json().catch(() => null));
        if (!parsedBody.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const body = parsedBody.data;
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        const meeting = await meetingsRepo.get(db, { meetingId: body.meetingId, userId: actor.userId });
        if (!meeting) return Response.json({ error: 'not found' }, { status: 404 });
        await notesRepo.upsert(db, body);
        return Response.json({ ok: true });
      },
    },
  },
});
