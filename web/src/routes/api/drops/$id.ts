import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as dropsRepo from '@/db/repo/drops';
import { resolveActor } from '@/server/auth';
import { publish } from '@/server/drops-hub';
import { originFrom } from '@/server/drops';
import { deleteObject, getObject } from '@/server/r2';
import { reportError } from '@/server/observability';

// Raster images may render inline (thumbnails); everything else is forced to
// download so arbitrary uploads can never execute on this origin.
const INLINE_IMAGE = /^image\/(png|jpeg|webp|gif|avif)$/;

export const Route = createFileRoute('/api/drops/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const drop = await dropsRepo.get(getDb(), { dropId: params.id, userId: actor.userId });
        if (!drop) return Response.json({ error: 'not found' }, { status: 404 });

        const headers = new Headers({
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
        });

        if (drop.kind === 'text' && drop.text != null) {
          headers.set('content-type', 'text/plain; charset=utf-8');
          if (new URL(request.url).searchParams.has('download')) {
            headers.set('content-disposition', disposition('attachment', 'drop.txt'));
          }
          return new Response(drop.text, { headers });
        }

        if (!drop.r2Key) return Response.json({ error: 'not found' }, { status: 404 });
        const obj = await getObject(drop.r2Key);
        if (!obj) return Response.json({ error: 'not found' }, { status: 404 });

        if (drop.kind === 'text') {
          headers.set('content-type', 'text/plain; charset=utf-8');
        } else {
          const type = (drop.contentType ?? '').toLowerCase();
          const inline = INLINE_IMAGE.test(type) && new URL(request.url).searchParams.has('inline');
          headers.set('content-type', inline ? type : 'application/octet-stream');
          headers.set('content-disposition', disposition(inline ? 'inline' : 'attachment', drop.filename ?? 'file'));
        }
        headers.set('content-length', String(obj.size));
        return new Response(obj.body as unknown as ReadableStream, { headers });
      },

      DELETE: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        const drop = await dropsRepo.get(db, { dropId: params.id, userId: actor.userId });
        if (!drop) return Response.json({ error: 'not found' }, { status: 404 });

        await dropsRepo.remove(db, { dropId: drop.id, userId: actor.userId });
        if (drop.r2Key) {
          try {
            await deleteObject(drop.r2Key);
          } catch (error) {
            reportError('drop object delete failed', error, { dropId: drop.id });
          }
        }
        await publish(actor.userId, { type: 'delete', id: drop.id, origin: originFrom(request) });
        return Response.json({ ok: true });
      },
    },
  },
});

function disposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
