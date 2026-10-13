import { createFileRoute } from '@tanstack/react-router';
import { resolveActor } from '@/server/auth';
import { getObject } from '@/server/r2';
import { safeMediaType } from '@/lib/http/media-type';

export const Route = createFileRoute('/api/media/$')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const path = params._splat ?? '';
        if (!path) return json({ error: 'bad key' }, 400);

        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return json({ error: 'unauthenticated' }, 401);
        }

        const [scope, ownerId] = path.split('/');
        if (scope !== 'users' || !ownerId) return json({ error: 'invalid media path' }, 400);
        if (ownerId !== actor.userId) return json({ error: 'forbidden' }, 403);

        const rangeHeader = request.headers.get('range');
        const parsed = rangeHeader ? parseRange(rangeHeader) : null;

        const obj = await getObject(path, parsed ? { offset: parsed.offset, length: parsed.length } : undefined);
        if (!obj) return json({ error: 'not found' }, 404);

        const total = obj.size;
        const contentType = safeMediaType(obj.httpMetadata?.contentType);
        const headers = new Headers({
          'content-type': contentType,
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
        });

        if (parsed) {
          const start = parsed.offset;
          const end = parsed.length != null ? Math.min(start + parsed.length - 1, total - 1) : total - 1;
          headers.set('content-range', `bytes ${start}-${end}/${total}`);
          headers.set('content-length', String(end - start + 1));
          return new Response(obj.body as unknown as ReadableStream, { status: 206, headers });
        }

        headers.set('content-length', String(total));
        return new Response(obj.body as unknown as ReadableStream, { status: 200, headers });
      },
    },
  },
});

function parseRange(header: string): { offset: number; length?: number } | null {
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const offset = Number(m[1]);
  if (!Number.isFinite(offset)) return null;
  if (m[2] === '') return { offset };
  const end = Number(m[2]);
  if (!Number.isFinite(end) || end < offset) return { offset };
  return { offset, length: end - offset + 1 };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
