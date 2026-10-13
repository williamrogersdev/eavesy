import type { RecordedSegment } from '@/lib/audio/browser-recorder';

const PART_BYTES = 8 * 1024 * 1024;
export const SEGMENT_MS = 4 * 60 * 1000;
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

export type ArchiveFormat = 'm4a' | 'webm' | 'opus';

export function archiveFormatForMime(mimeType: string): ArchiveFormat {
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('ogg')) return 'opus';
  return 'webm';
}

class PermanentUploadError extends Error {}

async function responseError(response: Response): Promise<Error> {
  let message = `Upload failed (${response.status})`;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
      message = (body as { error: string }).error;
    }
  } catch {
    // Not JSON; keep the status message.
  }
  const permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
  return permanent ? new PermanentUploadError(message) : new Error(message);
}

async function withRetry<T>(task: () => Promise<T>, delaysMs: readonly number[]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (error instanceof PermanentUploadError || attempt >= delaysMs.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}

export class SessionUpload {
  private queue: Array<() => Promise<void>> = [];
  private draining: Promise<void> | null = null;
  private failure: Error | null = null;
  private pending: Blob[] = [];
  private pendingBytes = 0;
  private nextPart = 1;

  meetingId: string | null = null;

  constructor(mimeType: string, private readonly retryDelaysMs: readonly number[] = RETRY_DELAYS_MS) {
    this.enqueue(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientSessionId: this.clientSessionId,
          title: 'Recording in progress…',
          archiveFormat: archiveFormatForMime(mimeType),
        }),
      });
      if (!res.ok) throw await responseError(res);
      const body = await res.json<{ meetingId?: unknown }>();
      if (typeof body.meetingId !== 'string') throw new Error('Server returned an invalid recording');
      this.meetingId = body.meetingId;
    });
  }

  private readonly clientSessionId = crypto.randomUUID();

  private enqueue(task: () => Promise<void>) {
    this.queue.push(task);
    void this.drain();
  }

  private drain(): Promise<void> {
    this.draining ??= (async () => {
      await Promise.resolve();
      try {
        while (this.queue.length) {
          await withRetry(this.queue[0], this.retryDelaysMs);
          this.queue.shift();
        }
        this.failure = null;
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error('Upload failed');
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  addSegment(segment: RecordedSegment) {
    this.enqueue(async () => {
      const res = await fetch(`/api/sessions/${this.meetingId}/segments/${segment.idx}`, {
        method: 'PUT',
        headers: {
          'content-type': segment.blob.type || 'audio/webm',
          'x-segment-start-ms': String(segment.startMs),
          'x-segment-duration-ms': String(segment.durationMs),
          'x-segment-track': 'mixed',
        },
        body: segment.blob,
      });
      if (!res.ok) throw await responseError(res);
    });
  }

  addArchiveChunk(chunk: Blob) {
    this.pending.push(chunk);
    this.pendingBytes += chunk.size;
    while (this.pendingBytes > PART_BYTES) {
      const all = new Blob(this.pending);
      const part = all.slice(0, PART_BYTES);
      const rest = all.slice(PART_BYTES);
      this.pending = [rest];
      this.pendingBytes = rest.size;
      const partNumber = this.nextPart;
      this.nextPart += 1;
      this.enqueue(async () => {
        const res = await fetch(`/api/sessions/${this.meetingId}/parts/${partNumber}`, { method: 'PUT', body: part });
        if (!res.ok) throw await responseError(res);
      });
    }
  }

  async finish(): Promise<void> {
    await this.drain();
    if (this.failure) throw this.failure;
    const remainder = new Blob(this.pending);
    if (remainder.size === 0) throw new Error('Nothing was recorded');
    await withRetry(async () => {
      const res = await fetch(`/api/sessions/${this.meetingId}/finalize`, { method: 'POST', body: remainder });
      if (!res.ok) throw await responseError(res);
    }, this.retryDelaysMs);
  }

  async discard(): Promise<void> {
    this.queue = [];
    await this.draining;
    if (this.meetingId) {
      await fetch(`/api/meetings/${this.meetingId}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }
}
