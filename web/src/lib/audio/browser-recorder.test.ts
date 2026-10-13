import { beforeAll, expect, test } from 'bun:test';
import type { RecordedSegment } from '@/lib/audio/browser-recorder';

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstart: (() => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(readonly stream: unknown) {}
  start() {
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(1)]) });
      this.onstop?.();
    }, 1);
  }
}

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.MediaRecorder = FakeMediaRecorder;
  g.requestAnimationFrame = () => 0;
  g.cancelAnimationFrame = () => undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function recorder(onSegment: (s: RecordedSegment) => void) {
  const { BrowserAudioCapture } = await import('@/lib/audio/browser-recorder');
  const capture = new BrowserAudioCapture({ segmentMs: 40, onSegment });
  const fakeStream = { getTracks: () => [], getAudioTracks: () => [] };
  Object.assign(capture as unknown as Record<string, unknown>, {
    micStream: fakeStream,
    audioContext: {
      createMediaStreamDestination: () => ({ stream: fakeStream }),
      createMediaStreamSource: () => ({ connect: () => undefined }),
      close: async () => undefined,
    },
  });
  await capture.start();
  return capture;
}

test('rolls over into back-to-back segments that tile the recording', async () => {
  const segments: RecordedSegment[] = [];
  const capture = await recorder((s) => segments.push(s));
  await sleep(130);
  await capture.stop();
  capture.dispose();

  expect(segments.length).toBeGreaterThanOrEqual(3);
  expect(segments.map((s) => s.idx)).toEqual(segments.map((_, i) => i));
  for (let i = 1; i < segments.length; i += 1) {
    expect(segments[i].startMs).toBe(segments[i - 1].startMs + segments[i - 1].durationMs);
  }
  for (const s of segments.slice(0, -1)) expect(s.durationMs).toBeGreaterThanOrEqual(40);
});

test('paused time is not counted towards a segment', async () => {
  const segments: RecordedSegment[] = [];
  const capture = await recorder((s) => segments.push(s));
  await sleep(10);
  capture.pause();
  await sleep(80);
  capture.resume();
  await sleep(10);
  await capture.stop();
  capture.dispose();

  expect(segments).toHaveLength(1);
  expect(segments[0].durationMs).toBeLessThan(40);
});
