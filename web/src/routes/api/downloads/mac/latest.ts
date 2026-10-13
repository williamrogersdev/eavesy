import { createFileRoute } from '@tanstack/react-router';
import { getObject } from '@/server/r2';

const DMG_KEY = process.env.MAC_DMG_R2_KEY ?? 'downloads/mac/eavesy-latest.dmg';
const DOWNLOAD_FILENAME = 'Eavesy.dmg';

export const Route = createFileRoute('/api/downloads/mac/latest')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const rangeHeader = request.headers.get('range');
        const parsed = rangeHeader ? parseRange(rangeHeader) : null;

        const obj = await getObject(
          DMG_KEY,
          parsed ? { offset: parsed.offset, length: parsed.length } : undefined,
        );

        if (!obj) {
          return new Response(null, {
            status: 302,
            headers: { location: '/download/mac?status=coming-soon' },
          });
        }

        const total = obj.size;
        const headers = new Headers({
          'content-type': 'application/x-apple-diskimage',
          'content-disposition': `attachment; filename="${DOWNLOAD_FILENAME}"`,
          'accept-ranges': 'bytes',
          'cache-control': 'public, max-age=300',
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
