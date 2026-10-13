export type PcmCaptureState =
  | 'idle'
  | 'requesting-permission'
  | 'recording'
  | 'stopped'
  | 'error';

export interface PcmCaptureOptions {
  captureSystemAudio?: boolean;
  onFrame?: (pcm: ArrayBuffer) => void;
  onLevel?: (mic: number, system: number) => void;
  onStateChange?: (state: PcmCaptureState, error?: Error) => void;
}

const TARGET_SAMPLE_RATE = 24000;

const WORKLET_SOURCE = `
class PcmFramer extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._count = 0;
    // ~100 ms at the context sample rate; sampleRate is a worklet global.
    this._target = Math.round(sampleRate * 0.1);
  }
  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (ch && ch.length) {
      this._buf.push(ch.slice(0));
      this._count += ch.length;
      if (this._count >= this._target) {
        const merged = new Float32Array(this._count);
        let off = 0;
        for (const b of this._buf) { merged.set(b, off); off += b.length; }
        this.port.postMessage(merged, [merged.buffer]);
        this._buf = [];
        this._count = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-framer', PcmFramer);
`;

export class PcmStreamCapture {
  private micStream: MediaStream | null = null;
  private systemStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletUrl: string | null = null;
  private state: PcmCaptureState = 'idle';
  private lastMicLevel = 0;
  private lastSystemLevel = 0;

  constructor(private readonly opts: PcmCaptureOptions = {}) {}

  getState(): PcmCaptureState {
    return this.state;
  }

  private setState(state: PcmCaptureState, error?: Error) {
    this.state = state;
    this.opts.onStateChange?.(state, error);
  }

  async requestPermissions(): Promise<void> {
    this.setState('requesting-permission');
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
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
          console.warn('System audio capture failed; mic only:', err);
          this.systemStream = null;
        }
      }
    } catch (err) {
      this.setState('error', err as Error);
      throw err;
    }
  }

  async start(): Promise<void> {
    if (!this.micStream) throw new Error('Permissions not granted');

    const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    this.audioContext = ctx;

    this.workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
    );
    await ctx.audioWorklet.addModule(this.workletUrl);

    const merger = ctx.createGain();
    const micSource = ctx.createMediaStreamSource(this.micStream);
    micSource.connect(merger);
    if (this.systemStream && this.systemStream.getAudioTracks().length > 0) {
      ctx.createMediaStreamSource(this.systemStream).connect(merger);
    }

    const node = new AudioWorkletNode(ctx, 'pcm-framer', { numberOfOutputs: 0 });
    this.workletNode = node;
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      const float = ev.data;
      this.lastMicLevel = rms(float);
      this.opts.onLevel?.(this.lastMicLevel, this.lastSystemLevel);
      this.opts.onFrame?.(floatToPcm16(float).buffer as ArrayBuffer);
    };
    merger.connect(node);

    if (ctx.state === 'suspended') await ctx.resume();
    this.setState('recording');
  }

  stop(): void {
    this.setState('stopped');
    this.teardown();
  }

  dispose(): void {
    this.teardown();
  }

  private teardown() {
    try {
      this.workletNode?.port.close();
      this.workletNode?.disconnect();
    } catch {
      /* noop */
    }
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.systemStream?.getTracks().forEach((t) => t.stop());
    this.audioContext?.close().catch(() => {});
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
    this.workletNode = null;
    this.micStream = null;
    this.systemStream = null;
    this.audioContext = null;
    this.workletUrl = null;
  }
}

function floatToPcm16(float: Float32Array): Int16Array {
  const out = new Int16Array(float.length);
  for (let i = 0; i < float.length; i++) {
    const s = Math.max(-1, Math.min(1, float[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function rms(float: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < float.length; i++) sum += float[i] * float[i];
  return Math.min(1, Math.sqrt(sum / float.length) * 2);
}
