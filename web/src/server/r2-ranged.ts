import { parseByteRange } from '@/lib/http/byte-range';
import { bucket } from '@/server/r2';

/**
 * Streams an R2 object with HTTP Range support: 206 for a satisfiable range
 * (suffix ranges like `bytes=-500` included), 416 for one past the end, 200
 * otherwise. Only range requests pay for the extra `head` that sizing the
 * range needs. Returns null when the object does not exist.
 *
 * `headers` carries the caller's own headers; `contentType` picks the type
 * from the object's metadata.
 */
export async function serveR2Object(
  request: Request,
  key: string,
  headers: Headers,
  contentType: (stored: string | undefined) => string,
): Promise<Response | null> {
  headers.set('accept-ranges', 'bytes');
  const rangeHeader = request.headers.get('range');
  let range: { offset: number; length: number } | null = null;
  if (rangeHeader) {
    const head = await bucket().head(key);
    if (!head) return null;
    const parsed = parseByteRange(rangeHeader, head.size);
    if (parsed === 'unsatisfiable') {
      headers.set('content-type', contentType(head.httpMetadata?.contentType));
      headers.set('content-range', `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }
    range = parsed;
  }

  const obj = await bucket().get(key, range ? { range } : undefined);
  if (!obj || !('body' in obj)) return null;
  headers.set('content-type', contentType(obj.httpMetadata?.contentType));
  if (range) {
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`);
    headers.set('content-length', String(range.length));
    return new Response(obj.body as unknown as ReadableStream, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body as unknown as ReadableStream, { status: 200, headers });
}
