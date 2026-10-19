'use client';

import { ArrowLeftRight, Check, Clipboard, Languages, Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMe } from '@/lib/api/use-me';
import { isNotesLanguage, languageName } from '@/lib/transcription/language';
import { hasBothSides, parseSpeakerNames, speakerName } from '@/lib/transcription/two-track';
import { cn } from '@/lib/utils';

export interface TranscriptLine {
  id: string;
  startMs: number;
  endMs: number;
  speakerId?: string | null;
  text: string;
  confidence?: number | null;
  language?: string | null;
  isEdited?: boolean;
  isFinal?: boolean;
}

export interface Chapter {
  startMs: number;
  title: string;
}

export function TranscriptPlayer({
  meetingId,
  audioUrl,
  lines,
  chapters,
  speakerNamesJson,
  onChanged,
}: {
  meetingId: string;
  audioUrl: string | null;
  lines: TranscriptLine[];
  chapters: Chapter[];
  speakerNamesJson: string | null;
  onChanged: () => void;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [nowMs, setNowMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [followPlayback, setFollowPlayback] = useState(true);

  const [pending, setPending] = useState<Record<string, Partial<TranscriptLine> | 'deleted'>>({});
  const [undo, setUndo] = useState<TranscriptLine | null>(null);
  useEffect(() => setPending({}), [lines]);

  const shown = useMemo(
    () =>
      lines.flatMap((line) => {
        const change = pending[line.id];
        if (change === 'deleted') return [];
        return [{ ...line, ...change }];
      }),
    [lines, pending],
  );
  const { data: me } = useMe();
  const target = me?.notesLanguage ?? browserLanguage();
  const translation = useTranslation(meetingId, shown, target, Boolean(me?.notesLanguage));
  const translated = (line: TranscriptLine) => (translation.showing ? translation.textFor(line) : undefined);

  const labelled = hasBothSides(shown.map((line) => ({ speakerId: line.speakerId ?? null })));
  const names = parseSpeakerNames(speakerNamesJson);
  const nameOf = (id: string | null | undefined) => (labelled && id ? speakerName(id, names) : null);

  const activeId = useMemo(() => {
    if (!playing && nowMs === 0) return null;
    let current: string | null = null;
    for (const line of shown) {
      if (line.startMs <= nowMs) current = line.id;
      else break;
    }
    return current;
  }, [shown, nowMs, playing]);
  const activeChapter = useMemo(() => {
    let current: number | null = null;
    chapters.forEach((chapter, i) => {
      if (chapter.startMs <= nowMs) current = i;
    });
    return current;
  }, [chapters, nowMs]);

  const seek = useCallback((ms: number, play = true) => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = ms / 1_000;
    setNowMs(ms);
    setFollowPlayback(true);
    if (play) void el.play();
  }, []);

  const mutate = useCallback(
    async (id: string, init: RequestInit, optimistic: Partial<TranscriptLine> | 'deleted') => {
      setPending((p) => ({ ...p, [id]: optimistic }));
      const res = await fetch(`/api/meetings/${meetingId}/lines/${encodeURIComponent(id)}`, {
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      if (!res.ok) {
        setPending((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
        return null;
      }
      onChanged();
      return res.json().catch(() => null);
    },
    [meetingId, onChanged],
  );

  const remove = async (line: TranscriptLine) => {
    const result = await mutate(line.id, { method: 'DELETE' }, 'deleted');
    if (result) setUndo(line);
  };
  const restore = async () => {
    if (!undo) return;
    const line = undo;
    setUndo(null);
    setPending((p) => {
      const next = { ...p };
      delete next[line.id];
      return next;
    });
    await fetch(`/api/meetings/${meetingId}/lines/${encodeURIComponent(line.id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        startMs: line.startMs,
        endMs: line.endMs,
        speakerId: line.speakerId ?? null,
        text: line.text,
        confidence: line.confidence ?? null,
        language: line.language ?? null,
        isEdited: line.isEdited ?? false,
      }),
    });
    onChanged();
  };
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  const headingsBefore = (i: number) =>
    chapters.filter(
      (chapter) =>
        chapter.startMs <= shown[i].startMs && (i === 0 || chapter.startMs > shown[i - 1].startMs),
    );
  const copyText = shown
    .map((line) => {
      const who = nameOf(line.speakerId);
      return `[${clockLabel(line.startMs)}] ${who ? `${who}: ` : ''}${translated(line) ?? line.text}`;
    })
    .join('\n');

  if (shown.length === 0 && !audioUrl) return null;

  return (
    <section className="flex flex-col gap-4">
      {audioUrl ? (
        <div className="sticky top-0 z-10 -mx-2 rounded-lg border border-border bg-background/95 px-3 py-2.5 backdrop-blur">
          <audio
            ref={audio}
            src={audioUrl}
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => setNowMs(e.currentTarget.currentTime * 1_000)}
            onLoadedMetadata={(e) => {
              const seconds = e.currentTarget.duration;
              if (Number.isFinite(seconds)) setDurationMs(seconds * 1_000);
            }}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => (playing ? audio.current?.pause() : void audio.current?.play())}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white transition hover:bg-accent-hover"
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
            </button>
            <span className="w-24 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {clockLabel(nowMs)} / {durationMs ? clockLabel(durationMs) : '--:--'}
            </span>
            <div className="relative flex-1">
              <input
                type="range"
                min={0}
                max={Math.max(durationMs, 1)}
                step={250}
                value={Math.min(nowMs, durationMs || nowMs)}
                onChange={(e) => seek(Number(e.target.value), playing)}
                className="w-full accent-[var(--color-accent,currentColor)]"
                aria-label="Seek"
              />
              {durationMs
                ? chapters.map((chapter) => (
                    <span
                      key={chapter.startMs}
                      title={chapter.title}
                      className="pointer-events-none absolute top-0 h-1.5 w-0.5 -translate-x-1/2 rounded bg-muted-foreground/60"
                      style={{ left: `${(chapter.startMs / durationMs) * 100}%` }}
                    />
                  ))
                : null}
            </div>
          </div>
        </div>
      ) : null}

      {chapters.length || labelled ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {chapters.length ? (
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Chapters
              </h3>
              <ol className="space-y-0.5">
                {chapters.map((chapter, i) => (
                  <li key={chapter.startMs}>
                    <button
                      type="button"
                      onClick={() => seek(chapter.startMs)}
                      className={cn(
                        'flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left text-sm hover:bg-muted',
                        activeChapter === i && 'bg-muted font-medium',
                      )}
                    >
                      <span className="w-12 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                        {clockLabel(chapter.startMs)}
                      </span>
                      {chapter.title}
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {labelled ? (
            <SpeakerNames meetingId={meetingId} names={names} onSaved={onChanged} />
          ) : null}
        </div>
      ) : null}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transcript</h2>
          <div className="flex items-center gap-3">
            {translation.spoken.length > 0 ? (
              <span className="text-xs text-muted-foreground" title="Languages heard in this meeting">
                {translation.spoken.map(languageName).join(' · ')}
              </span>
            ) : null}
            {translation.available ? (
              <button
                type="button"
                onClick={translation.toggle}
                disabled={translation.loading}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground disabled:opacity-60"
              >
                <Languages className="h-3.5 w-3.5" />
                {translation.loading
                  ? 'Translating…'
                  : translation.showing
                    ? 'Show original'
                    : `Translate to ${languageName(target)}`}
              </button>
            ) : null}
            <CopyText text={copyText} />
          </div>
        </div>
        <div
          className="max-h-[32rem] overflow-y-auto rounded-md border border-border bg-muted/20 p-2 text-sm leading-relaxed"
          onWheel={() => setFollowPlayback(false)}
        >
          {translation.error ? (
            <p className="px-2 pb-1 text-xs text-destructive">{translation.error}</p>
          ) : null}
          {shown.map((line, i) => {
            const who = nameOf(line.speakerId);
            const sameSpeaker = i > 0 && nameOf(shown[i - 1].speakerId) === who;
            const headings = headingsBefore(i);
            const heading = headings.length ? headings[headings.length - 1].title : null;
            return (
              <div key={line.id}>
                {heading ? (
                  <h3 className="mb-1 mt-3 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground first:mt-1">
                    {heading}
                  </h3>
                ) : null}
                <Line
                  line={line}
                  translation={translated(line)}
                  who={who && !(sameSpeaker && !heading) ? who : null}
                  active={line.id === activeId}
                  follow={followPlayback && playing}
                  canSwitch={labelled}
                  onPlay={() => { void seek(line.startMs); }}
                  onSave={(text) => {
                    void mutate(line.id, { method: 'PATCH', body: JSON.stringify({ text }) }, { text, isEdited: true });
                  }}
                  onSwitch={() => {
                    const speakerId = line.speakerId === 'you' ? 'them' : 'you';
                    void mutate(
                      line.id,
                      { method: 'PATCH', body: JSON.stringify({ speakerId }) },
                      { speakerId, isEdited: true },
                    );
                  }}
                  onDelete={() => void remove(line)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {undo ? (
        <div className="fixed bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-background px-4 py-2 text-sm shadow-lg">
          Line deleted.
          <button type="button" onClick={() => void restore()} className="font-medium text-accent hover:underline">
            Undo
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Line({
  line,
  translation,
  who,
  active,
  follow,
  canSwitch,
  onPlay,
  onSave,
  onSwitch,
  onDelete,
}: {
  line: TranscriptLine;
  translation?: string;
  who: string | null;
  active: boolean;
  follow: boolean;
  canSwitch: boolean;
  onPlay: () => void;
  onSave: (text: string) => void;
  onSwitch: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    if (active && follow) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active, follow]);

  const commit = () => {
    const text = (draft ?? '').trim();
    setDraft(null);
    if (text && text !== line.text) onSave(text);
  };

  return (
    <div
      ref={ref}
      className={cn(
        'group relative grid grid-cols-[3.5rem_1fr] gap-x-3 rounded px-2 py-1',
        active ? 'bg-accent/10' : 'hover:bg-muted/60',
      )}
    >
      <button
        type="button"
        onClick={onPlay}
        className="self-start pt-0.5 text-left font-mono text-xs tabular-nums text-muted-foreground hover:text-accent"
        title="Play from here"
      >
        {clockLabel(line.startMs)}
      </button>
      <div className="min-w-0 pr-20">
        {who ? <div className="text-xs font-semibold text-foreground">{who}</div> : null}
        {draft !== null ? (
          <textarea
            autoFocus
            value={draft}
            rows={Math.max(2, Math.ceil(draft.length / 80))}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commit();
              }
              if (e.key === 'Escape') setDraft(null);
            }}
            className="w-full resize-none rounded border border-accent/50 bg-background px-2 py-1 outline-none"
          />
        ) : (
          <div onClick={onPlay} className="cursor-pointer">
            <p>{translation ?? line.text}</p>
            {translation ? (
              <p className="text-xs text-muted-foreground" lang={line.language ?? undefined}>
                {line.text}
              </p>
            ) : null}
          </div>
        )}
      </div>
      {draft === null ? (
        <div className="absolute right-1 top-1 hidden items-center gap-0.5 rounded-md border border-border bg-background p-0.5 group-hover:flex">
          <IconButton label="Edit line" onClick={() => setDraft(line.text)}>
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          {canSwitch ? (
            <IconButton label="Give to the other speaker" onClick={onSwitch}>
              <ArrowLeftRight className="h-3.5 w-3.5" />
            </IconButton>
          ) : null}
          <IconButton label="Delete line" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      ) : null}
    </div>
  );
}

function SpeakerNames({
  meetingId,
  names,
  onSaved,
}: {
  meetingId: string;
  names: Record<string, string>;
  onSaved: () => void;
}) {
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Speakers</h3>
      <div className="space-y-1.5">
        {(['you', 'them'] as const).map((id) => (
          <SpeakerName key={id} meetingId={meetingId} id={id} name={speakerName(id, names)} onSaved={onSaved} />
        ))}
      </div>
    </div>
  );
}

function SpeakerName({
  meetingId,
  id,
  name,
  onSaved,
}: {
  meetingId: string;
  id: 'you' | 'them';
  name: string;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = async () => {
    const next = (draft ?? '').trim();
    setDraft(null);
    if (next === name) return;
    await fetch(`/api/meetings/${meetingId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ speakerNames: { [id]: next } }),
    });
    onSaved();
  };
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-12 shrink-0 text-xs text-muted-foreground">{id === 'you' ? 'Mic' : 'Call'}</span>
      <input
        value={draft ?? name}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setDraft(name)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(null);
        }}
        maxLength={60}
        className="flex-1 rounded-md border border-border bg-background px-2 py-1 outline-none focus:border-accent/50"
        aria-label={id === 'you' ? 'Name for the microphone speaker' : 'Name for the call speaker'}
      />
    </label>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => { void (async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      })(); }}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <Clipboard className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy transcript'}
    </button>
  );
}

function browserLanguage(): string {
  if (typeof navigator === 'undefined') return 'en';
  const code = navigator.language.split('-')[0]?.toLowerCase() ?? '';
  return isNotesLanguage(code) ? code : 'en';
}

/** The languages heard in these lines, most spoken first. */
function spokenLanguages(lines: readonly TranscriptLine[]): string[] {
  const weight = new Map<string, number>();
  for (const line of lines) {
    if (line.language) weight.set(line.language, (weight.get(line.language) ?? 0) + line.text.length);
  }
  return [...weight].sort((a, b) => b[1] - a[1]).map(([language]) => language);
}

/**
 * Translations of the lines heard in another language than `target`. Each one
 * is kept with the text it was made from, so an edited line is translated again.
 */
function useTranslation(meetingId: string, lines: readonly TranscriptLine[], target: string, auto: boolean) {
  const [showing, setShowing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, { source: string; text: string }>>({});
  const inFlight = useRef(false);
  const autoStarted = useRef(false);
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    setDone({});
    setShowing(false);
    autoStarted.current = false;
    attempted.current = new Set();
  }, [meetingId, target]);

  const spoken = useMemo(() => spokenLanguages(lines), [lines]);
  const foreign = useMemo(
    () => lines.filter((line) => line.language && line.language !== target),
    [lines, target],
  );
  const missing = foreign.filter((line) => done[line.id]?.source !== line.text);
  const untried = missing.filter((line) => !attempted.current.has(`${line.id}\n${line.text}`)).length;

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    const sources = new Map(lines.map((line) => [line.id, line.text]));
    for (const line of lines) attempted.current.add(`${line.id}\n${line.text}`);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: target }),
      });
      if (!res.ok) throw new Error(res.status === 429 ? 'Translation limit reached for today.' : 'Could not translate.');
      const body: unknown = await res.json();
      const translatedLines =
        typeof body === 'object' && body !== null && 'lines' in body && typeof body.lines === 'object' && body.lines
          ? Object.entries(body.lines)
          : [];
      setDone((previous) => {
        const next = { ...previous };
        for (const [id, text] of translatedLines) {
          const source = sources.get(id);
          if (source !== undefined && typeof text === 'string') next[id] = { source, text };
        }
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not translate.');
      setShowing(false);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [lines, meetingId, target]);

  useEffect(() => {
    if (!auto || autoStarted.current || foreign.length === 0) return;
    autoStarted.current = true;
    setShowing(true);
    void load();
  }, [auto, foreign.length, load]);

  useEffect(() => {
    if (!showing || untried === 0 || inFlight.current || error) return;
    const timer = window.setTimeout(() => void load(), 2_000);
    return () => window.clearTimeout(timer);
  }, [showing, untried, load, error]);

  return {
    spoken,
    available: foreign.length > 0,
    showing,
    loading,
    error,
    toggle: () => {
      if (showing) {
        setShowing(false);
        return;
      }
      setShowing(true);
      setError(null);
      if (missing.length > 0) void load();
    },
    textFor: (line: TranscriptLine) => {
      const entry = done[line.id];
      return entry && entry.source === line.text && entry.text !== line.text ? entry.text : undefined;
    },
  };
}

export function clockLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}
