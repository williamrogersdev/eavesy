import { createFileRoute } from '@tanstack/react-router';
import { resolveActor } from '@/server/auth';
import { parseByteRange } from '@/lib/http/byte-range';
import { safeMediaType } from '@/lib/http/media-type';
import { getAudio, headAudio } from '@/server/r2';

export const Route = createFileRoute('/api/audio/$')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const path = params._splat ?? '';
        if (!path) return Response.json({ error: 'bad key' }, { status: 400 });

        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const [scope, ownerId] = path.split('/');
        if ((scope !== 'users' && scope !== 'anonymous') || !ownerId) {
          return Response.json({ error: 'invalid audio path' }, { status: 400 });
        }
        if (ownerId !== actor.userId) {
          return Response.json({ error: 'forbidden' }, { status: 403 });
        }

        const head = await headAudio(path);
        if (!head) return Response.json({ error: 'not found' }, { status: 404 });
        const range = parseByteRange(request.headers.get('range'), head.size);
        const headers = new Headers();
        headers.set('content-type', safeMediaType(head.httpMetadata?.contentType));
        headers.set('x-content-type-options', 'nosniff');
        headers.set('accept-ranges', 'bytes');
        headers.set('cache-control', 'private, max-age=3600');
        if (range === 'unsatisfiable') {
          headers.set('content-range', `bytes */${head.size}`);
          return new Response(null, { status: 416, headers });
        }

        const obj = await getAudio(path, range ?? undefined);
        if (!obj || !('body' in obj)) return Response.json({ error: 'not found' }, { status: 404 });
        if (range) {
          headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
          headers.set('content-length', String(range.length));
          return new Response(obj.body as unknown as BodyInit, { status: 206, headers });
        }
        headers.set('content-length', String(head.size));
        return new Response(obj.body as unknown as BodyInit, { status: 200, headers });
      },
    },
  },
});
