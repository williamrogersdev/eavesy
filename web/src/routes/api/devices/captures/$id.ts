import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as capturesRepo from '@/db/repo/captures';
import { safeMediaType } from '@/lib/http/media-type';
import { resolveIngestActor } from '@/server/device-auth';
import { getObject } from '@/server/r2';

// The image or note of one capture, for a Mac bringing it into its history.
export const Route = createFileRoute('/api/devices/captures/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const capture = await capturesRepo.get(getDb(), { captureId: params.id, userId: actor.userId });
        if (!capture || (capture.kind !== 'image' && capture.kind !== 'note')) return Response.json({ error: 'not found' }, { status: 404 });
        const object = await getObject(capture.r2Key);
        if (!object) return Response.json({ error: 'not found' }, { status: 404 });
        return new Response(object.body as unknown as ReadableStream, {
          headers: {
            'content-type': safeMediaType(object.httpMetadata?.contentType ?? capture.contentType),
            'content-length': String(object.size),
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      },
    },
  },
});
