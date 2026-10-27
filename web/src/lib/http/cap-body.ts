/**
 * Passes `body` through until it runs past `limit` bytes, then errors, which
 * cancels the upload. `overflowed()` tells that error apart from a bad body.
 */
export function capBody(body: ReadableStream<Uint8Array>, limit: number) {
  let total = 0;
  let overflow = false;
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > limit) {
          overflow = true;
          controller.error(new Error('body too large'));
        } else {
          controller.enqueue(chunk);
        }
      },
    }),
  );
  return { stream, overflowed: () => overflow };
}

/** The whole body, or null when it runs past `limit` bytes. */
export async function readCappedBody(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const { stream, overflowed } = capBody(body, limit);
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (error) {
    if (overflowed()) return null;
    throw error;
  }
}
