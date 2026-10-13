export type VisualCaptureMode = 'webcam' | 'screen';

export interface CapturedImage {
  blob: Blob;
  width: number;
  height: number;
}

export async function captureScreenshot(): Promise<CapturedImage> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(video, 0, 0, width, height);
    video.pause();

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('screenshot encoding failed'))),
        'image/png',
      );
    });
    return { blob, width, height };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

export interface VisualResult {
  video: Blob;
  audio: Blob | null;
}

export class VisualRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private audioRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  stream: MediaStream | null = null;

  constructor(private readonly mode: VisualCaptureMode) {}

  async start(onAutoStop?: () => void): Promise<void> {
    this.stream =
      this.mode === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        : await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

    const videoTrack = this.stream.getVideoTracks()[0];
    videoTrack?.addEventListener('ended', () => {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop();
      }
      onAutoStop?.();
    });

    const mimeType = pickVideoMimeType();
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    const audioTracks = this.stream.getAudioTracks();
    if (audioTracks.length > 0) {
      const audioMime = pickAudioMimeType();
      this.audioChunks = [];
      this.audioRecorder = new MediaRecorder(
        new MediaStream(audioTracks),
        audioMime ? { mimeType: audioMime } : undefined,
      );
      this.audioRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };
    }

    await new Promise<void>((resolve) => {
      this.recorder!.onstart = () => resolve();
      this.recorder!.start();
      this.audioRecorder?.start();
    });
  }

  async stop(): Promise<VisualResult> {
    const video = await this.stopRecorder(this.recorder, this.chunks, this.mimeType());
    const audio =
      this.audioRecorder && this.audioChunks.length >= 0
        ? await this.stopRecorder(this.audioRecorder, this.audioChunks, this.audioMimeType())
        : null;
    return { video, audio: audio && audio.size > 0 ? audio : null };
  }

  private stopRecorder(rec: MediaRecorder | null, chunks: Blob[], type: string): Promise<Blob> {
    return new Promise((resolve) => {
      if (!rec || rec.state === 'inactive') {
        resolve(new Blob(chunks, { type }));
        return;
      }
      rec.onstop = () => resolve(new Blob(chunks, { type }));
      rec.stop();
    });
  }

  dispose(): void {
    for (const rec of [this.recorder, this.audioRecorder]) {
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          /* already stopping */
        }
      }
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.audioRecorder = null;
  }

  private mimeType(): string {
    return this.recorder?.mimeType || pickVideoMimeType() || 'video/webm';
  }

  private audioMimeType(): string {
    return this.audioRecorder?.mimeType || pickAudioMimeType() || 'audio/webm';
  }
}

function pickAudioMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return undefined;
}

function pickVideoMimeType(): string | undefined {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return undefined;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
