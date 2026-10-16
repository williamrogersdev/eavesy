import { getObject } from '@/server/r2';

/**
 * Streams a DMG from R2 with Range support (browsers and Homebrew resume
 * interrupted downloads). Returns null when the object does not exist.
 */
export async function serveDmgFromR2(
  request: Request,
  key: string,
  options: { filename: string; cacheControl: string },
): Promise<Response | null> {
  const rangeHeader = request.headers.get('range');
  const parsed = rangeHeader ? parseRange(rangeHeader) : null;

  const obj = await getObject(key, parsed ? { offset: parsed.offset, length: parsed.length } : undefined);
  if (!obj) return null;

  const total = obj.size;
  const headers = new Headers({
    'content-type': 'application/x-apple-diskimage',
    'content-disposition': `attachment; filename="${options.filename}"`,
    'accept-ranges': 'bytes',
    'cache-control': options.cacheControl,
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
}

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
