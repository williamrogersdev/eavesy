'use client';

import { Download, Loader2, Mic, Pause, Play, RotateCw, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BrowserAudioCapture,
  type AudioCaptureState,
} from '@/lib/audio/browser-recorder';
import { SEGMENT_MS, SessionUpload } from '@/lib/audio/session-upload';
import { AppAlert, appButton } from '@/components/ui/app-page';
import { cn, formatDuration } from '@/lib/utils';

export interface RecorderProps {
  onSaved?: (meetingId: string) => void | Promise<void>;
  captureSystemAudio?: boolean;
}

export function Recorder({ onSaved, captureSystemAudio: defaultCaptureSystemAudio = false }: RecorderProps) {
  const captureRef = useRef<BrowserAudioCapture | null>(null);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);

  const [state, setState] = useState<AudioCaptureState>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [systemLevel, setSystemLevel] = useState(0);
  const [captureSystemAudio, setCaptureSystemAudio] = useState(defaultCaptureSystemAudio);
  const [starting, setStarting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const uploadRef = useRef<SessionUpload | null>(null);
  const [unsaved, setUnsaved] = useState<Blob | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const busy = state === 'recording' || state === 'paused' || finishing || !!unsaved;
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  useEffect(() => {
    return () => {
      captureRef.current?.dispose();
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
    };
  }, []);

  const tickElapsed = useCallback(() => {
    if (tickRef.current !== null) return;
    tickRef.current = window.setInterval(() => {
      setElapsed(Date.now() - startedAtRef.current);
    }, 100);
  }, []);

  const stopTicking = useCallback(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const handleStart = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    // The upload exists before recording starts so the first chunk, which can
    // arrive before start() resolves, is never dropped.
    const upload = new SessionUpload(null);
    const capture = new BrowserAudioCapture({
      captureSystemAudio,
      segmentMs: SEGMENT_MS,
      onSegment: (segment) => upload.addSegment(segment),
      onChunk: (chunk) => upload.addArchiveChunk(chunk),
      onLevel: (mic, sys) => {
        setMicLevel(mic);
        setSystemLevel(sys);
      },
      onStateChange: (next, err) => {
        setState(next);
        if (err) setError(err);
      },
    });
    captureRef.current = capture;
    try {
      await capture.requestPermissions();
      capture.startPreflight();
      await new Promise((r) => setTimeout(r, 800));
      await capture.start();
      upload.begin(capture.mimeType);
      uploadRef.current = upload;
      startedAtRef.current = Date.now();
      setElapsed(0);
      tickElapsed();
    } catch (err) {
      capture.dispose();
      captureRef.current = null;
      void upload.discard();
      setError(err instanceof Error ? err : new Error('Could not start recording'));
    } finally {
      setStarting(false);
    }
  };

  const handlePause = () => captureRef.current?.pause();
  const handleResume = () => captureRef.current?.resume();

  const upload = async () => {
    const session = uploadRef.current;
    if (!session) return;
    setFinishing(true);
    setUploadError(null);
    try {
      await session.finish();
      uploadRef.current = null;
      setUnsaved(null);
      if (session.meetingId) await onSaved?.(session.meetingId);
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : 'Upload failed');
    } finally {
      setFinishing(false);
    }
  };

  const handleStop = async () => {
    const cap = captureRef.current;
    if (!cap) return;
    stopTicking();
    setFinishing(true);
    try {
      setUnsaved(await cap.stop());
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Could not stop recording'));
    } finally {
      cap.dispose();
      captureRef.current = null;
    }
    await upload();
  };

  const download = () => {
    if (!unsaved) return;
    const ext = unsaved.type.includes('mp4') ? 'm4a' : unsaved.type.includes('ogg') ? 'ogg' : 'webm';
    const url = URL.createObjectURL(unsaved);
    const link = document.createElement('a');
    link.href = url;
    link.download = `eavesy-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const isLive = state === 'recording' || state === 'paused';
  const panel = 'flex w-full flex-col gap-3 rounded-lg border border-border p-4';

  if (!isLive && uploadError && unsaved && !finishing) {
    return (
      <div role="alert" className={panel}>
        <div>
          <p className="text-sm font-medium">Your recording hasn’t finished uploading</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            It’s safe on this page. Check your connection and try again, or download a copy. ({uploadError})
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void upload()} className={appButton('primary', 'sm')}>
            <RotateCw className="h-3.5 w-3.5" /> Try again
          </button>
          <button type="button" onClick={download} className={appButton('secondary', 'sm')}>
            <Download className="h-3.5 w-3.5" /> Download
          </button>
        </div>
      </div>
    );
  }

  if (!isLive && finishing) {
    return (
      <div role="status" className={cn(panel, 'flex-row items-center')}>
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">Finishing your upload…</p>
          <p className="text-xs text-muted-foreground">Keep this page open for a moment.</p>
        </div>
      </div>
    );
  }

  if (!isLive) {
    return (
      <div className={panel}>
        {error ? <AppAlert>Recording is unavailable. {error.message}</AppAlert> : null}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleStart()}
            disabled={starting}
            aria-label={starting ? 'Requesting recording permission' : 'Start recording'}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-danger text-white transition hover:brightness-110 active:scale-95 disabled:cursor-wait disabled:opacity-60"
          >
            {starting ? <Loader2 className="h-5 w-5 animate-spin" /> : <Mic className="h-5 w-5" />}
          </button>
          <div className="min-w-0">
            <p className="text-sm font-medium">{starting ? 'Starting…' : 'Start recording'}</p>
            <p className="text-xs text-muted-foreground">Your browser will ask to use the microphone.</p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground select-none">
          <input
            type="checkbox"
            checked={captureSystemAudio}
            onChange={(e) => setCaptureSystemAudio(e.target.checked)}
            disabled={starting}
            className="h-3.5 w-3.5 rounded border-border accent-[var(--accent)]"
          />
          Also record audio from a shared tab or screen
        </label>
      </div>
    );
  }

  return (
    <div className={cn(panel, 'sticky top-2 z-40 flex-row items-center bg-background')}>
      <span
        className={cn('h-2.5 w-2.5 shrink-0 rounded-full bg-danger', state === 'recording' ? 'animate-recording-pulse' : 'opacity-40')}
      />
      <span className="font-mono text-sm tabular-nums">{formatDuration(elapsed)}</span>
      <span className="text-xs text-muted-foreground">{state === 'paused' ? 'Paused' : 'Recording'}</span>
      <span className="hidden items-center gap-3 sm:flex">
        <LevelMeter label="mic" level={micLevel} />
        {captureSystemAudio ? <LevelMeter label="tab" level={systemLevel} /> : null}
      </span>
      <span className="ml-auto flex gap-2">
        <button
          type="button"
          onClick={state === 'recording' ? handlePause : handleResume}
          aria-label={state === 'recording' ? 'Pause' : 'Resume'}
          className={appButton('secondary', 'sm')}
        >
          {state === 'recording' ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button type="button" onClick={() => void handleStop()} className={appButton('danger', 'sm')}>
          <Square className="h-3 w-3" fill="currentColor" /> Stop
        </button>
      </span>
    </div>
  );
}

function LevelMeter({ label, level }: { label: string; level: number }) {
  return (
    <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
      {label}
      <span className="flex h-1.5 w-14 overflow-hidden rounded-full bg-muted">
        <span className="h-full bg-foreground/60 transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
      </span>
    </span>
  );
}
