'use client';

import {
  Camera,
  Download,
  Loader2,
  Mic,
  Monitor,
  Square,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { useRouter } from '@/lib/next-compat/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserAudioCapture } from '@/lib/audio/browser-recorder';
import { SEGMENT_MS, SessionUpload } from '@/lib/audio/session-upload';
import {
  captureScreenshot,
  downloadBlob,
  VisualRecorder,
} from '@/lib/capture/visual-capture';
import { formatDuration } from '@/lib/utils';
import { isRecord, optionalString } from '@/lib/json';
import { refreshLibrary } from '@/lib/api/use-library';

type Phase = 'idle' | 'recording' | 'review' | 'saving';
type Mode = 'audio' | 'webcam' | 'screen';

interface Captured {
  kind: 'audio' | 'video' | 'image';
  mode: 'audio' | 'webcam' | 'screen' | 'screenshot';
  blob?: Blob;
  url?: string;
  durationMs: number;
  width?: number;
  height?: number;
  audioBlob?: Blob | null;
}

export function CaptureBar() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<Mode | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<Captured | null>(null);

  const audioRef = useRef<BrowserAudioCapture | null>(null);
  const sessionRef = useRef<SessionUpload | null>(null);
  const visualRef = useRef<VisualRecorder | null>(null);
  const startedAtRef = useRef(0);
  const tickRef = useRef<number | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  const stopTicking = useCallback(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopTicking();
    audioRef.current?.dispose();
    audioRef.current = null;
    void sessionRef.current?.discard();
    sessionRef.current = null;
    visualRef.current?.dispose();
    visualRef.current = null;
    setCaptured((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
    setMode(null);
    setElapsed(0);
    setPhase('idle');
  }, [stopTicking]);

  useEffect(() => () => reset(), [reset]);

  const startTimer = useCallback(() => {
    startedAtRef.current = Date.now();
    setElapsed(0);
    stopTicking();
    tickRef.current = window.setInterval(
      () => setElapsed(Date.now() - startedAtRef.current),
      200,
    );
  }, [stopTicking]);

  const startAudioOneShot = useCallback(async () => {
    const cap = new BrowserAudioCapture({
      captureSystemAudio: false,
      segmentMs: SEGMENT_MS,
      onSegment: (segment) => sessionRef.current?.addSegment(segment),
      onChunk: (chunk) => sessionRef.current?.addArchiveChunk(chunk),
    });
    audioRef.current = cap;
    await cap.requestPermissions();
    await cap.start();
    sessionRef.current = new SessionUpload(cap.mimeType);
    setMode('audio');
    setPhase('recording');
    startTimer();
  }, [startTimer]);

  const startAudio = useCallback(async () => {
    setError(null);
    try {
      await startAudioOneShot();
    } catch (err) {
      reset();
      setError(friendlyError(err, 'microphone'));
    }
  }, [startAudioOneShot, reset]);

  const startVisual = useCallback(
    async (m: 'webcam' | 'screen') => {
      setError(null);
      const rec = new VisualRecorder(m);
      visualRef.current = rec;
      try {
        await rec.start(() => {
          if (visualRef.current === rec) void stopRecording();
        });
        setMode(m);
        setPhase('recording');
        startTimer();
        requestAnimationFrame(() => {
          if (previewVideoRef.current && rec.stream) {
            previewVideoRef.current.srcObject = rec.stream;
            previewVideoRef.current.muted = true;
            void previewVideoRef.current.play().catch(() => {});
          }
        });
      } catch (err) {
        reset();
        setError(friendlyError(err, m === 'screen' ? 'screen' : 'camera'));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reset, startTimer],
  );

  const takeScreenshot = useCallback(async () => {
    setError(null);
    try {
      const { blob, width, height } = await captureScreenshot();
      setMode(null);
      setCaptured({
        kind: 'image',
        mode: 'screenshot',
        blob,
        url: URL.createObjectURL(blob),
        durationMs: 0,
        width,
        height,
      });
      setPhase('review');
    } catch (err) {
      setError(friendlyError(err, 'screen'));
    }
  }, []);

  const stopRecording = useCallback(async () => {
    stopTicking();
    const durationMs = Date.now() - startedAtRef.current;
    try {
      if (audioRef.current) {
        const blob = await audioRef.current.stop();
        audioRef.current.dispose();
        audioRef.current = null;
        setCaptured({ kind: 'audio', mode: 'audio', blob, url: URL.createObjectURL(blob), durationMs });
      } else if (visualRef.current) {
        const width = previewVideoRef.current?.videoWidth || undefined;
        const height = previewVideoRef.current?.videoHeight || undefined;
        const visualMode: 'webcam' | 'screen' = mode === 'webcam' ? 'webcam' : 'screen';
        const { video, audio } = await visualRef.current.stop();
        visualRef.current.dispose();
        visualRef.current = null;
        setCaptured({
          kind: 'video',
          mode: visualMode,
          blob: video,
          url: URL.createObjectURL(video),
          durationMs,
          width,
          height,
          audioBlob: audio,
        });
      } else {
        return;
      }
      setPhase('review');
    } catch (cause) {
      reset();
      setError(cause instanceof Error ? cause.message : 'Could not stop recording');
    }
  }, [stopTicking, mode, reset]);

  const save = useCallback(async () => {
    if (!captured) return;
    setPhase('saving');
    setError(null);

    try {
      if (captured.kind === 'audio') {
        const session = sessionRef.current;
        if (!session) throw new Error('nothing to save');
        await session.finish();
        const meetingId = session.meetingId;
        if (!meetingId) throw new Error('Server returned an invalid meeting');
        sessionRef.current = null;
        reset();
        await router.push(`/app/meetings/${meetingId}`);
        return;
      }

      if (!captured.blob) throw new Error('nothing to save');
      const ext = captured.kind === 'image' ? 'png' : 'webm';
      const fd = new FormData();
      fd.append('file', captured.blob, `capture.${ext}`);
      fd.append('kind', captured.kind);
      fd.append('captureMode', captured.mode);
      fd.append('contentType', captured.blob.type || (captured.kind === 'image' ? 'image/png' : 'video/webm'));
      fd.append('durationMs', String(captured.durationMs));
      if (captured.width) fd.append('width', String(captured.width));
      if (captured.height) fd.append('height', String(captured.height));
      if (captured.audioBlob) fd.append('audioFile', captured.audioBlob, 'audio.webm');
      const res = await fetch('/api/captures', { method: 'POST', body: fd });
      if (!res.ok) throw await errorFrom(res);
      const body: unknown = await res.json();
      const id = isRecord(body) ? optionalString(body.id) : undefined;
      if (!id) throw new Error('Server returned an invalid capture');
      refreshLibrary();
      reset();
      await router.push(`/app/captures/${id}`);
    } catch (err) {
      setPhase('review');
      setError(err instanceof Error ? err.message : 'save failed');
    }
  }, [captured, reset, router]);

  const download = useCallback(() => {
    if (!captured?.blob) return;
    const ext = captured.kind === 'image' ? 'png' : 'webm';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(captured.blob, `eavesy-${captured.kind}-${stamp}.${ext}`);
  }, [captured]);

  const recording = phase === 'recording';

  return (
    <div className="flex shrink-0 items-center">
      {!recording && phase === 'idle' ? (
        <div className="flex items-center gap-1">
          <CaptureButton icon={Mic} label="Mic" onClick={() => void startAudio()} />
          <CaptureButton icon={Video} label="Video" onClick={() => void startVisual('webcam')} />
          <CaptureButton icon={Camera} label="Screenshot" onClick={() => void takeScreenshot()} />
          <CaptureButton icon={Monitor} label="Screen" onClick={() => void startVisual('screen')} />
        </div>
      ) : null}

      {recording ? (
        <div className="flex h-9 items-center gap-2 rounded-full bg-danger pl-3 pr-1 text-white">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
          <span className="font-mono text-sm font-semibold tabular-nums">{formatDuration(elapsed)}</span>
          <span className="hidden sm:inline-flex"><Waveform /></span>
          <span className="hidden text-xs font-medium opacity-90 min-[440px]:inline">
            Recording {mode === 'audio' ? 'audio' : mode === 'webcam' ? 'video' : 'screen'}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void stopRecording()}
              className="flex h-7 items-center gap-1.5 rounded-full bg-white/20 px-3 text-xs font-medium text-white hover:bg-white/30"
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" />
              Stop
            </button>
            <button
              type="button"
              onClick={reset}
              className="flex h-7 w-7 items-center justify-center rounded-full text-white/80 hover:bg-white/20"
              aria-label="Cancel"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}

      {(recording && mode !== 'audio') ||
      phase === 'review' ||
      phase === 'saving' ? (
        <div className="absolute right-3 top-[calc(100%+0.5rem)] z-50 max-h-[min(72vh,640px)] w-[min(560px,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-border bg-background p-3 shadow-lg sm:right-4">
          <div>
            {phase !== 'recording' && captured ? (
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Review your {captured.kind === 'image' ? 'screenshot' : captured.kind}
              </p>
            ) : null}
            {recording && mode !== 'audio' ? (
              <video
                ref={previewVideoRef}
                className="max-h-64 w-full rounded-md border border-border bg-black object-contain"
                playsInline
              />
            ) : null}

            {phase !== 'recording' && captured ? (
              <div className="flex flex-col gap-3">
                {captured.kind === 'audio' && captured.url ? (
                  <audio controls src={captured.url} className="w-full" />
                ) : captured.kind === 'video' && captured.url ? (
                  <video controls src={captured.url} className="max-h-64 w-full rounded-md border border-border bg-black" />
                ) : captured.url ? (
                  <img src={captured.url} alt="Screenshot" className="max-h-64 w-full rounded-md border border-border object-contain" />
                ) : null}

                {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={phase === 'saving'}
                    className="flex h-8 items-center gap-1.5 rounded-md bg-action px-3 text-[13px] font-medium text-white hover:bg-action-hover disabled:opacity-60"
                  >
                    {phase === 'saving' ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                      </>
                    ) : captured.kind === 'audio' ? (
                      'Save & transcribe'
                    ) : (
                      'Save'
                    )}
                  </button>
                  {captured.kind !== 'audio' ? (
                    <button
                      type="button"
                      onClick={download}
                      disabled={phase === 'saving'}
                      className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] text-muted-foreground hover:bg-muted disabled:opacity-60"
                    >
                      <Download className="h-4 w-4" /> Download
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={reset}
                    disabled={phase === 'saving'}
                    className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] text-muted-foreground hover:bg-muted disabled:opacity-60"
                  >
                    <Trash2 className="h-4 w-4" /> Discard
                  </button>
                  <span className="w-full text-xs leading-relaxed text-muted-foreground sm:ml-auto sm:w-auto">
                    {captured.kind === 'audio'
                      ? 'Saves to your meetings with a transcript + summary after Stop.'
                      : 'Saves to your Captures library.'}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {error && phase === 'idle' ? (
        <p role="alert" className="absolute right-3 top-[calc(100%+0.5rem)] z-50 max-w-sm rounded-lg border border-border bg-background px-3 py-2 text-xs text-danger shadow-lg sm:right-4">{error}</p>
      ) : null}
    </div>
  );
}

function CaptureButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Mic;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      <Icon className="h-4 w-4" />
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

function Waveform() {
  return (
    <span className="flex items-end gap-0.5" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="w-0.5 animate-recording-pulse rounded-full bg-white/80"
          style={{ height: `${6 + ((i * 7) % 12)}px`, animationDelay: `${i * 120}ms` }}
        />
      ))}
    </span>
  );
}

async function errorFrom(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `upload failed (${res.status})`);
}

function friendlyError(err: unknown, device: string): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `Permission to use the ${device} was denied.`;
  }
  if (name === 'NotFoundError') return `No ${device} was found.`;
  if (name === 'AbortError') return '';
  return err instanceof Error ? err.message : `Could not access the ${device}.`;
}
