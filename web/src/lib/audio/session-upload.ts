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
  private started = false;
  private discarded = false;

  meetingId: string | null = null;

  /**
   * Pass the recorder's mime type to create the session immediately, or `null`
   * to collect audio first and call `begin` once the recorder has started:
   * MediaRecorder can emit its first chunk before `start()` resolves.
   */
  constructor(mimeType: string | null, private readonly retryDelaysMs: readonly number[] = RETRY_DELAYS_MS) {
    if (mimeType) this.begin(mimeType);
  }

  private readonly clientSessionId = crypto.randomUUID();

  begin(mimeType: string) {
    if (this.started || this.discarded) return;
    this.started = true;
    this.queue.unshift(async () => {
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
    void this.drain();
  }

  /** Every upload goes to the session the create request returned, never to `null`. */
  private sessionPath(): string {
    if (!this.meetingId) throw new PermanentUploadError('The recording was not created');
    return `/api/sessions/${this.meetingId}`;
  }

  private enqueue(task: () => Promise<void>) {
    if (this.discarded) return;
    this.queue.push(task);
    void this.drain();
  }

  private drain(): Promise<void> {
    if (!this.started) return Promise.resolve();
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
      const res = await fetch(`${this.sessionPath()}/segments/${segment.idx}`, {
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
        const res = await fetch(`${this.sessionPath()}/parts/${partNumber}`, { method: 'PUT', body: part });
        if (!res.ok) throw await responseError(res);
      });
    }
  }

  async finish(): Promise<void> {
    if (!this.started) throw new Error('The recording never started');
    await this.drain();
    if (this.failure) throw this.failure;
    const remainder = new Blob(this.pending);
    if (remainder.size === 0) throw new Error('Nothing was recorded');
    await withRetry(async () => {
      const res = await fetch(`${this.sessionPath()}/finalize`, { method: 'POST', body: remainder });
      if (!res.ok) throw await responseError(res);
    }, this.retryDelaysMs);
  }

  async discard(): Promise<void> {
    this.discarded = true;
    this.queue = [];
    await this.draining;
    if (this.meetingId) {
      await fetch(`/api/meetings/${this.meetingId}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }
}
