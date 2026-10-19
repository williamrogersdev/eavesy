'use client';

import { Loader2, Square } from 'lucide-react';

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function StartingView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Starting capture…</p>
      <p className="max-w-xs text-center text-xs text-muted-foreground/70">
        If macOS asks for microphone or screen recording access, allow it and
        this will continue.
      </p>
    </div>
  );
}

export function RecordingView({
  mode,
  elapsed,
  onStop,
}: {
  mode: 'audio' | 'screen';
  elapsed: number;
  onStop: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-7 p-8">
      <div className="flex items-center gap-2.5">
        <span
          className="h-3 w-3 animate-recording-pulse rounded-full"
          style={{ background: '#ef4444' }}
        />
        <span className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
          Recording {mode === 'screen' ? 'screen + audio' : 'audio'}
        </span>
      </div>
      <div className="font-round text-6xl font-medium tabular-nums text-foreground">
        {mmss(elapsed)}
      </div>
      <button
        type="button"
        onClick={onStop}
        className="flex items-center gap-2 rounded-lg px-6 py-3 text-[14px] font-medium text-white"
        style={{ background: '#ef4444' }}
      >
        <Square className="h-4 w-4" fill="currentColor" /> Stop &amp; save
      </button>
      <p className="text-[12px] text-muted-foreground">
        Saving to ~/Eavesy/Recordings
      </p>
    </div>
  );
}
