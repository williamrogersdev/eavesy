import { serveR2Object } from '@/server/r2-ranged';

/**
 * Streams a DMG from R2 with Range support (browsers and Homebrew resume
 * interrupted downloads). Returns null when the object does not exist.
 */
export async function serveDmgFromR2(
  request: Request,
  key: string,
  options: { filename: string; cacheControl: string },
): Promise<Response | null> {
  return await serveR2Object(
    request,
    key,
    new Headers({
      'content-disposition': `attachment; filename="${options.filename}"`,
      'cache-control': options.cacheControl,
    }),
    () => 'application/x-apple-diskimage',
  );
}
