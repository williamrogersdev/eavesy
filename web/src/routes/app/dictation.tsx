import { Translator } from '@/components/translation/translator';
import { CorrectionEditor } from '@/components/dictionary/correction-editor';
import { createFileRoute } from '@tanstack/react-router';
import { Check, Clipboard, Loader2, Mic, MicOff, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BrowserAudioCapture } from '@/lib/audio/browser-recorder';
import { cn, formatDuration } from '@/lib/utils';
import { isRecord, optionalString } from '@/lib/json';
import { AppAlert, AppPage, AppPageHeader, appButton } from '@/components/ui/app-page';

type Phase = 'idle' | 'recording' | 'processing' | 'done';

export const Route = createFileRoute('/app/dictation')({
  component: DictationPage,
});

function DictationPage() {
  const [translating, setTranslating] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<{ id: string; transcript: string; cleaned?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const captureRef = useRef<BrowserAudioCapture | null>(null);
  const startedAtRef = useRef(0);
  const tickRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      captureRef.current?.dispose();
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
    };
  }, []);

  const start = async () => {
    setError(null);
    setResult(null);
    const cap = new BrowserAudioCapture();
    captureRef.current = cap;
    try {
      await cap.requestPermissions();
      cap.startPreflight();
      await cap.start();
      startedAtRef.current = Date.now();
      setElapsed(0);
      tickRef.current = window.setInterval(() => {
        setElapsed(Date.now() - startedAtRef.current);
      }, 100);
      setPhase('recording');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = async (cancel = false) => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    const cap = captureRef.current;
    if (!cap) return;
    try {
      const blob = await cap.stop();
      cap.dispose();
      captureRef.current = null;
      if (cancel) {
        setPhase('idle');
        return;
      }
      setPhase('processing');
      const form = new FormData();
      form.append('audio', new File([blob], 'dictation.webm', { type: blob.type || 'audio/webm' }));
      const res = await fetch('/api/dictations', { method: 'POST', body: form });
      if (!res.ok) throw new Error(`Dictation failed (${res.status})`);
      const json: unknown = await res.json();
      const transcript = isRecord(json) ? optionalString(json.transcript) : undefined;
      if (!transcript) throw new Error('Server returned an invalid transcript');
      const cleaned = isRecord(json) ? optionalString(json.cleaned) : undefined;
      const id = isRecord(json) ? optionalString(json.id) : undefined;
      if (!id) throw new Error("Missing dictation ID");
      setResult({ id, transcript, cleaned });
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase === 'recording') {
        e.preventDefault();
        void stop(true);
      }
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (phase === 'idle') void start();
        else if (phase === 'recording') void stop(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      window.setTimeout(() => setCopied((current) => current === text ? null : current), 1600);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not copy text');
    }
  };

  if (translating) return <div className="ev relative mx-auto flex min-h-[520px] max-w-2xl flex-col p-4"><Translator onBack={() => setTranslating(false)} initialText={result?.cleaned ?? result?.transcript ?? ''} /></div>;

  const panel = 'flex w-full items-center gap-3 rounded-[var(--ev-r-pop)] border border-ev-line p-4';
  return (
    <AppPage width="compact">
      <AppPageHeader
        title="Dictation"
        description="Speak a rough thought and get clean text to paste. ⌘/Ctrl ⇧ D starts and stops; Esc cancels."
      />

      <button type="button" className={appButton('secondary')} disabled={phase === 'recording' || phase === 'processing'} onClick={() => setTranslating(true)}>Translate · speak or paste in another language</button>

      {error ? <AppAlert>{error}</AppAlert> : null}

      {phase === 'idle' && (
        <div className={panel}>
          <button
            type="button"
            onClick={() => void start()}
            aria-label="Start dictation"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-action text-ev-on-coat transition hover:bg-action-hover active:scale-95"
          >
            <Mic className="h-5 w-5" />
          </button>
          <div>
            <p className="text-sm font-medium">Start dictation</p>
            <p className="text-xs text-ev-ink-2">Your browser will ask to use the microphone.</p>
          </div>
        </div>
      )}

      {phase === 'recording' && (
        <div className={panel}>
          <span className="h-2.5 w-2.5 shrink-0 animate-recording-pulse rounded-full bg-danger" />
          <span className="font-round text-sm tabular-nums">{formatDuration(elapsed)}</span>
          <span className="text-xs text-ev-ink-2">Listening</span>
          <span className="ml-auto flex gap-2">
            <button type="button" onClick={() => void stop(true)} className={appButton('ghost', 'sm')}>
              Cancel
            </button>
            <button type="button" onClick={() => void stop(false)} className={appButton('danger', 'sm')}>
              <MicOff className="h-3.5 w-3.5" /> Stop
            </button>
          </span>
        </div>
      )}

      {phase === 'processing' && (
        <div role="status" className={panel}>
          <Loader2 className="h-4 w-4 animate-spin text-ev-ink-2" />
          <span className="text-sm text-ev-ink-2">Transcribing and cleaning up…</span>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="flex flex-col gap-3">
          {result.cleaned && result.cleaned !== result.transcript && (
            <Section title="Cleaned up" text={result.cleaned} primary copied={copied === result.cleaned} onCopy={() => void copy(result.cleaned!)} />
          )}
          <CorrectionEditor id={result.id} original={result.cleaned ?? result.transcript} onSaved={cleaned => setResult({ ...result, cleaned })} />
          <Section title="As spoken" text={result.transcript} copied={copied === result.transcript} onCopy={() => void copy(result.transcript)} />
          <button
            type="button"
            onClick={() => {
              setResult(null);
              setPhase('idle');
            }}
            className={cn(appButton('secondary', 'sm'), 'self-start')}
          >
            <RotateCcw className="h-3.5 w-3.5" /> New dictation
          </button>
        </div>
      )}
    </AppPage>
  );
}

function Section({
  title,
  text,
  primary,
  copied,
  onCopy,
}: {
  title: string;
  text: string;
  primary?: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <section className={cn('rounded-[var(--ev-r-pop)] border p-3', primary ? 'border-ev-coat bg-ev-coat-soft' : 'border-ev-line')}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-ev-ink-2">
          {primary ? <Sparkles className="h-3.5 w-3.5" /> : null}
          {title}
        </span>
        <button type="button" onClick={onCopy} className={appButton('ghost', 'sm')}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
    </section>
  );
}
