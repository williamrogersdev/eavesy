'use client';

import { ArrowLeftRight, Check, Clipboard, Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LanguagePicker } from '@/components/translation/language-picker';
import { isLanguage, type Language } from '@/lib/translation/languages';
import { useMe } from '@/lib/api/use-me';
import { languageName } from '@/lib/transcription/language';
import { hasBothSides, parseSpeakerNames, partialAttributionMs, speakerName } from '@/lib/transcription/two-track';
import { cn } from '@/lib/utils';
import { mergeTranslations, requestTranslations, spokenLanguages, translationFor, type Translations } from './transcript-translation';

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
  agentTranscript,
  onChanged,
}: {
  meetingId: string;
  audioUrl: string | null;
  lines: TranscriptLine[];
  chapters: Chapter[];
  speakerNamesJson: string | null;
  agentTranscript?: string | null;
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
  const [chosenLanguage, setChosenLanguage] = useState<Language | null | undefined>(undefined);
  const [translationRevision, setTranslationRevision] = useState(0);
  const target = chosenLanguage === undefined ? (isLanguage(me?.notesLanguage) ? me.notesLanguage : null) : chosenLanguage;
  const translation = useTranslation(meetingId, shown, target, translationRevision);
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
    <section className="flex flex-col gap-4 rounded-[var(--ev-r-panel)] bg-ev-raised p-4 shadow-[0_0_0_1px_var(--ev-line),var(--ev-e-2)] sm:p-5">
      {audioUrl ? (
        <div className="sticky top-2 z-10 rounded-full bg-ev-well/95 py-1.5 pl-1.5 pr-4 backdrop-blur">
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
              const requested = Number(new URLSearchParams(window.location.search).get('t'));
              if (Number.isFinite(requested) && requested > 0 && Number.isFinite(seconds)) {
                const start = Math.min(requested, seconds);
                e.currentTarget.currentTime = start;
                setNowMs(start * 1000);
              }
            }}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => (playing ? audio.current?.pause() : void audio.current?.play())}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ev-coat text-ev-on-coat shadow-[var(--ev-e-2)] transition hover:bg-ev-coat-hover active:scale-95"
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
            </button>
            <span className="w-24 shrink-0 font-round text-xs font-semibold tabular-nums text-ev-ink-2">
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
                className="w-full accent-[var(--ev-coat)]"
                aria-label="Seek"
              />
              {durationMs
                ? chapters.map((chapter) => (
                    <span
                      key={chapter.startMs}
                      title={chapter.title}
                      className="pointer-events-none absolute top-0 h-1.5 w-0.5 -translate-x-1/2 rounded bg-ev-ink-3"
                      style={{ left: `${(chapter.startMs / durationMs) * 100}%` }}
                    />
                  ))
                : null}
            </div>
          </div>
        </div>
      ) : null}

      {chapters.length || labelled ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {chapters.length ? (
            <div>
              <h3 className="mb-1.5 font-round text-[13px] font-bold text-ev-ink-2">Chapters</h3>
              <ol className="space-y-0.5">
                {chapters.map((chapter, i) => (
                  <li key={chapter.startMs}>
                    <button
                      type="button"
                      onClick={() => seek(chapter.startMs)}
                      className={cn(
                        'flex w-full items-baseline gap-2 rounded-[var(--ev-r-ctl)] px-2 py-1 text-left text-sm text-ev-ink hover:bg-[var(--ev-hover)]',
                        activeChapter === i && 'bg-ev-coat-soft font-semibold text-ev-coat',
                      )}
                    >
                      <span className="w-12 shrink-0 font-round text-xs tabular-nums text-ev-ink-3">
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
            <SpeakerNames meetingId={meetingId} names={names} partialMs={partialAttributionMs(names)} onSaved={onChanged} />
          ) : null}
        </div>
      ) : null}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-round text-[15px] font-extrabold text-ev-ink">Transcript</h2>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {translation.spoken.length > 0 ? (
              <span className="font-round text-xs font-semibold text-ev-ink-3" title="Languages heard in this meeting">
                {translation.spoken.map(languageName).join(' · ')}
              </span>
            ) : null}
            {!target && agentTranscript?.trim() ? (
              <>
                <CopyText
                  text={agentTranscript}
                  label="Copy for AI"
                  title="Fillers removed, turns merged, code terms formatted: ready to paste into an agent"
                />
                <CopyText text={copyText} label="Copy raw" title="Every line shown, with timestamps" />
              </>
            ) : (
              <CopyText text={copyText} label={target ? "Copy translation" : "Copy transcript"} disabled={!!target && (translation.loading || !!translation.error)} />
            )}
            <LanguagePicker value={target} pending={translation.loading} onChange={language => { setChosenLanguage(language); setTranslationRevision(value => value + 1); }} />
          </div>
        </div>
        <div
          className="-mx-2 max-h-[36rem] overflow-y-auto text-[14.5px] leading-relaxed text-ev-ink"
          onWheel={() => setFollowPlayback(false)}
        >
          {translation.error ? (
            <p className="px-2 pb-1 text-xs text-ev-warn-ink">{translation.error}</p>
          ) : null}
          {shown.map((line, i) => {
            const who = nameOf(line.speakerId);
            const sameSpeaker = i > 0 && nameOf(shown[i - 1].speakerId) === who;
            const headings = headingsBefore(i);
            const heading = headings.length ? headings[headings.length - 1].title : null;
            return (
              <div key={line.id}>
                {heading ? (
                  <h3 className="mb-1 mt-4 px-2 font-round text-[13px] font-bold text-ev-coat first:mt-1">
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
        <div className="fixed bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full bg-ev-raised px-4 py-2 text-sm text-ev-ink shadow-[var(--ev-e-3)]">
          Line deleted.
          <button type="button" onClick={() => void restore()} className="font-round font-bold text-ev-coat hover:underline">
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
        'group relative grid grid-cols-[3.5rem_1fr] gap-x-3 rounded-[var(--ev-r-ctl)] px-2 py-1.5',
        active ? 'bg-ev-coat-soft' : 'hover:bg-[var(--ev-hover)]',
      )}
    >
      <button
        type="button"
        onClick={onPlay}
        className="self-start pt-0.5 text-left font-round text-xs tabular-nums text-ev-ink-3 hover:text-ev-coat"
        title="Play from here"
      >
        {clockLabel(line.startMs)}
      </button>
      <div className="min-w-0 pr-20">
        {who ? <div className="font-round text-[13px] font-bold text-ev-ink">{who}</div> : null}
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
            className="w-full resize-none rounded-[var(--ev-r-ctl)] bg-ev-paper px-2 py-1 shadow-[var(--ev-focus)] outline-none"
          />
        ) : (
          <div onClick={onPlay} className="cursor-pointer">
            <p>{translation || line.text}</p>
            {translation ? (
              <p className="text-xs text-ev-ink-3" lang={line.language ?? undefined}>
                {line.text}
              </p>
            ) : null}
          </div>
        )}
      </div>
      {draft === null ? (
        <div className="absolute right-1 top-1 hidden items-center gap-0.5 rounded-[var(--ev-r-ctl)] bg-ev-raised p-0.5 shadow-[var(--ev-e-2)] group-hover:flex">
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
  partialMs,
  onSaved,
}: {
  meetingId: string;
  names: Record<string, string>;
  /** Where speaker names stop, for a call too long for the notetaker to name all of. */
  partialMs: number | null;
  onSaved: () => void;
}) {
  return (
    <div>
      <h3 className="mb-1.5 font-round text-[13px] font-bold text-ev-ink-2">Speakers</h3>
      <div className="space-y-1.5">
        {(['you', 'them'] as const).map((id) => (
          <SpeakerName key={id} meetingId={meetingId} id={id} name={speakerName(id, names)} onSaved={onSaved} />
        ))}
      </div>
      {partialMs !== null ? (
        <p className="mt-1.5 text-xs text-ev-ink-3">
          Speakers are named up to {clockLabel(partialMs)}; the rest of the call is unattributed.
        </p>
      ) : null}
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
      <span className="w-12 shrink-0 text-xs text-ev-ink-3">{id === 'you' ? 'Mic' : 'Call'}</span>
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
        className="min-w-0 flex-1 rounded-[var(--ev-r-ctl)] bg-ev-well px-2.5 py-1 text-ev-ink outline-none focus:bg-ev-paper focus:shadow-[var(--ev-focus)]"
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
      className="rounded-[6px] p-1 text-ev-ink-2 hover:bg-[var(--ev-hover)] hover:text-ev-ink"
    >
      {children}
    </button>
  );
}

function CopyText({ text, label, title, disabled = false }: { text: string; label: string; title?: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [text]);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => { void (async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      })(); }}
      title={title}
      className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 font-round text-xs font-semibold text-ev-ink-2 hover:bg-[var(--ev-hover)] hover:text-ev-ink"
    >
      {copied ? <Check className="h-3 w-3" /> : <Clipboard className="h-3 w-3" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

/**
 * Translations of the lines heard in another language than `target`. Each one
 * is kept with the text it was made from, so an edited line is translated again.
 */
function useTranslation(meetingId: string, lines: readonly TranscriptLine[], target: Language | null, revision: number) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Translations>({});
  const cache = useRef(new Map<string, Translations>());
  const spoken = useMemo(() => spokenLanguages(lines), [lines]);

  useEffect(() => {
    const controller = new AbortController();
    const key = `${meetingId}:${target}`;
    let known = { ...(cache.current.get(key) ?? {}) };
    setDone(known); setError(null); setLoading(false);
    if (!target) return;
    const missing = lines.filter(line => line.language !== target && known[line.id]?.source !== line.text);
    if (!missing.length) return;
    setLoading(true);
    const sources = new Map(lines.map(line => [line.id, line.text]));
    void (async () => {
      try {
        await requestTranslations({
          meetingId,
          target,
          signal: controller.signal,
          onPage: (entries) => {
            known = mergeTranslations(known, sources, entries);
            cache.current.set(key, known); setDone(known);
          },
        });
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not translate.');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [meetingId, target, lines, revision]);

  return {
    spoken, showing: !!target, loading, error,
    textFor: (line: TranscriptLine) => translationFor(done, line),
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
