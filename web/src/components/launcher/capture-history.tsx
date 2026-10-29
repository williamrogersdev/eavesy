'use client';
import { LanguagePicker } from '@/components/translation/language-picker';
import { useInlineTranslation } from '@/lib/translation/use-inline-translation';
import { CorrectionEditor } from '@/components/dictionary/correction-editor';

import {
  AudioLines,
  Camera,
  Clapperboard,
  Copy,
  ClipboardPaste,
  FolderOpen,
  MessageCircleQuestion,
  MessageSquareText,
  Image as ImageIcon,
  MoreHorizontal,
  MousePointerClick,
  Pause,
  Pencil,
  Play,
  Search,
  StickyNote,
  Trash2,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  captureMediaUrl,
  copyCaptureMedia,
  copyText,
  pasteToFrontmost,
  deleteCapture,
  errMsg,
  fetchAgentTranscript,
  recordingMoments,
  revealInFinder,
  type RecordingMoment,
} from '@/lib/desktop/bridge';
import { loadRecordingDetails } from '@/lib/launcher/data';
import { fillPrompt, matchPrompts, promptsOnly, type SavedPrompt } from '@/lib/prompts';
import { FOR_AGENTS_HINT, toneChoices, type Tone } from '@/lib/transcription/dictation-style';
import { MAX_RESTYLE_CHARS, requestRestyle } from '@/lib/transcription/restyle-client';
import { useHistoryPage } from './use-history-page';
import type { Recording } from '@/lib/launcher/types';
import type { AskCapture } from './eavesy-model';

/** Attach a capture to the next question (or take it off): `load` reads its whole text. */
export type AskAbout = (id: string, load: () => Promise<AskCapture>) => void;
const NO_IDS: ReadonlySet<string> = new Set();
import {
  askLabel,
  clock,
  FILTERS,
  groupByDay,
  highlightParts,
  historyView,
  kindLabel,
  plainTranscript,
  searchFocusOpens,
  timeOfDay,
  type HistoryFilter,
} from './history-model';
import { FN } from './shortcut-keys';
import type { Flash, RunTask } from './types';
import { Bubble, Button, Chip, IconButton, Kbd, Mascot, Menu } from './ui';

const ICON: Record<Recording['source'], LucideIcon> = {
  mic: AudioLines,
  dictation: AudioLines,
  both: Users,
  system: Users,
  screen: Clapperboard,
  screenshot: Camera,
  image: ImageIcon,
  note: StickyNote,
  upload: AudioLines,
};

function kindOf(rec: Recording): { label: string; icon: LucideIcon } {
  const icon = rec.source === 'upload' && rec.hasVideo ? Clapperboard : ICON[rec.source] ?? AudioLines;
  return { label: kindLabel(rec), icon };
}

function useMediaUrl(id: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void captureMediaUrl(id)
      .then((value) => { if (!cancelled) setUrl(value); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [id]);
  return { url, error };
}

let nowPlaying: HTMLAudioElement | null = null;

function usePlayer(id: string) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => { audio.current?.pause(); }, []);
  const toggle = async () => {
    try {
      if (!audio.current) {
        const el = new Audio(await captureMediaUrl(id));
        el.onplay = () => setPlaying(true);
        el.onpause = () => setPlaying(false);
        el.onended = () => setPlaying(false);
        audio.current = el;
      }
      const el = audio.current;
      if (el.paused) {
        if (nowPlaying && nowPlaying !== el) nowPlaying.pause();
        nowPlaying = el;
        await el.play();
      } else el.pause();
    } catch {
      setFailed(true);
    }
  };
  return { playing, failed, toggle };
}

/** The full image over the panel. Esc, the close button or a click outside the image closes it. */
function ImageViewer({ url, label, host, onClose }: { url: string; label: string; host: Element; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      opener?.focus();
    };
  }, []);
  return createPortal(
    <div className="ev-viewer" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <img src={url} alt={label} />
      <IconButton ref={closeRef} className="ev-viewer-close" label="Close" icon={X} onClick={onClose} />
    </div>,
    host,
  );
}

function Thumb({ id, video, durationSec, label }: { id: string; video: boolean; durationSec: number; label: string }) {
  const { url, error } = useMediaUrl(id);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [viewerHost, setViewerHost] = useState<Element | null>(null);
  // The frame keeps its loading height until the image has decoded, so the row resizes once.
  const [decoded, setDecoded] = useState(false);
  if (error) return <p className="ev-sub">Preview unavailable. The file may have been moved.</p>;
  if (!url) return <div className="ev-thumb" data-kind={video ? undefined : 'image'} data-loading="true" />;
  if (!video) return (
    <>
      <button
        type="button"
        className="ev-thumb"
        data-kind="image"
        data-loading={!decoded}
        aria-label={`View ${label.toLowerCase()}`}
        title="Click to view"
        onClick={(e) => setViewerHost(e.currentTarget.closest('.ev-panel') ?? document.body)}
      >
        <img src={url} alt={label} loading="lazy" decoding="async" onLoad={() => setDecoded(true)} onError={() => setDecoded(true)} />
      </button>
      {viewerHost && <ImageViewer url={url} label={label} host={viewerHost} onClose={() => setViewerHost(null)} />}
    </>
  );
  return (
    <div className="ev-thumb">
      <video
        ref={videoRef}
        src={url}
        preload="metadata"
        aria-label="Screen recording. Click to play."
        onClick={() => { const el = videoRef.current; if (el) void (el.paused ? el.play() : el.pause()); }}
      />
      {durationSec > 0 && <span className="ev-badge">{clock(durationSec)}</span>}
    </div>
  );
}

/**
 * The case file for a screen recording: what was tagged and clicked, each
 * with its close-up and what was said at the time. Tags lead; clicks fold away.
 */
function Evidence({ id, revision }: { id: string; revision?: number }) {
  const [moments, setMoments] = useState<RecordingMoment[]>([]);
  const [all, setAll] = useState(false);
  const [viewer, setViewer] = useState<{ url: string; label: string; host: Element } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void recordingMoments(id).then((value) => { if (!cancelled) setMoments(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, [id, revision]);
  if (moments.length === 0) return null;
  const tags = moments.filter((moment) => moment.mark != null);
  const clicks = moments.length - tags.length;
  const shown = all ? moments : (tags.length > 0 ? tags : moments).slice(0, 3);
  const counts = [tags.length > 0 && `${tags.length} tagged`, clicks > 0 && `${clicks} ${clicks === 1 ? 'click' : 'clicks'}`].filter(Boolean).join(' · ');
  return (
    <section className="ev-evidence" aria-label="Evidence">
      <header className="ev-evidence-head"><span>Evidence</span><span>{counts}</span></header>
      <ol>
        {shown.map((moment) => {
          const what = moment.kind === 'area' ? 'An area' : moment.what ?? (moment.kind === 'click' ? 'A click' : 'An element');
          const label = `${moment.mark != null ? `Tag ${moment.mark}` : 'Click'} at ${clock(Math.floor(moment.timestampMs / 1000))}: ${what}`;
          return (
            <li key={moment.number} className="ev-moment">
              {moment.crop
                ? <button type="button" className="ev-moment-crop" aria-label={`View close-up. ${label}`} onClick={(e) => setViewer({ url: moment.crop!, label, host: e.currentTarget.closest('.ev-panel') ?? document.body })}><img src={moment.crop} alt="" /></button>
                : <span className="ev-moment-crop" data-empty="true" aria-hidden />}
              <div className="ev-moment-text">
                <div className="ev-moment-head">
                  <span className="ev-moment-time">{clock(Math.floor(moment.timestampMs / 1000))}</span>
                  {moment.mark != null
                    ? <span className="ev-moment-tag" aria-label={`Tag ${moment.mark}`}>{moment.mark}</span>
                    : <MousePointerClick size={12} strokeWidth={2} aria-label="Click" />}
                  <span className="ev-moment-what">{what}</span>
                </div>
                {moment.narration
                  ? <p className="ev-moment-said">“{moment.narration}”</p>
                  : moment.where && <p className="ev-moment-said" data-muted="true" title={moment.url ?? undefined}>{moment.where}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      {shown.length < moments.length || all
        ? <button type="button" className="ev-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Fewer' : `All ${moments.length}`}</button>
        : null}
      {viewer && <ImageViewer url={viewer.url} label={viewer.label} host={viewer.host} onClose={() => setViewer(null)} />}
    </section>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, i) =>
        part.hit ? <mark key={i} className="ev-hl">{part.text}</mark> : part.text,
      )}
    </>
  );
}

function Body({ text, query, muted, onExpand }: { text: string; query: string; muted?: boolean; onExpand?: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220 || text.split('\n').length > 3;
  return (
    <>
      <div className={`ev-body${long && !open ? ' ev-clamp' : ''}`} dir="auto" data-muted={muted}>
        <Highlighted text={text} query={query} />
      </div>
      {long && (
        <button type="button" className="ev-more" aria-expanded={open} onClick={() => {
            if (!open && onExpand) void onExpand().then(() => setOpen(true)).catch(() => {});
            else setOpen(!open);
          }}>
          {open ? 'Less' : 'More'}
        </button>
      )}
    </>
  );
}

type Version = { tone: Tone; forAgents: boolean };

const TONES = toneChoices('The words as they were saved.');

/**
 * A capture's words in another tone, or shaped as a prompt for an AI. Each
 * version is made from the saved words, never from another rewrite, and
 * none is saved over them.
 */
function useRewrite(id: string, loadText: () => Promise<string>, resetKey: string) {
  const [shown, setShown] = useState<Version>({ tone: 'original', forAgents: false });
  const [pending, setPending] = useState<Version | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const cache = useRef(new Map<string, string>());
  const requestId = useRef(0);
  const load = useRef(loadText);
  load.current = loadText;

  useEffect(() => {
    const requests = requestId;
    requests.current++;
    cache.current.clear();
    setShown({ tone: 'original', forAgents: false }); setPending(null); setText(null); setError('');
    return () => { requests.current++; };
  }, [resetKey]);

  async function make({ tone, forAgents }: Version): Promise<string> {
    const source = await load.current();
    // Too long for a rewrite, but the cloud keeps a version for agents of any length.
    if (source.length > MAX_RESTYLE_CHARS && forAgents && tone === 'original') {
      const agent = await fetchAgentTranscript(id).catch(() => null);
      if (agent) return agent;
    }
    return await requestRestyle(id, source, tone === 'original' ? 'natural' : tone, forAgents);
  }

  async function select(next: Version) {
    const request = ++requestId.current;
    setError('');
    if (next.tone === 'original' && !next.forAgents) {
      setShown(next); setPending(null); setText(null);
      return;
    }
    const key = `${next.tone}:${next.forAgents}`;
    const cached = cache.current.get(key);
    if (cached !== undefined) { setShown(next); setPending(null); setText(cached); return; }
    setPending(next);
    try {
      const output = await make(next);
      if (request !== requestId.current) return;
      cache.current.set(key, output);
      setShown(next); setText(output);
    } catch (cause) {
      if (request === requestId.current) setError(errMsg(cause, 'Couldn’t rewrite it. Try again'));
    } finally {
      if (request === requestId.current) setPending(null);
    }
  }

  const clearError = useCallback(() => setError(''), []);
  return { version: pending ?? shown, text, busy: pending !== null, error, select, clearError };
}

/**
 * One capture in the history. Memoized: a row re-renders only when its own data
 * (kept as the same object across refreshes when unchanged) or the query changes.
 */
const CaptureRow = memo(function CaptureRow({
  rec,
  query,
  signedIn,
  onSignIn,
  flash,
  runTask,
  attached = false,
  onAskAbout,
}: {
  rec: Recording;
  query: string;
  /** Undefined while the account is still being looked up. */
  signedIn: boolean | undefined;
  onSignIn: () => void;
  flash: Flash;
  runTask: RunTask;
  /** This capture goes with the next question in the ask bar. */
  attached?: boolean;
  onAskAbout?: AskAbout;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const kind = kindOf(rec);
  const Icon = kind.icon;
  // The complete record, once expanded (or once the tray needed its full length).
  const [detail, setDetail] = useState<Recording | null>(null);
  const [fetchingFull, setFetchingFull] = useState(false);
  const versioned = !!detail && detail.id === rec.id && detail.revision !== undefined && rec.revision !== undefined;
  const current = versioned && detail ? detail : rec;
  // A sync or cloud refine moved the record on while it was expanded: fetch it again,
  // keeping the words on screen meanwhile, instead of snapping back to the preview.
  const behind = versioned && (detail?.revision ?? 0) < (rec.revision ?? 0);
  useEffect(() => {
    if (!behind) return;
    let cancelled = false;
    void loadRecordingDetails(rec)
      .then((next) => { if (!cancelled) setDetail(next); })
      .catch(() => { if (!cancelled) setDetail(null); });
    return () => { cancelled = true; };
  }, [behind, rec]);
  const text = useMemo(() => plainTranscript(current.transcript ?? ''), [current.transcript]);
  const translation = useInlineTranslation(text, async () => plainTranscript((await loadRecordingDetails(rec)).transcript ?? ''), rec.revision);
  const fullText = async () => current.transcriptTruncated ? plainTranscript((await loadRecordingDetails(rec)).transcript ?? '') : text;
  const rewrite = useRewrite(rec.id, fullText, `${rec.revision}:${text}`);
  const expand = async () => {
    try { setDetail(await loadRecordingDetails(rec)); }
    catch (error) { flash(errMsg(error, 'Couldn’t load that capture'), 5000, 'warn'); throw error; }
  };
  const image = rec.source === 'screenshot' || rec.source === 'image';
  const video = !!rec.hasVideo;
  const playable = rec.hasAudio && !video && rec.status !== 'recording';
  const timed = rec.durationSec > 0 && !image && rec.source !== 'note';
  const player = usePlayer(rec.id);
  const spoken = rec.source !== 'note' && !image && rec.source !== 'upload';
  const rewritable = !!text && !image && !video;
  const tones = rewritable && signedIn === true && rec.status !== 'processing';
  // Past the limit only For AI works here (from the cloud's agent transcript). A preview's
  // length isn't the real one, so this is decided once the tray has the whole text.
  const tooLong = !current.transcriptTruncated && text.length > MAX_RESTYLE_CHARS;
  const changed = rewrite.text !== null || !!translation.language;
  const shownText = rewrite.text ?? translation.text;
  const trayOpen = rewritable && (rewriting || changed || rewrite.busy || translation.busy || languageOpen);
  const pickVersion = (next: Version) => {
    if (translation.language) void translation.select(null);
    void rewrite.select(next);
  };
  const pickLanguage = (language: Parameters<typeof translation.select>[0]) => {
    if (rewrite.text !== null || rewrite.busy) void rewrite.select({ tone: 'original', forAgents: false });
    void translation.select(language);
  };
  const toggleTray = () => {
    if (!trayOpen) {
      setRewriting(true);
      if (current.transcriptTruncated && !fetchingFull) {
        setFetchingFull(true);
        void loadRecordingDetails(rec).then(setDetail, () => undefined).finally(() => setFetchingFull(false));
      }
      return;
    }
    setRewriting(false);
    rewrite.clearError();
    translation.clearError();
    if (rewrite.text !== null || rewrite.busy) void rewrite.select({ tone: 'original', forAgents: false });
    if (translation.language || translation.busy) void translation.select(null);
  };

  const copy = () => runTask(async () => {
    if (image || video) await copyCaptureMedia(rec.id);
    else await copyText(changed ? shownText : plainTranscript((await loadRecordingDetails(rec)).transcript ?? ''));
    flash('Copied');
  }, 'Couldn’t copy that');

  const copyLabel = image ? 'Copy image' : video ? 'Copy' : 'Copy text';

  let body: ReactNode;
  if (image) body = <Thumb id={rec.id} video={false} durationSec={0} label={kind.label} />;
  else if (video) body = <>
    <Thumb id={rec.id} video durationSec={rec.durationSec} label={kind.label} />
    <Evidence id={rec.id} revision={rec.revision} />
    {text && <div style={{ marginTop: 6 }}><Body key={translation.language ?? ''} text={translation.text} query={query} onExpand={!translation.language && current.transcriptTruncated ? expand : undefined} /></div>}
  </>;
  else if (text) body = <>
    <Body
      key={`${translation.language ?? ''}-${rewrite.text === null ? '' : `${rewrite.version.tone}:${rewrite.version.forAgents}`}`}
      text={shownText}
      query={query}
      muted={rewrite.busy || translation.busy}
      onExpand={!changed && current.transcriptTruncated ? expand : undefined}
    />
    {signedIn === true && rec.status === 'processing' && <div className="ev-sub">First pass. Refining in the cloud…</div>}
  </>;
  else if (signedIn === false && spoken && rec.status !== 'complete') body = (
    <div className="ev-body" data-muted="true">
      Saved on this Mac. <button type="button" className="ev-link" onClick={onSignIn}>Sign in</button> to get a transcript.
    </div>
  );
  else if (rec.status === 'processing') body = <div className="ev-body" data-muted="true">Writing it down…</div>;
  else if (rec.status === 'failed' || rec.status === 'transcript_failed') body = (
    <div className="ev-body" data-tone="warn">Transcription failed. The audio is saved.</div>
  );
  else if (spoken) body = <div className="ev-body" data-muted="true">Didn’t hear any words in this one. The audio is still saved.</div>;
  else body = <div className="ev-body" data-muted="true">Saved on this Mac.</div>;

  return (
    <article className="ev-row" data-menu={menuOpen || trayOpen || attached} data-attached={attached || undefined} aria-label={`${kind.label}, ${timeOfDay(rec.startedAt)}`}>
      <header className="ev-rh">
        <Icon className="ev-rh-icon" size={13} strokeWidth={1.75} aria-hidden />
        <span className="ev-rh-kind">{kind.label}</span>
        {timed && <span>· {clock(rec.durationSec)}</span>}
        {rec.device && <span className="ev-rh-device" title={`Recorded on ${rec.device}`}>· {rec.device}</span>}
        <span className="ev-rh-time">{timeOfDay(rec.startedAt)}</span>
      </header>
      {body}
      {trayOpen && (
        <div className="ev-tones" role="group" aria-label="Rewrite">
          {tones && <>
            {TONES.map((tone) => (
              <Chip
                key={tone.id}
                title={tooLong && tone.id !== 'original' ? 'Too long to rewrite here' : tone.hint}
                selected={rewrite.version.tone === tone.id && !translation.language}
                disabled={rewrite.busy || fetchingFull || (tooLong && tone.id !== 'original')}
                onClick={() => pickVersion({ tone: tone.id, forAgents: rewrite.version.forAgents })}
              >
                {tone.label}
              </Chip>
            ))}
            <span className="ev-tones-sep" aria-hidden />
            <Chip title={FOR_AGENTS_HINT} selected={rewrite.version.forAgents && !translation.language} disabled={rewrite.busy || fetchingFull} onClick={() => pickVersion({ tone: tooLong ? 'original' : rewrite.version.tone, forAgents: !rewrite.version.forAgents })}>
              For AI
            </Chip>
          </>}
          <LanguagePicker value={translation.language} pending={translation.busy} disabled={fetchingFull} onChange={pickLanguage} onOpenChange={setLanguageOpen} />
          {rewrite.busy
            ? <span className="ev-tones-state" role="status">Rewriting…</span>
            : tones && tooLong && <span className="ev-tones-state">Too long to rewrite here</span>}
        </div>
      )}
      {trayOpen && rewrite.error && <p role="alert" className="ev-sub" style={{ color: 'var(--ev-warn-ink)' }}>{rewrite.error}</p>}
      {editing && <CorrectionEditor
        id={rec.id}
        original={current.transcript ?? ''}
        loadOriginal={async () => (await loadRecordingDetails(rec)).transcript ?? ''}
        open={editing}
        onOpenChange={setEditing}
        onCloseFocus={() => moreButton.current?.focus()}
        onSaved={transcript => {
          setDetail({ ...current, transcript, transcriptTruncated: false });
          flash('Corrections saved');
        }}
      />}
      {trayOpen && translation.error && <p role="alert" className="ev-sub" style={{ color: 'var(--ev-warn-ink)' }}>{translation.error}</p>}
      <div className="ev-actions">
        {changed && <IconButton label="Paste this version at cursor" icon={ClipboardPaste} disabled={translation.busy || rewrite.busy} onClick={() => runTask(() => pasteToFrontmost(shownText, false), 'Couldn’t paste that')} />}
        {onAskAbout && text && (
          <IconButton
            label={attached ? 'Don’t ask Eavesy about this' : 'Ask Eavesy about this'}
            icon={MessageCircleQuestion}
            pressed={attached}
            onClick={() => onAskAbout(rec.id, async () => ({ id: rec.id, label: askLabel(rec, Date.now()), text: await fullText() }))}
          />
        )}
        <IconButton label={copyLabel} icon={Copy} filled disabled={translation.busy || rewrite.busy || (!image && !video && !text)} onClick={copy} />
        {rewritable && <Button size="sm" variant="ghost" aria-pressed={trayOpen} title="Change the tone, shape it for an AI, or translate" onClick={toggleTray}>Rewrite</Button>}
        <Menu
          align="end"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          trigger={<IconButton ref={moreButton} label="More" icon={MoreHorizontal} />}
          items={[
            ...(text && !changed && signedIn && spoken && rec.status !== 'processing'
              ? [{ label: 'Edit transcript', icon: Pencil, onSelect: () => setEditing(true) }]
              : []),
            ...(playable
              ? [{
                  label: player.failed ? 'Audio unavailable' : player.playing ? 'Pause' : 'Play audio',
                  icon: player.playing ? Pause : Play,
                  disabled: player.failed,
                  onSelect: () => void player.toggle(),
                }]
              : []),
            { label: 'Show in Finder', icon: FolderOpen, onSelect: () => runTask(() => revealInFinder(rec.id)) },
            'separator',
            {
              label: 'Move to Trash',
              icon: Trash2,
              tone: 'warn',
              onSelect: () => runTask(async () => {
                await deleteCapture(rec.id);
                flash('Moved to Trash');
              }, 'Couldn’t delete that'),
            },
          ]}
        />
      </div>
    </article>
  );
});

/** How many saved prompts a search shows above the captures. */
const PROMPT_HITS = 5;

/** A saved prompt a search found: paste it where the cursor was, or copy it. */
function PromptRow({ prompt, query, first, onPaste, flash, runTask }: {
  prompt: SavedPrompt;
  query: string;
  first: boolean;
  onPaste: () => void;
  flash: Flash;
  runTask: RunTask;
}) {
  return (
    <article className="ev-row" aria-label={`Prompt, ${prompt.name}`}>
      <header className="ev-rh">
        <MessageSquareText className="ev-rh-icon" size={13} strokeWidth={1.75} aria-hidden />
        <span className="ev-rh-kind">{prompt.name}</span>
        <span>· /{prompt.slug}</span>
        {first && <span className="ev-rh-time"><Kbd keys="↩" /></span>}
      </header>
      <Body text={fillPrompt(prompt.body)} query={promptsOnly(query) ? query.trim().slice(1) : query} />
      <div className="ev-actions">
        <IconButton label="Paste at cursor" icon={ClipboardPaste} filled onClick={onPaste} />
        <IconButton label="Copy text" icon={Copy} onClick={() => runTask(async () => {
          await copyText(fillPrompt(prompt.body));
          flash('Copied');
        }, 'Couldn’t copy that')} />
      </div>
    </article>
  );
}

const NO_ROWS: Recording[] = [];
const quietFocus = new WeakSet<EventTarget>();
const askedFocus = new WeakSet<EventTarget>();
function focusMarked(input: HTMLInputElement, marks: WeakSet<EventTarget>) {
  marks.add(input);
  try {
    input.focus({ preventScroll: true });
  } finally {
    marks.delete(input);
  }
}
/** Focuses search so typing lands there, without opening the field until something is typed. */
export function focusSearchQuietly(input: HTMLInputElement) {
  focusMarked(input, quietFocus);
}
/** Opens search and focuses it ("/"). */
export function focusSearch(input: HTMLInputElement) {
  focusMarked(input, askedFocus);
}
const NO_COUNTS: Record<HistoryFilter, number> = { all: 0, voice: 0, meetings: 0, screens: 0, notes: 0 };

/**
 * Search, the day-grouped captures and the empty state. Memoized and fed only
 * stable props, so a capture running in the toolbar doesn't re-render it.
 */
export const CaptureHistory = memo(function CaptureHistory({
  refreshRevision,
  openKey,
  liveId,
  hasLive,
  dictationHotkey,
  signedIn,
  onSignIn,
  flash,
  runTask,
  searchRef,
  scrollRef,
  prompts = null,
  promptsError = null,
  onRetryPrompts,
  onPromptUsed,
  attachedIds = NO_IDS,
  onAskAbout,
}: {
  /** Captures attached to the next question in the ask bar. */
  attachedIds?: ReadonlySet<string>;
  /** Shows "Ask Eavesy about this" on captures with words. */
  onAskAbout?: AskAbout;
  /** Bumped by every native "recordings changed" event. */
  refreshRevision: number;
  /** Bumped each time the panel opens: search and filter start fresh. */
  openKey: number;
  /** Saved prompts the search can find; null when signed out or still loading. */
  prompts?: SavedPrompt[] | null;
  /** Why the saved prompts couldn't be loaded. */
  promptsError?: string | null;
  onRetryPrompts?: () => void;
  /** Counts a pasted prompt. */
  onPromptUsed?: (id: string) => void;
  /** The capture the toolbar shows while it runs; it joins the list once written down. */
  liveId: string | null;
  /** A capture is starting, running or being written down. */
  hasLive: boolean;
  /** The Talk shortcut as shown ("Fn", "⌘⇧D"), for the empty state's hint. */
  dictationHotkey: string;
  /** Undefined while the account is still being looked up. */
  signedIn: boolean | undefined;
  onSignIn: () => void;
  flash: Flash;
  runTask: RunTask;
  searchRef: RefObject<HTMLInputElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [now, setNow] = useState(() => Date.now());
  const [mountedAt] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // Each opening starts from everything, so a capture made meanwhile is never filtered out.
  useEffect(() => {
    setQuery('');
    setFilter('all');
  }, [openKey]);

  // A search starting with "/" looks only for saved prompts, and only then does Return paste
  // one: Return in an ordinary search must never type into another app.
  const onlyPrompts = promptsOnly(query);
  const captureQuery = onlyPrompts ? '' : query;
  const promptHits = useMemo(() => matchPrompts(prompts ?? [], query).slice(0, PROMPT_HITS), [prompts, query]);
  // One paste per Return, however fast it is pressed again.
  const pasting = useRef(false);
  const pastePrompt = useCallback((prompt: SavedPrompt) => {
    if (pasting.current) return;
    pasting.current = true;
    runTask(async () => {
      try {
        await pasteToFrontmost(fillPrompt(prompt.body), false);
        setQuery('');
        onPromptUsed?.(prompt.id);
      } finally {
        pasting.current = false;
      }
    }, 'Couldn’t paste that');
  }, [onPromptUsed, runTask]);

  const history = useHistoryPage(refreshRevision, captureQuery, filter, openKey);
  const rows = history.page?.items ?? NO_ROWS;
  const visible = useMemo(
    () => (onlyPrompts ? NO_ROWS : rows.filter((rec) => rec.id !== liveId)),
    [onlyPrompts, rows, liveId],
  );
  const counts = history.page?.counts ?? NO_COUNTS;
  const groups = useMemo(() => groupByDay(visible, now), [visible, now]);

  const view = historyView(history.page, history.error, hasLive);
  const typed = query.trim() !== '';
  const searching = typed || filter !== 'all';
  // Opened by a click or "/"; the quiet focus when the panel opens leaves it an icon until you type.
  const [opened, setOpened] = useState(false);
  // Each opening starts as an icon. This runs after the commit, before the panel's quiet focus (next frame).
  useEffect(() => setOpened(false), [openKey]);
  const expanded = opened || typed;

  return (
    <>
      {history.error && (
        <div role="alert" className="ev-banner">
          <span>Couldn’t load your captures: {history.error}</span>
          <button type="button" className="ev-link" onClick={history.retry}>Try again</button>
        </div>
      )}
      {view !== 'empty' && (
        <div className="ev-listbar" data-search={expanded}>
        <div className="ev-listbar-types" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <Chip
              key={f.value}
              data-all={f.value === 'all' || undefined}
              selected={filter === f.value}
              count={searching && !onlyPrompts ? counts[f.value] : undefined}
              onClick={() => setFilter(filter === f.value ? 'all' : f.value)}
            >
              {f.label}
            </Chip>
          ))}
        </div>
        <label
          className="ev-search"
          data-open={expanded}
          data-active={typed}
          onPointerDown={() => setOpened(true)}
          onFocus={(e) => {
            if (searchFocusOpens({ asked: askedFocus.has(e.target), quiet: quietFocus.has(e.target), fromElement: e.relatedTarget !== null })) setOpened(true);
          }}
          onBlur={(e) => {
            if (e.currentTarget.contains(e.relatedTarget)) return;
            setOpened(false);
          }}
          title={prompts?.length ? 'Search captures (/), or start with / for prompts' : 'Search captures (/)'}
        >
          <Search size={15} strokeWidth={1.75} aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search"
            aria-label="Search captures"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && onlyPrompts && promptHits[0] && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!e.repeat) pastePrompt(promptHits[0]);
              } else if (e.key === 'Escape' && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
        </label>
        </div>
      )}
      {view === 'empty' ? (
        <div className="ev-empty">
          <Mascot size={72} state="idle" />
          <Bubble tail="bottom">
            It’s quiet up here. Hold <Kbd keys={dictationHotkey === FN || !dictationHotkey ? 'fn' : dictationHotkey} /> and talk, or drop something in below.
          </Bubble>
          <span className="ev-empty-pointer" aria-hidden />
        </div>
      ) : (
        <div ref={scrollRef} data-capture-history className="ev-scroll" aria-busy={view === 'loading' || undefined}>
          {promptHits.length > 0 && (
            <section className="ev-group" aria-label="Prompts">
              <h2 className="ev-gh">Prompts</h2>
              {promptHits.map((prompt, i) => (
                <PromptRow key={prompt.id} prompt={prompt} query={query} first={onlyPrompts && i === 0} onPaste={() => pastePrompt(prompt)} flash={flash} runTask={runTask} />
              ))}
            </section>
          )}
          {groups.map((group) => (
            <section key={group.label} className="ev-group" aria-label={group.label}>
              <h2 className="ev-gh">{group.label}</h2>
              {group.items.map((rec) => (
                <div key={rec.id} className={rec.startedAt >= mountedAt ? 'ev-grow' : undefined}>
                  <CaptureRow rec={rec} query={query} signedIn={signedIn} onSignIn={onSignIn} flash={flash} runTask={runTask} attached={attachedIds.has(rec.id)} onAskAbout={onAskAbout} />
                </div>
              ))}
            </section>
          ))}
          {history.page?.nextOffset != null && (
            <button type="button" className="ev-link" disabled={history.busy} onClick={() => void history.loadMore()}>
              {history.loading ? 'Loading…' : 'Load more captures'}
            </button>
          )}
          {onlyPrompts && promptHits.length === 0 && (
            prompts === null && promptsError ? (
              <p className="ev-empty-search">
                Couldn’t load your prompts. <button type="button" className="ev-link" onClick={onRetryPrompts}>Try again</button>
              </p>
            ) : (
              <p className="ev-empty-search">
                {!prompts?.length
                  ? 'No saved prompts yet. Add one in Settings → Prompts.'
                  : query.trim().length > 1 ? `No prompts match “${query.trim().slice(1).trim()}”.` : 'No saved prompts yet.'}
              </p>
            )
          )}
          {!onlyPrompts && searching && visible.length === 0 && promptHits.length === 0 && !history.loading && (
            <p className="ev-empty-search">
              {query.trim() ? `No captures match “${query.trim()}”.` : 'Nothing here yet.'}
            </p>
          )}
        </div>
      )}
    </>
  );
});
