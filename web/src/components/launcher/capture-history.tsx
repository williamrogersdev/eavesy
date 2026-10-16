'use client';

import {
  Camera,
  ClipboardPaste,
  Copy,
  FileText,
  Image as ImageIcon,
  Mic,
  Pause,
  Play,
  Radio,
  Upload,
  Video,
} from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { captureMediaUrl, copyCaptureMedia, copyText } from '@/lib/desktop/bridge';
import type { Recording } from '@/lib/launcher/types';
import { cn } from '@/lib/utils';

export function plainTranscript(text: string): string {
  return text.replace(/^# [^\n]*\n+(?:## Transcript\n+)?/, '')
    .replace(/^\*\*\[\d{2}:\d{2}:\d{2}\] ([^\n]*?):\*\* /gm, '$1: ')
    .replace(/^\[\d{2}:\d{2}:\d{2}\] /gm, '').trim();
}

const KIND: Record<Recording['source'], { label: string; icon: ComponentType<{ className?: string }> }> = {
  mic: { label: 'Voice note', icon: Mic },
  dictation: { label: 'Voice note', icon: Mic },
  both: { label: 'Meeting', icon: Radio },
  system: { label: 'Meeting', icon: Radio },
  screen: { label: 'Video', icon: Video },
  screenshot: { label: 'Screenshot', icon: Camera },
  image: { label: 'Image', icon: ImageIcon },
  note: { label: 'Note', icon: FileText },
  upload: { label: 'Upload', icon: Upload },
};

function clock(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, '0')}`;
}

function relative(ms: number, now: number): string {
  const min = Math.round((now - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function useMediaUrl(id: string, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void captureMediaUrl(id)
      .then((value) => { if (!cancelled) setUrl(value); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [id, enabled]);
  return { url, error };
}

let nowPlaying: HTMLAudioElement | null = null;

function PlayButton({ id, durationSec }: { id: string; durationSec: number }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => () => { audio.current?.pause(); }, []);

  const toggle = async () => {
    try {
      if (!audio.current) {
        const el = new Audio(await captureMediaUrl(id));
        el.ontimeupdate = () => setPosition(el.currentTime);
        el.onplay = () => setPlaying(true);
        el.onpause = () => setPlaying(false);
        el.onended = () => { setPlaying(false); setPosition(0); };
        audio.current = el;
      }
      const el = audio.current;
      if (el.paused) {
        if (nowPlaying && nowPlaying !== el) nowPlaying.pause();
        nowPlaying = el;
        await el.play();
      } else {
        el.pause();
      }
    } catch {
      setFailed(true);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={failed}
      aria-label={playing ? 'Pause' : 'Play recording'}
      title={failed ? 'Audio unavailable' : playing ? 'Pause' : 'Play'}
      className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-[var(--lr-selected)] hover:text-foreground disabled:opacity-40"
    >
      {playing ? <Pause className="h-3.5 w-3.5" fill="currentColor" /> : <Play className="h-3.5 w-3.5" fill="currentColor" />}
      {(playing || position > 0) && (
        <span className="font-mono text-[10px] tabular-nums">{clock(position)} / {clock(durationSec)}</span>
      )}
    </button>
  );
}

function Visual({ id, video }: { id: string; video: boolean }) {
  const { url, error } = useMediaUrl(id, true);
  if (error) return <p className="text-xs text-muted-foreground">Preview unavailable. The file may have been moved.</p>;
  if (!url) return <div className="h-24 animate-pulse rounded-md bg-[var(--lr-hover)]" />;
  return video
    ? <video src={url} controls preload="metadata" className="max-h-48 w-full rounded-md bg-black" aria-label="Captured video" />
    : <img src={url} alt="Captured screenshot" className="max-h-40 max-w-full rounded-md object-contain" />;
}

function Text({ children, muted }: { children: string; muted?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = children.length > 280 || children.split('\n').length > 5;
  return (
    <div>
      <p
        className={cn(
          'whitespace-pre-wrap break-words text-[13px] leading-relaxed',
          muted ? 'text-muted-foreground' : 'text-foreground',
          long && !open && 'line-clamp-4',
        )}
      >
        {children}
      </p>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 text-[11px] text-muted-foreground hover:text-foreground">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function statusLine(rec: Recording, signedIn: boolean): string {
  if (rec.status === 'recording') return 'Recording…';
  if (!signedIn && rec.status !== 'complete') return 'Saved on this Mac. Sign in to get the transcript.';
  if (rec.status === 'processing') return 'Transcribing…';
  if (rec.status === 'complete') return 'No speech detected.';
  return 'Couldn’t transcribe this one. The audio is saved.';
}

function CaptureRow({ rec, now, signedIn, onSignIn, onCopied, onError }: {
  rec: Recording;
  now: number;
  signedIn: boolean;
  onSignIn: () => void;
  onCopied: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const kind = KIND[rec.source] ?? KIND.mic;
  const Icon = kind.icon;
  const text = plainTranscript(rec.transcript ?? '');
  const image = rec.source === 'screenshot' || rec.source === 'image';
  const video = !!rec.hasVideo;
  const playable = rec.hasAudio && !video && rec.status !== 'recording';
  const timed = rec.durationSec > 0 && !image && rec.source !== 'note';

  const copy = async () => {
    try {
      if (image || (video && !text)) {
        await copyCaptureMedia(rec.id);
        onCopied(image ? 'Image copied' : 'Video copied');
      } else {
        await copyText(text);
        onCopied(rec.source === 'note' ? 'Note copied' : 'Transcript copied');
      }
    } catch (error) {
      onError(error);
    }
  };

  // Text while the cloud is still working is the on-device first pass.
  const refining = signedIn && rec.status === 'processing' && (
    <p className="mt-1 text-[11px] text-muted-foreground">On-device transcript · refining in the cloud…</p>
  );
  let body: ReactNode;
  if (image) body = <Visual id={rec.id} video={false} />;
  else if (video) body = <>
    <Visual id={rec.id} video />
    {text && <div className="mt-2"><Text>{text}</Text>{refining}</div>}
  </>;
  else if (text) body = <><Text>{text}</Text>{refining}</>;
  else if (!signedIn && rec.status !== 'complete' && rec.status !== 'recording') body = (
    <p className="text-[13px] text-muted-foreground">
      Saved on this Mac.{' '}
      <button type="button" onClick={onSignIn} className="font-medium text-[var(--lr-brand)] hover:underline">Sign in</button>
      {' '}to get the transcript and summary.
    </p>
  );
  else body = <Text muted>{statusLine(rec, signedIn)}</Text>;

  return (
    <article className="border-b border-border px-1 py-2.5 last:border-b-0">
      <header className="mb-1.5 flex h-7 items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium text-foreground">{kind.label}</span>
        {timed && <span className="tabular-nums">· {clock(rec.durationSec)}</span>}
        <span>· {relative(rec.startedAt, now)}</span>
        <span className="ml-auto flex items-center">
          {playable && <PlayButton id={rec.id} durationSec={rec.durationSec} />}
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!image && !video && !text}
            aria-label={`Copy ${kind.label.toLowerCase()}`}
            title="Copy"
            className="grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--lr-selected)] hover:text-foreground disabled:opacity-30"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </span>
      </header>
      {body}
    </article>
  );
}

export function CaptureHistory({ recordings, signedIn, onSignIn, onPaste, onCopied, onError }: {
  recordings: Recording[];
  signedIn: boolean;
  onSignIn: () => void;
  onPaste: () => void;
  onCopied: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const sorted = [...recordings].sort((a, b) => b.startedAt - a.startedAt);

  return (
    <>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Capture history</h2>
        <button
          type="button"
          onClick={onPaste}
          title="Save what's on your clipboard (⌘V)"
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-[var(--lr-hover)] hover:text-foreground"
        >
          <ClipboardPaste className="h-3.5 w-3.5" /> Paste
          <kbd className="font-sans text-[10px] opacity-60">⌘V</kbd>
        </button>
      </div>
      {sorted.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          Record a voice note, take a screenshot, or press ⌘V to keep text or an image here.
        </p>
      ) : (
        <div className="flex flex-col">
          {sorted.map((rec) => (
            <CaptureRow key={rec.id} rec={rec} now={now} signedIn={signedIn} onSignIn={onSignIn} onCopied={onCopied} onError={onError} />
          ))}
        </div>
      )}
    </>
  );
}
