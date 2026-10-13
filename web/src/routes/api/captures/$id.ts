import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import * as capturesRepo from '@/db/repo/captures';
import { resolveActor } from '@/server/auth';
import { deleteObject, mediaProxyUrl } from '@/server/r2';

export const Route = createFileRoute('/api/captures/$id')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { id } = params;
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const capture = await capturesRepo.get(getDb(), { captureId: id, userId: actor.userId });
        if (!capture) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json({ ...capture, url: mediaProxyUrl(capture.r2Key) });
      },

      DELETE: async ({ params }) => {
        const { id } = params;
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const db = getDb();
        const capture = await capturesRepo.get(db, { captureId: id, userId: actor.userId });
        if (!capture) return Response.json({ error: 'not found' }, { status: 404 });

        await capturesRepo.softDelete(db, { captureId: id, userId: actor.userId });
        try {
          await deleteObject(capture.r2Key);
        } catch (err) {
          console.warn('[captures] R2 delete failed', capture.r2Key, err);
        }
        await activityRepo.log(db, { userId: actor.userId, eventType: 'capture.delete' });

        return Response.json({ ok: true });
      },
    },
  },
});
