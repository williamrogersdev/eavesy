'use client';

import {
  AudioLines,
  Camera,
  Clapperboard,
  ClipboardPaste,
  Copy,
  FolderOpen,
  Image as ImageIcon,
  MoreHorizontal,
  Pause,
  Play,
  Search,
  Sparkles,
  StickyNote,
  Trash2,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  captureMediaUrl,
  copyCaptureMedia,
  copyText,
  deleteCapture,
  fetchAgentTranscript,
  pasteToFrontmost,
  revealInFinder,
} from '@/lib/desktop/bridge';
import type { Recording } from '@/lib/launcher/types';
import {
  clock,
  countByFilter,
  FILTERS,
  groupByDay,
  highlightParts,
  plainTranscript,
  timeOfDay,
  visibleRecordings,
  type HistoryFilter,
} from './history-model';
import type { LiveCapture } from './capture-toolbar';
import { FN } from './shortcut-keys';
import type { Flash, RunTask } from './types';
import { Bubble, Chip, IconButton, Kbd, Mascot, Menu } from './ui';

export { plainTranscript };
export type { LiveCapture };

/** A capture running now, shown as one height-locked row at the top of Today. */

const KIND: Record<Recording['source'], { label: string; icon: LucideIcon }> = {
  mic: { label: 'Voice note', icon: AudioLines },
  dictation: { label: 'Voice note', icon: AudioLines },
  both: { label: 'Meeting', icon: Users },
  system: { label: 'Meeting', icon: Users },
  screen: { label: 'Video', icon: Clapperboard },
  screenshot: { label: 'Screenshot', icon: Camera },
  image: { label: 'Image', icon: ImageIcon },
  note: { label: 'Note', icon: StickyNote },
  upload: { label: 'Upload', icon: AudioLines },
};

function kindOf(rec: Recording): { label: string; icon: LucideIcon } {
  if (rec.source === 'upload') return { label: rec.title || 'Upload', icon: rec.hasVideo ? Clapperboard : AudioLines };
  return KIND[rec.source] ?? KIND.mic;
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
  if (error) return <p className="ev-sub">Preview unavailable. The file may have been moved.</p>;
  if (!url) return <div className="ev-thumb" data-loading="true" />;
  if (!video) return (
    <>
      <button
        type="button"
        className="ev-thumb"
        data-kind="image"
        aria-label={`View ${label.toLowerCase()}`}
        title="Click to view"
        onClick={(e) => setViewerHost(e.currentTarget.closest('.ev-panel') ?? document.body)}
      >
        <img src={url} alt={label} />
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

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, i) =>
        part.hit ? <mark key={i} className="ev-hl">{part.text}</mark> : part.text,
      )}
    </>
  );
}

function Body({ text, query, muted }: { text: string; query: string; muted?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220 || text.split('\n').length > 3;
  return (
    <>
      <div className={`ev-body${long && !open ? ' ev-clamp' : ''}`} data-muted={muted}>
        <Highlighted text={text} query={query} />
      </div>
      {long && (
        <button type="button" className="ev-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'More'}
        </button>
      )}
    </>
  );
}

function CaptureRow({
  rec,
  query,
  signedIn,
  onSignIn,
  flash,
  runTask,
}: {
  rec: Recording;
  query: string;
  signedIn: boolean;
  onSignIn: () => void;
  flash: Flash;
  runTask: RunTask;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const kind = kindOf(rec);
  const Icon = kind.icon;
  const text = plainTranscript(rec.transcript ?? '');
  const image = rec.source === 'screenshot' || rec.source === 'image';
  const video = !!rec.hasVideo;
  const playable = rec.hasAudio && !video && rec.status !== 'recording';
  const timed = rec.durationSec > 0 && !image && rec.source !== 'note';
  const player = usePlayer(rec.id);
  const spoken = rec.source !== 'note' && !image && rec.source !== 'upload';

  const copy = () => runTask(async () => {
    if (image || (video && !text)) await copyCaptureMedia(rec.id);
    else await copyText(text);
    flash('Copied');
  }, 'Couldn’t copy that');

  const paste = () => runTask(async () => {
    await pasteToFrontmost(text);
    flash('Pasted');
  }, 'Couldn’t paste that');

  let body: ReactNode;
  if (image) body = <Thumb id={rec.id} video={false} durationSec={0} label={kind.label} />;
  else if (video) body = <>
    <Thumb id={rec.id} video durationSec={rec.durationSec} label={kind.label} />
    {text && <div style={{ marginTop: 6 }}><Body text={text} query={query} /></div>}
  </>;
  else if (text) body = <>
    <Body text={text} query={query} />
    {signedIn && rec.status === 'processing' && <div className="ev-sub">First pass. Refining in the cloud…</div>}
  </>;
  else if (!signedIn && spoken && rec.status !== 'complete') body = (
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
    <article className="ev-row" data-menu={menuOpen} aria-label={`${kind.label}, ${timeOfDay(rec.startedAt)}`}>
      <span className="ev-disc-kind" aria-hidden><Icon size={13} strokeWidth={1.75} /></span>
      <header className="ev-rh">
        <span className="ev-rh-kind">{kind.label}</span>
        {timed && <span>· {clock(rec.durationSec)}</span>}
        <span className="ev-rh-time">{timeOfDay(rec.startedAt)}</span>
      </header>
      {body}
      <div className="ev-actions">
        {playable && (
          <IconButton
            label={player.failed ? 'Audio unavailable' : player.playing ? 'Pause' : 'Play'}
            icon={player.playing ? Pause : Play}
            filled
            disabled={player.failed}
            onClick={() => void player.toggle()}
          />
        )}
        <IconButton label="Copy" icon={Copy} disabled={!image && !video && !text} onClick={copy} />
        {text && <IconButton label="Paste at cursor" icon={ClipboardPaste} onClick={paste} />}
        <Menu
          align="end"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          trigger={<IconButton label="More" icon={MoreHorizontal} />}
          items={[
            ...(text && signedIn
              ? [{
                  label: 'Copy for AI',
                  icon: Sparkles,
                  onSelect: () => runTask(async () => {
                    const { text: agent, cleaned } = await agentText(rec);
                    await copyText(agent);
                    flash(cleaned ? 'Copied for AI' : 'Copied. The cleaned-up version isn’t ready yet');
                  }, 'Couldn’t copy that'),
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
}

/**
 * The transcript cleaned up for an AI agent (filler gone, code in backticks,
 * speakers merged), or the plain transcript while the cloud is still on it.
 */
export async function agentText(rec: Recording): Promise<{ text: string; cleaned: boolean }> {
  const cleaned = await fetchAgentTranscript(rec.id).catch(() => null);
  return cleaned ? { text: cleaned, cleaned: true } : { text: plainTranscript(rec.transcript ?? ''), cleaned: false };
}

export function CaptureHistory({
  recordings,
  live,
  dictationHotkey,
  signedIn,
  onSignIn,
  flash,
  runTask,
  searchRef,
  scrollRef,
  loadError,
  onRetry,
}: {
  recordings: Recording[];
  live: LiveCapture | null;
  /** The Talk shortcut as shown ("Fn", "⌘⇧D"), for the empty state's hint. */
  dictationHotkey: string;
  signedIn: boolean;
  onSignIn: () => void;
  flash: Flash;
  runTask: RunTask;
  searchRef: RefObject<HTMLInputElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  loadError: string | null;
  onRetry: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [now, setNow] = useState(() => Date.now());
  const [mountedAt] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const liveId = live?.sessionId ?? null;
  const visible = useMemo(
    () => visibleRecordings(recordings, filter, query).filter((rec) => rec.id !== liveId),
    [recordings, filter, query, liveId],
  );
  const counts = useMemo(() => countByFilter(recordings), [recordings]);
  const groups = useMemo(() => groupByDay(visible, now), [visible, now]);

  const empty = recordings.length === 0 && !live;
  const searching = query.trim() !== '' || filter !== 'all';

  return (
    <>
      {loadError && (
        <div role="alert" className="ev-banner">
          <span>Couldn’t load your captures: {loadError}</span>
          <button type="button" className="ev-link" onClick={onRetry}>Try again</button>
        </div>
      )}
      {!empty && (
        <>
          <label className="ev-search">
            <Search size={15} strokeWidth={1.75} aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Search captures"
              aria-label="Search captures"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery('');
                }
              }}
            />
            {!query && <Kbd keys="/" />}
          </label>
          <div className="ev-chips" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <Chip key={f.value} selected={filter === f.value} count={searching ? counts[f.value] : undefined} onClick={() => setFilter(f.value)}>
                {f.label}
              </Chip>
            ))}
          </div>
        </>
      )}
      {empty ? (
        <div className="ev-empty">
          <Mascot size={72} state="idle" />
          <Bubble tail="bottom">
            It’s quiet up here. {dictationHotkey === FN || !dictationHotkey
              ? <>Tap <Kbd keys="fn" /> and talk,</>
              : <>Hold <Kbd keys={dictationHotkey} /> and talk,</>} or drop something in below.
          </Bubble>
          <span className="ev-empty-pointer" aria-hidden />
        </div>
      ) : (
        <div ref={scrollRef} data-capture-history className="ev-scroll">
          {groups.map((group) => (
            <section key={group.label} className="ev-group" aria-label={group.label}>
              <h2 className="ev-gh">{group.label}</h2>
              {/* The toolbar shows a capture while it runs; it joins the list once it is written down. */}
              {group.items.map((rec) => (
                <div key={rec.id} className={rec.startedAt >= mountedAt ? 'ev-grow' : undefined}>
                  <CaptureRow rec={rec} query={query} signedIn={signedIn} onSignIn={onSignIn} flash={flash} runTask={runTask} />
                </div>
              ))}
            </section>
          ))}
          {searching && visible.length === 0 && (
            <p className="ev-empty-search">
              {query.trim() ? `No captures match “${query.trim()}”.` : 'Nothing here yet.'}
            </p>
          )}
        </div>
      )}
    </>
  );
}
