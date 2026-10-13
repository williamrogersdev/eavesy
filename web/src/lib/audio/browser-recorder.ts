export type AudioCaptureState =
  | 'idle'
  | 'requesting-permission'
  | 'pre-flight'
  | 'recording'
  | 'paused'
  | 'stopped'
  | 'error';

export interface AudioCaptureOptions {
  captureSystemAudio?: boolean;
  onChunk?: (chunk: Blob) => void;
  chunkIntervalMs?: number;
  onLevel?: (mic: number, system: number) => void;
  onStateChange?: (state: AudioCaptureState, error?: Error) => void;
  segmentMs?: number;
  onSegment?: (segment: RecordedSegment) => void;
}

export interface RecordedSegment {
  idx: number;
  blob: Blob;
  startMs: number;
  durationMs: number;
}

export class BrowserAudioCapture {
  private micStream: MediaStream | null = null;
  private systemStream: MediaStream | null = null;
  private mixedStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private systemAnalyser: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private rafHandle: number | null = null;
  private state: AudioCaptureState = 'idle';
  private segmentRecorder: MediaRecorder | null = null;
  private segmentTimer: number | null = null;
  private segmentIdx = 0;
  private segmentStartMs = 0;
  private segmentBankedMs = 0;
  private runningSince: number | null = null;
  private segmentFlushed: Promise<void> = Promise.resolve();
  private segmentParts: Blob[] = [];

  constructor(private readonly opts: AudioCaptureOptions = {}) {}

  getRecordedBlob(mimeType?: string): Blob {
    return new Blob(this.chunks, { type: mimeType ?? this.recorder?.mimeType ?? 'audio/webm' });
  }

  get mimeType(): string {
    return this.recorder?.mimeType || 'audio/webm';
  }

  getState(): AudioCaptureState {
    return this.state;
  }

  private setState(state: AudioCaptureState, error?: Error) {
    this.state = state;
    this.opts.onStateChange?.(state, error);
  }

  async requestPermissions(): Promise<void> {
    this.setState('requesting-permission');
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
          sampleRate: 16000,
        },
        video: false,
      });

      if (this.opts.captureSystemAudio) {
        try {
          this.systemStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          });
          this.systemStream.getVideoTracks().forEach((t) => t.stop());
        } catch (err) {
          console.warn('System audio capture failed; continuing with mic only:', err);
          this.systemStream = null;
        }
      }
    } catch (err) {
      this.setState('error', err as Error);
      throw err;
    }
  }

  startPreflight(): void {
    if (!this.micStream) {
      throw new Error('Permissions not granted — call requestPermissions() first');
    }
    this.audioContext = new AudioContext({ sampleRate: 16000 });

    const micSource = this.audioContext.createMediaStreamSource(this.micStream);
    this.micAnalyser = this.audioContext.createAnalyser();
    this.micAnalyser.fftSize = 512;
    micSource.connect(this.micAnalyser);

    if (this.systemStream && this.systemStream.getAudioTracks().length > 0) {
      const sysSource = this.audioContext.createMediaStreamSource(this.systemStream);
      this.systemAnalyser = this.audioContext.createAnalyser();
      this.systemAnalyser.fftSize = 512;
      sysSource.connect(this.systemAnalyser);
    }

    this.tickLevels();
    this.setState('pre-flight');
  }

  async start(): Promise<void> {
    if (!this.micStream) throw new Error('No mic stream');
    if (!this.audioContext) this.startPreflight();

    const dest = this.audioContext!.createMediaStreamDestination();
    const micSource = this.audioContext!.createMediaStreamSource(this.micStream);
    micSource.connect(dest);
    if (this.systemStream && this.systemStream.getAudioTracks().length > 0) {
      const sysSource = this.audioContext!.createMediaStreamSource(this.systemStream);
      sysSource.connect(dest);
    }
    this.mixedStream = dest.stream;

    const mimeType = pickSupportedMimeType();
    this.chunks = [];
    this.recorder = new MediaRecorder(this.mixedStream, {
      mimeType,
      audioBitsPerSecond: 64_000,
    });

    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
        this.opts.onChunk?.(e.data);
      }
    };

    const started = new Promise<void>((resolve) => {
      this.recorder!.onstart = () => {
        this.setState('recording');
        resolve();
      };
    });
    this.recorder.start(this.opts.chunkIntervalMs ?? 250);
    await started;
    if (this.opts.segmentMs && this.opts.onSegment) this.startSegment(this.recorder.mimeType || mimeType);
  }

  private segmentElapsedMs(): number {
    return this.segmentBankedMs + (this.runningSince === null ? 0 : Date.now() - this.runningSince);
  }

  private startSegment(mimeType: string) {
    const recorder = new MediaRecorder(this.mixedStream!, { mimeType, audioBitsPerSecond: 64_000 });
    const parts: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) parts.push(e.data);
    };
    this.segmentRecorder = recorder;
    this.segmentParts = parts;
    this.segmentBankedMs = 0;
    this.runningSince = Date.now();
    recorder.start();
    this.armSegmentTimer();
  }

  private armSegmentTimer() {
    if (this.segmentTimer !== null) window.clearTimeout(this.segmentTimer);
    const remaining = Math.max(0, this.opts.segmentMs! - this.segmentElapsedMs());
    this.segmentTimer = window.setTimeout(() => {
      this.segmentTimer = null;
      void this.endSegment(this.recorder?.state === 'recording');
    }, remaining);
  }

  private endSegment(rollOver = false): Promise<void> {
    const recorder = this.segmentRecorder;
    if (!recorder || recorder.state === 'inactive') return this.segmentFlushed;
    this.segmentRecorder = null;
    if (this.segmentTimer !== null) {
      window.clearTimeout(this.segmentTimer);
      this.segmentTimer = null;
    }
    const parts = this.segmentParts;
    const durationMs = Math.round(this.segmentElapsedMs());
    const startMs = this.segmentStartMs;
    const idx = this.segmentIdx;
    this.segmentIdx += 1;
    this.segmentStartMs += durationMs;
    this.runningSince = null;
    if (rollOver) this.startSegment(recorder.mimeType);
    const previous = this.segmentFlushed;
    this.segmentFlushed = new Promise<void>((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(parts, { type: recorder.mimeType || 'audio/webm' });
        void previous.then(() => {
          if (blob.size > 0 && durationMs > 0) this.opts.onSegment?.({ idx, blob, startMs, durationMs });
          resolve();
        });
      };
      recorder.stop();
    });
    return this.segmentFlushed;
  }

  pause(): void {
    this.recorder?.pause();
    if (this.segmentRecorder?.state === 'recording') {
      this.segmentRecorder.pause();
      if (this.runningSince !== null) this.segmentBankedMs += Date.now() - this.runningSince;
      this.runningSince = null;
      if (this.segmentTimer !== null) window.clearTimeout(this.segmentTimer);
      this.segmentTimer = null;
    }
    this.setState('paused');
  }

  resume(): void {
    this.recorder?.resume();
    if (this.segmentRecorder?.state === 'paused') {
      this.segmentRecorder.resume();
      this.runningSince = Date.now();
      this.armSegmentTimer();
    }
    this.setState('recording');
  }

  async stop(): Promise<Blob> {
    await this.endSegment();
    return new Promise((resolve) => {
      if (!this.recorder) {
        resolve(new Blob([]));
        return;
      }
      this.recorder.onstop = () => {
        const blob = this.getRecordedBlob();
        this.setState('stopped');
        resolve(blob);
      };
      this.recorder.stop();
    });
  }

  dispose(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    if (this.segmentTimer !== null) window.clearTimeout(this.segmentTimer);
    if (this.segmentRecorder && this.segmentRecorder.state !== 'inactive') {
      this.segmentRecorder.ondataavailable = null;
      this.segmentRecorder.stop();
    }
    this.segmentRecorder = null;
    this.recorder?.stream.getTracks().forEach((t) => t.stop());
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.systemStream?.getTracks().forEach((t) => t.stop());
    this.audioContext?.close().catch(() => {});
    this.micStream = null;
    this.systemStream = null;
    this.mixedStream = null;
    this.audioContext = null;
    this.micAnalyser = null;
    this.systemAnalyser = null;
    this.recorder = null;
  }

  private tickLevels = () => {
    const mic = this.micAnalyser ? rmsLevel(this.micAnalyser) : 0;
    const sys = this.systemAnalyser ? rmsLevel(this.systemAnalyser) : 0;
    this.opts.onLevel?.(mic, sys);
    this.rafHandle = requestAnimationFrame(this.tickLevels);
  };
}

function rmsLevel(analyser: AnalyserNode): number {
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = (buf[i] - 128) / 128;
    sum += x * x;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 2);
}

function pickSupportedMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return 'audio/webm';
}
