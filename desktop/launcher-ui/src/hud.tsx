import { StrictMode, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { AudioLines, Camera, Check, ChevronsUpDown, Clapperboard, Copy, History, Maximize2, Mic, MicOff, Minus, MousePointer2, MousePointerClick, Search, ShieldCheck, Square, SquareDashed, X } from 'lucide-react';
import { useLiveLines } from '@/components/launcher/use-live-lines';
import { Mascot, type MascotState } from '@/components/launcher/ui/mascot';
import { clock } from '@/components/launcher/history-model';
import { errMsg } from '@/lib/desktop/errors';
import { addCaption, EMPTY_RUNNING, runningText, type LiveCaption } from '@/lib/desktop/live-captions';
import { mergeTranscript } from '@/lib/desktop/live-edit';
import { learnedLabel, type LearningEvent } from '@/lib/desktop/learning';
import { DICTATION_STYLES, FOR_AGENTS_HINT, writingFrom, type DictationStyle, type Writing } from '@/lib/transcription/dictation-style';
import { prettyAccel } from '@/lib/launcher/accel';
import { clicksLabel, invoke, NO_MARKING, tauri, useEvent, useMarking, type MarkingState } from './marking';
import { HELD_PHASES, holdMs, type Receipt } from './hud-hold';
import { changeOutcome, needsRewrite, PLAIN, toneRow, type TonePick, type WrittenAs } from './hud-writing';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Phase = 'idle' | 'saved' | 'recording' | 'transcribing' | 'done' | 'failed';

interface HudState {
  phase: Phase;
  sessionId: string | null;
  mode: string | null;
  startedAtMs: number | null;
  message: string | null;
  /** Where the words went when they were not pasted ("Copied — …"). */
  notice?: string | null;
  /** What happened to a finished dictation's words, and whether it opens
   * straight into its drawer. Rust decides both, as it sizes the window. */
  receipt?: Receipt | null;
  opensItself?: boolean;
  /** The tone in force for a finished dictation's words, when the server said. */
  written?: WrittenAs | null;
}

/**
 * Raw errors from Rust that are written for logs, not people, and what the
 * control says instead. Anything else lower-case (Rust's own convention for
 * internal errors) or naming a missing command falls back to the action's copy.
 */
const ERROR_COPY: [RegExp, string][] = [
  [/no active capture with that id/i, 'That recording has already stopped'],
  [/could not create the paste key press/i, 'Couldn’t paste automatically'],
  [/pasting is only supported on macOS/i, 'Couldn’t paste here'],
  [/^Could not change the tone:/, 'Couldn’t change the tone. Try again?'],
  [/^Could not put the rewrite in place:/, 'Couldn’t put the rewrite in place'],
];

/** What the control says when an action fails: `errMsg`'s text, mapped to user copy. */
function hudError(error: unknown, fallback: string): string {
  const raw = errMsg(error, fallback).trim();
  for (const [pattern, copy] of ERROR_COPY) if (pattern.test(raw)) return copy;
  if (/^[a-z]/.test(raw) || /\bcommand\b.*\bnot found\b|::|os error|panicked/i.test(raw)) return fallback;
  return raw;
}

document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

/**
 * The control's shape in each phase, the same as `size_for` in hud.rs: the
 * window takes that size when the phase changes, and this lays it out.
 */
type Size = 'pill' | 'receipt' | 'bar' | 'wide' | 'result' | 'shot' | 'video';

/** How the control looks while recording, from Settings → App → Capture. */
type Look = { lines: 0 | 1 | 2 | 4; translucent: boolean };

const DEFAULT_LOOK: Look = { lines: 0, translucent: true };

/** How long Stop waits for a live correction to reach the app before stopping anyway. */
const LIVE_EDIT_WAIT_MS = 1500;
/** How long the pill confirms a word added to the dictionary. */
const LEARNED_MS = 4000;
/** A finished dictation's tone change: what it's rewritten from, what's picked, and where the rewrite went. */
interface ToneChange extends TonePick {
  sessionId: string;
  /** The words as pasted, which every rewrite starts from; null once typed over (the words as they are now). */
  base: string | null;
  busy: boolean;
  landed: 'replaced' | 'copied' | null;
}

/** Past this many characters (MAX_POLISH_CHARS on the server) words are too long to rewrite here. */
const MAX_REWRITE_CHARS = 20_000;

/** In the browser preview, rewrites of the sample words instead of a server round trip. */
const PREVIEW_REWRITES: Record<Exclude<DictationStyle, 'natural'>, string> = {
  professional: 'For the onboarding email, I suggest leading with the mascot, using one screenshot rather than three, and closing with the shortcut so that people try it immediately.',
  friendly: 'Ideas for the onboarding email: let’s lead with the mascot, keep it to one screenshot instead of three, and finish on the shortcut so people can try it right away!',
  concise: 'Onboarding email: lead with the mascot, one screenshot not three, end on the shortcut.',
};
const PREVIEW_FOR_AGENTS = 'Draft the onboarding email.\n\nLead with the mascot, use one screenshot rather than three, and end on the shortcut so people try it straight away.';

/** How long the pointer rests on a finished dictation before its drawer opens. */
const PEEK_DWELL_MS = 250;

/** Settles when `task` does (true), or after `ms` (false), whichever comes first. */
function within(task: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(false), ms);
    void task.catch(() => {}).finally(() => { window.clearTimeout(timer); resolve(true); });
  });
}

function lookFrom(value: unknown): Look {
  const raw = value as { hud_preview_lines?: unknown; hud_translucent?: unknown; lines?: unknown; translucent?: unknown } | null;
  const lines = raw?.hud_preview_lines ?? raw?.lines;
  const translucent = raw?.hud_translucent ?? raw?.translucent;
  return {
    lines: lines === 0 || lines === 1 || lines === 2 || lines === 4 ? lines : DEFAULT_LOOK.lines,
    translucent: typeof translucent === 'boolean' ? translucent : DEFAULT_LOOK.translucent,
  };
}

/** What the pill says happened to a finished dictation's words, or null when it isn't one. */
function receiptFor(state: HudState): Receipt | null {
  return state.phase === 'done' && state.message?.trim() ? state.receipt ?? null : null;
}

/** "16 words", for the Pasted stamp. */
function wordCount(text: string): string {
  const count = text.trim() ? text.trim().split(/\s+/).length : 0;
  return `${count.toLocaleString()} ${count === 1 ? 'word' : 'words'}`;
}

function sizeFor(state: HudState, lines: Look['lines'], peek: boolean): Size {
  const video = state.mode === 'video';
  switch (state.phase) {
    case 'idle':
      return 'pill';
    case 'saved':
      // A save that says why the words weren't typed has a line to read, as a failure does.
      return state.notice ? 'wide' : 'pill';
    case 'recording':
      if (video) return 'video';
      return lines === 0 ? 'bar' : 'wide';
    case 'transcribing':
      return video ? 'pill' : lines === 0 ? 'bar' : 'wide';
    case 'failed':
      return 'wide';
    case 'done':
      if (state.mode === 'image') return 'shot';
      if (video) return 'pill';
      if (state.message?.trim()) return peek ? 'result' : 'receipt';
      return state.notice ? 'wide' : 'pill';
  }
}

const PREVIEW_SIZES: Record<Size, [number, number]> = { pill: [216, 36], receipt: [248, 36], bar: [264, 40], wide: [400, 142], result: [400, 176], shot: [360, 172], video: [420, 76] };

function browserPreviewState(): HudState | null {
  if (tauri()) return null;
  const params = new URLSearchParams(window.location.search);
  const phase = (params.get('hud') ?? 'idle') as Phase;
  const mode = params.has('image') ? 'image' : params.has('video') ? 'video' : 'audio';
  return {
    phase,
    sessionId: params.has('opening') ? null : 'preview',
    mode,
    notice: params.get('notice'),
    // Rust's reading of a finished dictation (`hud::shown`), stood in for here.
    receipt: phase !== 'done' || mode !== 'audio' ? null : params.get('notice')?.includes('Accessibility') ? 'blocked' : params.has('notice') ? 'copied' : 'pasted',
    // The server's word on the tone (`?style=concise&forai`; `?plain` when the model didn't apply it, `?untold` when it didn't say).
    written: phase === 'done' && mode === 'audio' && !params.has('untold') ? { ...browserPreviewWriting() ?? PLAIN, projectId: params.get('project'), applied: !params.has('plain') } : null,
    opensItself: phase === 'done' && mode === 'audio' && !params.has('opening') && !params.has('receipt') && !params.get('notice')?.includes('Accessibility'),
    startedAtMs: Date.now() - 78_000,
    message: phase === 'done' && mode === 'audio'
      ? params.has('long')
        ? Array.from({ length: Number(params.get('long')) || 12 }, (_, i) => `Point ${i + 1}: lead with the mascot, keep one screenshot instead of three, and end on the shortcut so people try it straight away.`).join(' ')
        : 'Ideas for the onboarding email: lead with the mascot, keep one screenshot instead of three, and end on the shortcut so people try it straight away.'
      : phase === 'failed' ? 'No speech was heard' : null,
  };
}

/** In the browser preview, the account's dictation tone (`?style=concise&forai`). */
function browserPreviewWriting(): Writing | null {
  if (tauri()) return null;
  const params = new URLSearchParams(window.location.search);
  const writing = writingFrom({ style: params.get('style') ?? 'natural', forAgents: params.has('forai') }) ?? PLAIN;
  return { style: writing.style, forAgents: writing.forAgents };
}

function browserPreviewPeek(): string | null {
  return !tauri() && new URLSearchParams(window.location.search).has('peek') ? 'preview' : null;
}

function browserPreviewLearned(): { text: string; tone: 'leaf' } | null {
  if (tauri()) return null;
  const word = new URLSearchParams(window.location.search).get('learned');
  return word ? { text: learnedLabel({ status: 'saved', learned: 1, words: [{ from: word, to: word }] }) ?? word, tone: 'leaf' } : null;
}

function browserPreviewMarking(): MarkingState {
  if (tauri()) return NO_MARKING;
  const params = new URLSearchParams(window.location.search);
  const marks = Number(params.get('marks') ?? 0);
  return {
    sessionId: 'preview',
    clicks: Number(params.get('clicks') ?? 4),
    marks: Array.from({ length: marks }, (_, i) => ({ number: i + 1, rect: null })),
    tool: params.get('marking') === 'area' ? 'area' : params.has('marking') ? 'element' : null,
    shortcut: '⌥H',
  };
}

/** In the browser preview (`?words`), words heard so far; the app hears them through `useLiveLines`. */
function browserPreviewWords(): string {
  if (tauri() || !new URLSearchParams(window.location.search).has('words')) return '';
  return runningText(addCaption(EMPTY_RUNNING, {
    sessionId: 'preview',
    track: 'mic',
    text: 'so the plan is we ship on Thursday and ask Sam for the deck before the call',
    isFinal: false,
    startMs: 0,
    endMs: 4_000,
  }));
}
const PREVIEW_WORDS = browserPreviewWords();

/** How long an error on the idle pill stays before Talk comes back. */
const IDLE_ERROR_MS = 6000;

/**
 * Whether the mic is being heard during a screen recording, from
 * `recording:level` (every 100ms). The level lives in a ref and the flags are
 * read on the recording's 1s tick, so the level never re-renders the HUD.
 */
function useMicSignal(sessionId: string | null, active: boolean, now: number): { heard: boolean; silent: boolean } {
  const signal = useRef({ sessionId: null as string | null, rms: 0, at: 0 });
  useEvent('recording:level', (payload) => {
    if (!active) return;
    const value = payload as { sessionId: string; rms: number };
    if (value.sessionId === sessionId) signal.current = { sessionId, rms: value.rms, at: Date.now() };
  });
  const own = active && signal.current.sessionId === sessionId ? signal.current : { rms: 0, at: 0 };
  return { heard: now - own.at < 2000 && own.rms >= 0.002, silent: own.at > 0 && now - own.at > 5000 };
}

/**
 * The dictation shortcut and how the control looks. Both come from one
 * `get_settings` at start (retried while the app is still starting); after
 * that only `hud:look` changes the look, so a slow first read can't undo a
 * change made in Settings meanwhile. The shortcut is read again when the look
 * or the hotkeys change, never on hover.
 */
function useHudSettings(): { shortcut: string; look: Look } {
  const [shortcut, setShortcut] = useState('');
  const [look, setLook] = useState<Look>(() => {
    const params = new URLSearchParams(window.location.search);
    return tauri() ? DEFAULT_LOOK : lookFrom({ lines: params.has('lines') ? Number(params.get('lines')) : undefined, translucent: !params.has('solid') });
  });
  const lookChanged = useRef(false);
  const shortcutFrom = (settings: unknown) => {
    const accel = (settings as { dictation_hotkey?: string } | null)?.dictation_hotkey;
    setShortcut(accel ? prettyAccel(accel) : '');
  };
  const reloadShortcut = () => { void invoke('get_settings').then(shortcutFrom).catch(() => {}); };
  useEvent('hud:look', (payload) => { lookChanged.current = true; setLook(lookFrom(payload)); reloadShortcut(); });
  useEvent('hotkeys:changed', reloadShortcut);
  useEffect(() => {
    let disposed = false;
    const load = (attempt: number) => {
      void invoke('get_settings')
        .then((settings) => {
          if (disposed || !settings) return;
          shortcutFrom(settings);
          if (!lookChanged.current) setLook(lookFrom(settings));
        })
        .catch(() => { if (attempt < 4 && !disposed) window.setTimeout(() => load(attempt + 1), 500 * 2 ** attempt); });
    };
    if (tauri()) load(0);
    return () => { disposed = true; };
  }, []);
  return { shortcut, look };
}

/**
 * How dictations are written (Settings → Dictation on the account): the
 * drawer's tone row shows it as what is picked, and changes it. Read at
 * start (retried while the app is still starting), again whenever the
 * account or a project is changed from Settings or the row itself, and once
 * more for a finished dictation the server didn't say the tone of. A
 * finished dictation's own `written` outranks it where there is one.
 */
function useWriting(state: HudState | null): [Writing | null, (next: Writing | null) => void] {
  const [prefs, setPrefs] = useState<Writing | null>(browserPreviewWriting);
  const [reload, setReload] = useState(0);
  const untold = state?.phase === 'done' && state.mode === 'audio' && !!state.sessionId && !state.written ? state.sessionId : null;
  useEvent('account:changed', () => setReload((n) => n + 1));
  useEffect(() => {
    if (!tauri()) return;
    let disposed = false;
    const load = (attempt: number) => {
      void invoke('account_call', { method: 'GET', path: '/api/me', body: null })
        .then((me) => {
          if (disposed) return;
          const raw = me as { dictationStyle?: unknown; dictationForAgents?: unknown } | null;
          const writing = writingFrom({ style: raw?.dictationStyle ?? 'natural', forAgents: raw?.dictationForAgents });
          if (writing) setPrefs({ style: writing.style, forAgents: writing.forAgents });
        })
        .catch(() => { if (attempt < 4 && !disposed) window.setTimeout(() => load(attempt + 1), 500 * 2 ** attempt); });
    };
    // A second look, for a dictation, is one try: it's a fallback, not a startup.
    load(reload || untold ? 4 : 0);
    return () => { disposed = true; };
  }, [reload, untold]);
  return [prefs, setPrefs];
}

/**
 * A correction typed here or in the app the words went to reaches the
 * dictionary in the background: the control says so for a few seconds, in
 * leaf (or warn when it couldn't be saved).
 */
function useLearned(): { text: string; title?: string; tone: 'leaf' | 'warn' } | null {
  const [learned, setLearned] = useState<{ text: string; title?: string; tone: 'leaf' | 'warn' } | null>(browserPreviewLearned);
  useEvent('dictionary:learning', (payload) => {
    const event = payload as LearningEvent;
    const text = learnedLabel(event);
    if (text) setLearned({ text, title: 'Saved to your dictionary', tone: 'leaf' });
    else if (event.status === 'failed') setLearned({ text: 'Not saved to dictionary', title: event.message, tone: 'warn' });
  });
  useEffect(() => {
    if (!learned) return;
    const timer = window.setTimeout(() => setLearned(null), LEARNED_MS);
    return () => window.clearTimeout(timer);
  }, [learned]);
  return learned;
}

function Hud() {
  const [state, setState] = useState<HudState | null>(browserPreviewState);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { shortcut, look } = useHudSettings();
  // How lively the voice is right now, 0–1: a caption arriving lifts it, quiet lets it settle.
  const [voice, setVoice] = useState(0);
  const [copied, setCopied] = useState(false);
  const marking = useMarking(browserPreviewMarking());
  const [editing, setEditing] = useState(false);
  const [pointer, setPointer] = useState<'away' | 'over' | 'left'>('away');
  // The finished dictation whose transcript drawer is open: hovering its pill opens it.
  const [peek, setPeek] = useState<string | null>(browserPreviewPeek);
  const [tone, setTone] = useState<ToneChange | null>(null);
  const [prefs, setPrefs] = useWriting(state);
  const peekDwell = useRef<number | null>(null);
  // Bumped (at most once a second) while the pointer moves over the control.
  const [pointerMoved, setPointerMoved] = useState(0);
  const lastPointerMove = useRef(0);
  // When the pointer came over the control, so moving it can't hold a result forever.
  const overSince = useRef(0);
  const learned = useLearned();
  const collapseRef = useRef<(() => void) | null>(null);
  const [draft, setDraft] = useState<{ sessionId: string | null; source: string | null; text: string } | null>(null);
  const [saveRevision, setSaveRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // `learn: false` is a tone rewrite: saved as the transcript, never taught to the dictionary.
  type Edit = { sessionId: string; text: string; live?: boolean; learn?: boolean };
  const pendingEdit = useRef<Edit | null>(null);
  const latestEdit = useRef<Edit | null>(null);
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const flushEdit = (): Promise<boolean> => {
    const edit = pendingEdit.current;
    if (!edit) return saveQueue.current;
    pendingEdit.current = null;
    setSaving(true);
    setSaveError(null);
    const task = saveQueue.current.then(async () => {
      try {
        await liveUpdate.current.catch(() => {});
        await invoke('save_preview_transcript', edit);
        return true;
      } catch (error) {
        // Keep the latest correction available for retry; never silently dismiss it.
        if (latestEdit.current !== edit) return false;
        if (!pendingEdit.current) pendingEdit.current = edit;
        setSaveError(errMsg(error, 'Could not save transcript'));
        return false;
      }
    });
    saveQueue.current = task;
    void task.then(() => { if (saveQueue.current === task) { setSaving(false); setSaveRevision((revision) => revision + 1); } });
    return task;
  };
  useEffect(() => {
    if (!pendingEdit.current) return;
    const timer = window.setTimeout(() => { void flushEdit(); }, 350);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  // The Mac's own recognizer could not run for this recording: no live words.
  const [captionsOff, setCaptionsOff] = useState<string | null>(null);
  const retrySaveButton = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const selection = useRef({ start: 0, end: 0, direction: 'none' as 'forward' | 'backward' | 'none', scroll: 0 });
  type Selection = typeof selection.current;
  type UndoEntry = { source: string; text: string; selection: Selection };
  const editHistory = useRef<{ undo: UndoEntry[]; redo: UndoEntry[] }>({ undo: [], redo: [] });
  const typingGroup = useRef<{ source: string; end: number; at: number } | null>(null);
  const historyAction = useRef<(redo: boolean) => void>(() => {});
  const liveRevision = useRef(Date.now() * 1000);
  const nativeEditReady = useRef<Promise<void> | null>(null);
  const liveUpdate = useRef<Promise<unknown>>(Promise.resolve());
  const pendingLiveEdit = useRef<{ sessionId: string; source: string; text: string; revision: number } | null>(null);
  const [composition, setComposition] = useState<{ source: string; text: string } | null>(null);
  const lines = useLiveLines(state?.sessionId ?? null, Number.MAX_SAFE_INTEGER);
  const currentSession = useRef(state?.sessionId);
  currentSession.current = state?.sessionId;

  // hud:state subscribes before asking for the current state, so nothing
  // emitted in between is lost: it can't use `useEvent`, which hides when it
  // has registered.
  useEffect(() => {
    let disposed = false;
    let received = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const off = await tauri()?.event?.listen('hud:state', (e) => {
        received = true; setActionError(null); setState(e.payload as HudState);
      });
      if (disposed) { off?.(); return; }
      unlisten = off;
      const initial = await invoke('get_hud_state');
      if (!disposed && !received && initial) setState(initial as HudState);
    })().catch(() => setActionError('Status unavailable'));
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // The words themselves come through `useLiveLines`; a caption only lifts the voice bars here.
  useEvent('recording:caption', (payload) => {
    const caption = payload as LiveCaption;
    if (caption.sessionId === currentSession.current && caption.text.trim()) setVoice(1);
  });
  useEvent('recording:captions_status', (payload) => {
    const status = payload as { sessionId: string; live: boolean };
    setCaptionsOff(status.live ? null : status.sessionId);
  });

  // A stop hands the keyboard back to the user's app, so the paste lands
  // there; leaving the app does too. Either way this box is no longer typed in.
  // Rust already gave the keyboard back, so the blur this causes must not ask again.
  const releasedByRust = useRef(false);
  const releaseFromRust = () => {
    releasedByRust.current = true;
    try { editorRef.current?.blur(); } finally { releasedByRust.current = false; }
    setEditing(false);
  };
  useEvent('hud:release-editor', releaseFromRust);
  useEffect(() => {
    const release = () => { editorRef.current?.blur(); setEditing(false); };
    window.addEventListener('blur', release);
    return () => window.removeEventListener('blur', release);
  }, []);
  // Done editing in a finished dictation's drawer (blur, Esc, a tone, Copy):
  // hand the keyboard back to the app the words went to. An older app without
  // the command just keeps it, as before.
  const releaseEditor = (sessionId: string | null | undefined): Promise<void> => {
    if (!tauri() || !sessionId) return Promise.resolve();
    try {
      return invoke('release_preview_editor', { sessionId }).then(() => {}, () => {});
    } catch {
      return Promise.resolve();
    }
  };

  const live = state?.phase === 'recording' && !!state.sessionId;

  useEffect(() => {
    if (!live) { setVoice(0); return; }
    const id = window.setInterval(() => setVoice((v) => (v < 0.05 ? 0 : v * 0.72)), 140);
    return () => window.clearInterval(id);
  }, [live]);

  useEffect(() => {
    if (state?.phase !== 'recording') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state?.phase]);
  const mic = useMicSignal(state?.sessionId ?? null, live && state?.mode === 'video', now);

  // Errors show in the phase's own status slot, never in place of its controls.
  // The idle pill has no slot to spare, so there it stands in for the capture
  // buttons for a moment and Talk comes back.
  const act = (cmd: string, args?: Record<string, unknown>): Promise<boolean> => {
    setActionError(null);
    return invoke(cmd, args).then(() => true, (error: unknown) => {
      setActionError(hudError(error, 'Couldn’t do that. Try again?'));
      return false;
    });
  };
  const idleError = !!actionError && (!state || state.phase === 'idle');
  useEffect(() => {
    if (!idleError) return;
    const timer = window.setTimeout(() => setActionError(null), IDLE_ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [idleError, actionError]);

  // One stop per recording, even if Stop is clicked again while it waits. The
  // ref answers at once; the state only greys the button. A stop that worked
  // keeps it greyed until the HUD moves on; one that failed can be tried again.
  const stoppingRef = useRef<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const stopRecording = (sessionId: string | null | undefined) => {
    if (!sessionId || stoppingRef.current === sessionId) return;
    stoppingRef.current = sessionId;
    setStopping(sessionId);
    void within(liveUpdate.current, LIVE_EDIT_WAIT_MS)
      .then((settled) => {
        if (!settled) console.warn('Stopping before the last live correction reached the app');
        return act('stop_capture', { sessionId });
      })
      .then((stopped) => {
        if (stopped || stoppingRef.current !== sessionId) return;
        stoppingRef.current = null;
        setStopping(null);
      });
  };
  useEffect(() => {
    if (stoppingRef.current && (stoppingRef.current !== state?.sessionId || state?.phase !== 'recording')) {
      stoppingRef.current = null;
      setStopping(null);
    }
  }, [state?.sessionId, state?.phase]);

  const copy = (cmd: string, args: Record<string, unknown>) => {
    setActionError(null);
    void invoke(cmd, args)
      .then(() => setCopied(true))
      .catch((error: unknown) => setActionError(hudError(error, 'Couldn’t copy it')));
  };

  const readyToCapture = async (mode: 'audio' | 'video' | 'image'): Promise<boolean> => {
    const setup = (await invoke('get_setup_status')) as { completed?: boolean } | undefined;
    if (setup && !setup.completed) {
      await invoke('show_setup');
      return false;
    }
    const needsScreen = mode !== 'audio';
    const needsMic = mode !== 'image';
    const perms = (await invoke('check_permissions', { needScreen: needsScreen, prompt: true })) as
      | { mic: boolean; screen: boolean }
      | undefined;
    if (perms && ((needsMic && !perms.mic) || (needsScreen && !perms.screen))) {
      setActionError(needsMic && !perms.mic ? 'Microphone access is off' : 'Screen Recording access is off');
      await invoke('show_setup');
      return false;
    }
    return true;
  };

  const startRecording = async (mode: 'audio' | 'video' | 'image' = 'audio') => {
    if (starting) return;
    setStarting(true);
    setActionError(null);
    try {
      // The HUD's Talk is microphone only. Meetings start from the panel.
      if (!(await readyToCapture(mode))) return;
      if (mode === 'image') await invoke('capture_screenshot');
      else if (mode === 'video') await invoke('start_screen_capture', { mic: true });
      else await invoke('start_capture', { source: 'mic', dictation: true });
    }
    catch (error) {
      const message = hudError(error, mode === 'image' ? 'Could not take the screenshot' : 'Could not start recording');
      setActionError(message);
      void invoke('show_notice', { title: mode === 'image' ? "Eavesy couldn't take the screenshot" : "Eavesy couldn't start recording", body: message }).catch(() => {});
    }
    finally { setStarting(false); }
  };

  const screenshot = state?.phase === 'done' && state.mode === 'image' && !!state.sessionId;

  // One rewrite at a time, and only while its drawer is up. The ref is both
  // the busy guard (it answers at once, unlike the state) and the request's
  // token: dropping it (collapse, ×, Esc, a new recording) makes a rewrite
  // that comes back later change nothing in the user's app.
  const toneRequest = useRef<number | null>(null);
  const toneSeq = useRef(0);
  const toneBefore = useRef<ToneChange | null>(null);
  const cancelRestyle = () => {
    if (toneRequest.current === null) return;
    toneRequest.current = null;
    setTone((now) => now?.busy ? toneBefore.current : now);
  };

  useEffect(() => { setCopied(false); setEditing(false); setPointer('away'); cancelPeekDwell(); toneRequest.current = null; setTone(null); setComposition(null); nativeEditReady.current = null; if (!pendingEdit.current) setSaveError(null); pendingLiveEdit.current = null; editorRef.current?.blur(); editHistory.current = { undo: [], redo: [] }; typingGroup.current = null; }, [state?.sessionId]);

  useEffect(() => {
    setImageSrc(null);
    if (!screenshot || !state?.sessionId) return;
    let cancelled = false;
    void invoke('capture_media', { id: state.sessionId })
      .then((path) => {
        const src = typeof path === 'string' ? tauri()?.core?.convertFileSrc?.(path) ?? path : null;
        if (!cancelled) setImageSrc(src);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [screenshot, state?.sessionId]);

  const peeking = !!state?.sessionId && peek === state.sessionId;
  // Words being corrected, or a correction that didn't save, keep the drawer
  // open: folding them into a stamp would hide the editor or the Retry.
  const ownTone = tone && tone.sessionId === state?.sessionId ? tone : null;
  const keepDrawer = !!state?.sessionId && (editing || saving || !!saveError || !!ownTone?.busy);
  // With the words shown after dictation (the default), a pasted or copied
  // dictation opens straight into its drawer; Not pasted keeps its Allow pill.
  const finished = state ? receiptFor(state) : null;
  const opensItself = !!state?.opensItself && finished !== null;
  const size = state ? sizeFor(state, look.lines, peeking || keepDrawer || opensItself) : 'pill';
  // Otherwise, until its drawer is opened, a finished dictation is just a stamp on the pill.
  const receipt = state && !peeking && !keepDrawer && !opensItself ? finished : null;

  useEffect(() => {
    if (!state || editing || saving || saveError || ownTone?.busy || pendingEdit.current || !HELD_PHASES.includes(state.phase)) return;
    const hold = holdMs(state.phase, pointer, overSince.current, Date.now(), receipt, state.phase === 'saved' && !!state.notice);
    if (hold === null) return;
    const sessionId = state.sessionId;
    const timeout = window.setTimeout(() => {
      if (tauri()) void invoke('dismiss_hud', { sessionId }).catch(() => {});
      else setState({ ...state, phase: 'idle', message: null, notice: null });
    }, hold);
    return () => window.clearTimeout(timeout);
  }, [state?.phase, state?.sessionId, pointer, pointerMoved, editing, saving, saveError, draft, saveRevision, receipt, ownTone?.busy]);

  const cancelPeekDwell = () => {
    if (peekDwell.current !== null) window.clearTimeout(peekDwell.current);
    peekDwell.current = null;
  };
  useEffect(() => cancelPeekDwell, []);
  // The window takes the drawer's size first, so the words never render squeezed into the pill.
  const showDrawer = (sessionId: string) => invoke('peek_hud', { sessionId, open: true }).catch(() => {}).finally(() => {
    if (currentSession.current === sessionId) setPeek(sessionId);
  });
  const openPeek = () => {
    const sessionId = state?.sessionId;
    if (!sessionId || peekDwell.current !== null) return;
    peekDwell.current = window.setTimeout(() => { peekDwell.current = null; void showDrawer(sessionId); }, PEEK_DWELL_MS);
  };
  // Words being edited keep their drawer, and Rust has to know that before it
  // sizes the next phase: tell it as soon as they are (even live, while
  // recording), so Done arrives already sized as the drawer.
  const editingLiveWords = !!state?.sessionId && state.mode !== 'video' && (state.phase === 'recording' || state.phase === 'transcribing')
    && editing && draft?.sessionId === state.sessionId;
  const pinDrawer = editingLiveWords || (keepDrawer && state?.phase === 'done' && !!receiptFor(state));
  useEffect(() => {
    if (pinDrawer && !peeking && state?.sessionId) void showDrawer(state.sessionId);
  }, [pinDrawer, peeking, state?.sessionId]);

  // Once the new shape is on screen, let the native shadow take it: at the
  // second frame (the first lays it out, the second has painted it), and
  // again a moment later in case frames are stalled or a slow resize landed
  // after them. Recomputing the shadow twice is harmless; too early is not.
  const phaseKey = state ? `${isOpening(state) ? 'starting' : state.phase}:${size}` : '';
  const shape = phaseKey && `${phaseKey}:${look.lines}`;
  useEffect(() => {
    if (!tauri() || !shape) return;
    const send = () => { void invoke('hud_painted').catch(() => {}); };
    let second = 0;
    const first = window.requestAnimationFrame(() => { second = window.requestAnimationFrame(send); });
    const settled = window.setTimeout(send, 500);
    return () => { window.cancelAnimationFrame(first); window.cancelAnimationFrame(second); window.clearTimeout(settled); };
  }, [shape]);
  // Alternating `swap` restarts the content's fade-in on every change of
  // phase (not of line count mid-recording). Set before paint.
  const [swap, setSwap] = useState(0);
  useLayoutEffect(() => { if (phaseKey) setSwap((n) => n + 1); }, [phaseKey]);

  // In a browser the page stands in for the window: give it the window's size.
  useEffect(() => {
    if (tauri()) return;
    const live = state?.phase === 'recording' || state?.phase === 'transcribing';
    // Same as `live_size` in hud.rs.
    const [width, height] = size === 'wide' && live ? [400, 62 + 20 * look.lines] : PREVIEW_SIZES[size];
    const root = document.getElementById('root');
    if (root) Object.assign(root.style, { width: `${width}px`, height: `${height}px`, margin: '28px auto 0' });
    document.body.style.background = 'linear-gradient(160deg, #e9e4dc, #cfd6dd)';
    document.body.style.minHeight = '100vh';
  }, [size, look.lines, state?.phase]);

  const snapshotWords = lines.map((line) => line.text).join(' ');
  const heard = snapshotWords || PREVIEW_WORDS;
  const source = state?.phase === 'done' ? state.message?.trim() || heard : heard;
  const ownDraft = draft?.sessionId === state?.sessionId ? draft : null;
  const words = useMemo(() => ownDraft ? ownDraft.source === null ? ownDraft.text : mergeTranscript({ source: ownDraft.source, text: ownDraft.text }, source) : source, [ownDraft, source]);

  // Live words follow the newest; a finished dictation in the drawer reads from its start.
  const reading = state?.phase === 'done';
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (document.activeElement === editor) {
      const saved = selection.current;
      editor.setSelectionRange(saved.start, saved.end, saved.direction);
      editor.scrollTop = saved.scroll;
    } else editor.scrollTop = reading ? 0 : editor.scrollHeight;
    markMore(editor);
  }, [words, state?.sessionId, reading, peek]);

  useEffect(() => {
    const handle = (event: InputEvent) => {
      if (event.isComposing || event.target !== editorRef.current || !['historyUndo', 'historyRedo'].includes(event.inputType)) return;
      event.preventDefault(); historyAction.current(event.inputType === 'historyRedo');
    };
    document.addEventListener('beforeinput', handle);
    return () => document.removeEventListener('beforeinput', handle);
  }, []);

  // A live draft cannot be written to history until capture registers its
  // recording folder. Flush the full merged result when capture completes.
  useEffect(() => {
    if (composition || state?.phase !== 'done' || !state.sessionId || !ownDraft || ownDraft.source === null) return;
    const edit = { sessionId: state.sessionId, text: words, live: true };
    latestEdit.current = edit; pendingEdit.current = edit;
    setDraft({ ...edit, source: null });
  }, [state?.phase, state?.sessionId, ownDraft, words, composition]);

  // Esc collapses a finished result to the pill; inside the editor it only leaves the editor.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      collapseRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!state) return null;

  const opening = isOpening(state);
  const video = state.mode === 'video';
  const editable = !!source || !!ownDraft;
  const notice = state.notice ?? null;
  const notPasted = !!notice?.includes('Accessibility');
  const busy = starting || state.phase === 'transcribing';
  const kbd = shortcut ? ` (${shortcut})` : '';
  const learnedStamp = learned && <Stamp tone={learned.tone} fit title={learned.title}>{learned.text}</Stamp>;

  const pressSurface = (e: MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, textarea')) return;
    const origin = { x: e.screenX, y: e.screenY };
    const cleanup = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    const move = (ev: globalThis.MouseEvent) => {
      if (Math.hypot(ev.screenX - origin.x, ev.screenY - origin.y) < 4) return;
      cleanup();
      void invoke('plugin:window|start_dragging', { label: 'hud' }).catch(() => {});
    };
    const up = () => {
      cleanup();
      act('show_launcher');
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const mark = (
    <button type="button" onClick={() => act('show_launcher')} aria-label="Open Eavesy" title="Open Eavesy" className="ctl-mark">
      <Mascot size={20} detail="medium" state={opening ? 'idle' : mascotState(state.phase)} level={voice} recording={live} />
    </button>
  );
  const hide = () => {
    cancelRestyle();
    void flushEdit()
      .then((saved) => saved ? invoke('dismiss_hud', { sessionId: state.sessionId }).then(() => invoke('close_hud')) : window.requestAnimationFrame(() => retrySaveButton.current?.focus()))
      .catch((error) => setActionError(hudError(error, 'Couldn’t hide it')));
  };
  const close = (
    <button type="button" onClick={hide} aria-label="Hide Eavesy" title="Hide Eavesy (reopen it from the menu bar)" className="ctl-btn ctl-icon"><X className="h-3.5 w-3.5" /></button>
  );
  const collapse = () => {
    cancelRestyle();
    void flushEdit()
      .then((saved) => {
        if (!saved) return window.requestAnimationFrame(() => retrySaveButton.current?.focus());
        if (tauri()) return invoke('dismiss_hud', { sessionId: state.sessionId });
        setState({ ...state, phase: 'idle', message: null, notice: null });
      })
      .catch((error) => setActionError(hudError(error, 'Couldn’t put it away')));
  };
  collapseRef.current = ['done', 'saved', 'failed'].includes(state.phase) ? collapse : null;
  const minimize = (
    <button type="button" onClick={collapse} aria-label="Collapse to the pill" title="Collapse to the pill (esc)" className="ctl-btn ctl-icon"><Minus className="h-3.5 w-3.5" /></button>
  );
  const history = (
    <button type="button" onClick={() => act('show_launcher')} aria-label="Open capture history" title="Capture history" className="ctl-btn ctl-icon"><History className="h-3.5 w-3.5" /></button>
  );
  const copyWords = (
    <button type="button" className="ctl-btn" onClick={() => { copy('copy_text', { text: words }); if (state.phase === 'done') void releaseEditor(state.sessionId); }}>{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy'}</button>
  );

  const prepareNativeEditor = (sessionId: string) => {
    const ready = invoke('focus_preview_editor', { sessionId }).then(revision => {
      if (currentSession.current === sessionId && typeof revision === 'number') liveRevision.current = Math.max(liveRevision.current, revision);
    });
    nativeEditReady.current = ready;
    void ready.catch(error => {
      // A transient focus failure must not poison every subsequent edit. Retry
      // initialization on the next keystroke or explicit Retry save.
      if (nativeEditReady.current === ready) nativeEditReady.current = null;
      if (currentSession.current === sessionId && pendingLiveEdit.current) setSaveError(errMsg(error, 'Could not focus transcript editor'));
    });
    return ready;
  };
  const sendLiveEdit = () => {
    if (!pendingLiveEdit.current || pendingLiveEdit.current.sessionId !== currentSession.current) return;
    const edit = { ...pendingLiveEdit.current };
    const sessionId = edit.sessionId;
    const ready = nativeEditReady.current ?? prepareNativeEditor(sessionId);
    const update = ready.then(() => {
      if (currentSession.current !== sessionId) return;
      edit.revision = ++liveRevision.current;
      return invoke('update_live_preview_edit', edit);
    });
    const task = Promise.all([liveUpdate.current.catch(() => {}), update]).then(() => {});
    liveUpdate.current = task;
    void task.then(() => { if (currentSession.current === sessionId && liveUpdate.current === task) setSaveError(null); }, error => {
      if (currentSession.current === sessionId && liveUpdate.current === task) setSaveError(errMsg(error, 'Could not keep live correction'));
    });
  };
  const changeText = (text: string, base = source, record = true, before = selection.current, inputType?: string) => {
    if (!state.sessionId) return;
    // Typed over a rewrite: that's now the words, and the next tone starts
    // from them. The row keeps showing the tone picked.
    if (ownTone && !ownTone.busy && ownTone.base !== null) setTone({ ...ownTone, base: null, landed: null });
    if (record) {
      const typed = inputType === 'insertText' && before.start === before.end && text.length === words.length + 1;
      const group = typingGroup.current;
      if (!typed || !group || group.source !== source || group.end !== before.end || Date.now() - group.at > 700) {
        editHistory.current.undo.push({ source, text: words, selection: { ...before } });
        if (editHistory.current.undo.length > 200) editHistory.current.undo.shift();
      }
      typingGroup.current = typed ? { source, end: selection.current.end, at: Date.now() } : null;
      editHistory.current.redo = [];
    }
    const editingLive = state.phase === 'recording' || state.phase === 'transcribing';
    setDraft({ sessionId: state.sessionId, source: editingLive ? base : null, text });
    if (editingLive) {
      // Send immediately, before a global Stop can begin its final paste.
      pendingLiveEdit.current = { sessionId: state.sessionId, source: base, text, revision: ++liveRevision.current };
      sendLiveEdit();
    } else {
      const edit = { sessionId: state.sessionId, text };
      latestEdit.current = edit; pendingEdit.current = edit;
    }
    setCopied(false);
  };
  historyAction.current = redo => {
    const from = redo ? editHistory.current.redo : editHistory.current.undo;
    const to = redo ? editHistory.current.undo : editHistory.current.redo;
    const entry = from.pop();
    if (!entry) return;
    to.push({ source, text: words, selection: { ...selection.current } });
    typingGroup.current = null;
    selection.current = entry.selection;
    changeText(mergeTranscript(entry, source), source, false);
  };
  const rememberSelection = (editor: HTMLTextAreaElement) => {
    selection.current = { start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection, scroll: editor.scrollTop };
  };
  // The editor only draws where the window was sized for words (never into a
  // 36–40px pill, bar or receipt).
  const roomForWords = size === 'wide' || size === 'result';
  const transcriptEditor = (hint?: string) => roomForWords && <textarea
    onScrollCapture={(event) => markMore(event.currentTarget)}
    ref={editorRef}
    aria-label="Edit transcript preview"
    className="ctl-words ctl-editor"
    value={composition?.text ?? words}
    placeholder={hint}
    spellCheck
    readOnly={!state.sessionId || !!ownTone?.busy}
    onFocus={() => {
      if (!state.sessionId) return;
      setEditing(true);
      void prepareNativeEditor(state.sessionId);
    }}
    onBlur={() => {
      setEditing(false);
      if (state.phase !== 'done') return;
      void flushEdit();
      // Esc, or a click elsewhere in the control, hands the keyboard back to
      // the app. Not when another app took it (the window lost focus) or when
      // Rust released the editor itself: that would pull the user back.
      if (releasedByRust.current) return;
      const sessionId = state.sessionId;
      window.setTimeout(() => { if (document.hasFocus() && editorRef.current !== document.activeElement) void releaseEditor(sessionId); }, 0);
    }}
    onSelect={event => rememberSelection(event.currentTarget)}
    onScroll={event => { selection.current.scroll = event.currentTarget.scrollTop; }}
    onChange={event => {
      const before = selection.current;
      rememberSelection(event.currentTarget);
      if (composition) setComposition({ ...composition, text: event.target.value });
      else changeText(event.target.value, source, true, before, (event.nativeEvent as InputEvent).inputType);
    }}
    onCompositionStart={event => setComposition({ source, text: event.currentTarget.value })}
    onCompositionEnd={event => {
      rememberSelection(event.currentTarget);
      changeText(mergeTranscript({ source: composition?.source ?? source, text: event.currentTarget.value }, source));
      setComposition(null);
    }}
    onKeyDown={event => {
      if (!event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); historyAction.current(event.shiftKey || event.key.toLowerCase() === 'y'); return;
      }
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); } }}
  />;

  // The tone row is the dictation setting itself (Settings → Dictation): a
  // change is kept first, for every dictation to come, then this one is
  // rewritten to match. The rewrite starts from the words as pasted (so
  // tones don't compound; picking the tone they were written in puts them
  // back without asking the server), goes where the words went, and is
  // saved as the transcript without teaching the dictionary: a rewrite isn't
  // a correction.
  const row = toneRow(state.written, prefs, ownTone);
  const picked = row.picked;
  // Kept on the account, or on the project when the tone is the project's own.
  const keep = async (next: Writing): Promise<{ ok: boolean; error?: unknown }> => {
    const project = state.written?.projectId ?? null;
    const before = prefs;
    if (!project) setPrefs(next);
    if (!tauri()) return { ok: true };
    try {
      await invoke('account_call', { method: 'PATCH', path: project ? `/api/projects/${project}` : '/api/me', body: { dictationStyle: next.style, dictationForAgents: next.forAgents } });
      return { ok: true };
    } catch (error) {
      if (!project) setPrefs(before);
      return { ok: false, error };
    }
  };
  const change = async (next: Writing) => {
    const sessionId = state.sessionId;
    const todo = needsRewrite(next, row);
    if (!sessionId || toneRequest.current !== null || todo === 'none') return;
    setActionError(null);
    const token = ++toneSeq.current;
    toneRequest.current = token;
    const wanted = () => toneRequest.current === token && currentSession.current === sessionId;
    const base = ownTone?.base ?? words;
    toneBefore.current = ownTone;
    setTone({ sessionId, base, from: row.from, pick: next.style, forAgents: next.forAgents, busy: true, landed: null });
    // Once the tone is kept it is the setting, whatever happens to this
    // dictation's words after: a drawer put away mid-change (cancelRestyle
    // reverted the row to the old tone) still shows what was saved, over
    // words that are in whatever tone they were (`from`) or just landed.
    const settled = (landed: 'replaced' | 'copied' | null) => setTone((now) =>
      currentSession.current === sessionId ? { sessionId, base, from: row.from, pick: next.style, forAgents: next.forAgents, busy: false, landed } : now);
    let kept = false;
    try {
      let text = '';
      let landed: 'replaced' | 'copied' = 'copied';
      try {
        kept = (await keep(next)).ok;
        if (!kept) throw new Error('not kept');
        if (!wanted()) { settled(null); return; }
        // The rewrite goes where the words went, so that app needs the keyboard back first.
        const released = releaseEditor(sessionId);
        text = todo === 'restore' ? base
          : !tauri() ? (next.forAgents ? PREVIEW_FOR_AGENTS : next.style === 'natural' ? base : PREVIEW_REWRITES[next.style])
          : String(await invoke('restyle_dictation', { sessionId, text: base, style: next.style, forAgents: next.forAgents }));
        await within(released, 500);
        if (!wanted()) { settled(null); return; }
        landed = tauri() ? (await invoke('replace_dictation', { sessionId, text })) === 'replaced' ? 'replaced' : 'copied' : 'replaced';
      } catch (error) {
        // Keeping, the rewrite or putting it in place failed: the words are as they were.
        if (!wanted()) { if (kept) settled(null); return; }
        const outcome = changeOutcome(kept, false);
        setTone((now) => now?.sessionId === sessionId ? outcome.revert ? toneBefore.current : { ...now, busy: false, landed: null } : now);
        setActionError(kept ? outcome.say : hudError(error, outcome.say ?? ''));
        return;
      }
      // The words are in the app now. What follows is bookkeeping, outside
      // that catch so that nothing here is ever reported as a failed rewrite
      // (a save failure shows Retry save on its own; anything else leaves
      // the row settled with the words as they are, through the finally).
      // Saved through the same queue as a typed correction, so an older
      // unsaved edit can't land on top of the rewrite, and even if the
      // drawer was put away meanwhile: history keeps what's in the app.
      const edit: Edit = { sessionId, text, learn: false };
      latestEdit.current = edit; pendingEdit.current = edit;
      void flushEdit();
      if (!wanted()) { settled(landed); return; }
      setDraft({ sessionId, source: null, text });
      setCopied(false);
      setTone((now) => now?.sessionId === sessionId ? { ...now, busy: false, landed } : now);
    } finally {
      if (toneRequest.current === token) toneRequest.current = null;
      // However it ended, this dictation's row is no longer rewriting.
      setTone((now) => now?.sessionId === sessionId && now.busy ? { ...now, busy: false } : now);
    }
  };
  const tooLong = words.length > MAX_REWRITE_CHARS;
  const toneControls = !!state.sessionId && (tooLong ? (
    <div className="ctl-tones">
      <span className="ctl-say ctl-quiet">Too long to change the tone here</span>
      <span className="ctl-fill" />
      <button type="button" className="ctl-tone" onClick={() => act('show_launcher')}>Open in Eavesy</button>
    </div>
  ) : (
    <div className="ctl-tones" role="group" aria-label="How dictations are written">
      <label className="ctl-field" title={`${DICTATION_STYLES.find((style) => style.id === picked.style)?.hint ?? ''} Your tone for every dictation.`}>
        <span>Tone</span>
        <span className="ctl-select">
          <select aria-label="Dictation tone" value={picked.style} disabled={!!ownTone?.busy} onChange={(event) => void change({ ...picked, style: event.target.value as DictationStyle })}>
            {DICTATION_STYLES.map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}
          </select>
          <ChevronsUpDown className="ctl-select-icon" aria-hidden />
        </span>
      </label>
      <span className="ctl-sep" aria-hidden />
      <button type="button" role="switch" aria-checked={picked.forAgents} disabled={!!ownTone?.busy} className="ctl-switch-row" title={FOR_AGENTS_HINT}
        onClick={() => void change({ ...picked, forAgents: !picked.forAgents })}>
        For AI<span className="ctl-switch" aria-hidden />
      </button>
      <span className="ctl-fill" />
      <span className="ctl-say ctl-quiet ctl-tones-note" title="What you pick here is your default: every dictation from now on is written this way, and this one is rewritten to match.">Sets your default</span>
    </div>
  ));
  const toneStamp = ownTone?.busy ? <span className="ctl-say ctl-quiet">Rewriting<span className="ctl-dots" aria-hidden><i /><i /><i /></span></span>
    : ownTone?.landed === 'replaced' ? <Stamp tone="leaf">Updated</Stamp>
    : ownTone?.landed === 'copied' ? <><Stamp tone="manila">Copied</Stamp><span className="ctl-say ctl-quiet">⌘V to paste</span></>
    : null;

  let top: ReactNode;
  let below: ReactNode = null;
  let foot: ReactNode = null;
  // A failed action says so where the phase says how it's going (the voice
  // bars, "Writing it down", the stamp), and every control stays.
  const errorSay = actionError ? <span role="alert" title={actionError} className="ctl-say ctl-warn">{actionError}</span> : null;

  if (state.phase === 'recording') {
    top = (
      <>
        {mark}
        {opening ? (!video && errorSay) || <span className="ctl-say ctl-quiet ctl-breathe">Starting…</span> : (
          <>
            <span className="ctl-rec" aria-hidden />
            <span className="ctl-timer">{clock(Math.max(0, Math.floor((now - (state.startedAtMs ?? now)) / 1000)))}</span>
            {video && marking.tool ? null : video ? <MicState heard={mic.heard} silent={mic.silent} /> : errorSay ?? <VoiceBars level={voice} />}
          </>
        )}
        {video && !opening && <Marking state={marking} act={act} />}
        <span className="ctl-fill" />
        <button type="button" disabled={opening || !state.sessionId || stopping === state.sessionId} onClick={() => stopRecording(state.sessionId)} aria-label={`Stop${kbd}`} title={`Stop${video ? ' and save recording' : ' and paste'}${kbd}`} className="ctl-btn ctl-stop"><Square className="h-2.5 w-2.5" fill="currentColor" />Stop</button>
      </>
    );
    const noLiveWords = !!state.sessionId && captionsOff === state.sessionId;
    const doneHint = shortcut ? `tap ${shortcut} to paste` : 'press Stop to paste';
    if (video) below = <div className="ctl-video-help">
      {!opening && !marking.tool && !actionError && <span className="ctl-video-count" title="Clicks are saved automatically. Highlights are tags you added."><MousePointerClick className="h-3 w-3" />{clicksLabel(marking.clicks)}{marking.marks.length > 0 ? ` · ${marking.marks.length} tags` : ''}</span>}
      <span role={actionError ? 'alert' : 'status'} className={actionError ? 'ctl-warn' : undefined} title={actionError ?? undefined}>
        {actionError ?? (opening ? 'Allow screen and microphone access to begin.' : marking.tool === 'element' ? 'Point, then click to tag. Area lets you drag a box.' : marking.tool === 'area' ? 'Drag a box to tag a region. Narration stays on.' : 'Screen + mic are recording. Highlight → drag a box.')}
      </span>
      {actionError ? <button className="ctl-btn" onClick={() => setActionError(null)}>Dismiss</button> : marking.tool && <button className="ctl-btn" onClick={() => act('stop_marking')}>Done · esc</button>}
    </div>;
    if (!video && look.lines) below = transcriptEditor(opening ? 'Opening the mic…' : noLiveWords ? `Live words are off on this Mac. Talk, then ${doneHint}` : `Listening… ${doneHint}`);
  } else if (state.phase === 'transcribing') {
    top = <>{mark}{errorSay ?? <span className="ctl-say">{video ? 'Saving' : 'Writing it down'}<span className="ctl-dots" aria-hidden><i /><i /><i /></span></span>}<span className="ctl-fill" /></>;
    if (!video && look.lines) below = transcriptEditor('Turning your words into text…');
  } else if (state.phase === 'done' && video) {
    top = <>{mark}{errorSay ?? <span className="ctl-say ctl-quiet" title={notice ?? undefined}>{copied ? 'Copied' : 'Saved'}</span>}
      <span className="ctl-fill" />
      <button type="button" className="ctl-btn" onClick={() => act('show_launcher')} aria-label="Open recording"><Maximize2 className="h-3.5 w-3.5" /></button>
      <button type="button" className="ctl-btn" onClick={() => copy('copy_capture_media', { id: state.sessionId })}><Copy className="h-3.5 w-3.5" />Copy</button>{minimize}{close}</>;
  } else if (state.phase === 'done' && state.mode === 'image') {
    top = (
      <>
        {mark}
        {errorSay ?? <Stamp tone="manila">{copied ? 'Copied' : 'Snapped'}</Stamp>}
        <span className="ctl-fill" />
        <button type="button" className="ctl-btn" onClick={() => act('show_launcher')}><Maximize2 className="h-3.5 w-3.5" />Open</button>
        <button type="button" className="ctl-btn" onClick={() => copy('copy_capture_media', { id: state.sessionId })}><Copy className="h-3.5 w-3.5" />Copy</button>
        {minimize}
        {close}
      </>
    );
    below = (
      <button type="button" className="ctl-shot" onClick={() => act('show_launcher')} aria-label="Open the screenshot" title="Open the screenshot">
        {imageSrc ? <img src={imageSrc} alt="" draggable={false} /> : <span className="ctl-shot-wait" />}
      </button>
    );
  } else if (receipt) {
    // The words are already where they went: say so on the pill, and keep them one hover away.
    const stamp = receipt === 'blocked' ? <Stamp tone="warn">Not pasted</Stamp>
      : receipt === 'copied' ? <><Stamp tone="manila">Copied</Stamp><span className="ctl-say ctl-quiet">⌘V to paste</span></>
      : <Stamp tone="leaf">Pasted<span className="ctl-stamp-sub"> · {wordCount(words)}</span></Stamp>;
    top = (
      <>
        {mark}
        {errorSay ?? learnedStamp ?? stamp}
        <span className="ctl-fill" />
        {receipt === 'blocked' && <button type="button" className="ctl-btn" onClick={() => act('open_privacy_settings', { pane: 'accessibility' })}><ShieldCheck className="h-3.5 w-3.5" />Allow</button>}
        {receipt === 'blocked' && minimize}
      </>
    );
  } else if (state.phase === 'done' && (size === 'wide' || size === 'result')) {
    const stamp = learnedStamp ?? (notPasted ? <Stamp tone="warn">Not pasted</Stamp> : notice ? <Stamp tone="manila">Copied</Stamp> : <Stamp tone="leaf">Pasted<span className="ctl-stamp-sub"> · {wordCount(words)}</span></Stamp>);
    // A rewrite's own stamp outranks the save it starts, so "Updated" doesn't flicker through "Saving…".
    const status = saveError ? <span role="alert"><span className="ctl-say ctl-warn">Save failed </span><button ref={retrySaveButton} className="ctl-btn ctl-warn" title={saveError} onClick={() => void flushEdit()}>Retry save</button></span>
      : errorSay ?? toneStamp ?? (saving ? <span className="ctl-say ctl-quiet">Saving…</span> : stamp);
    top = (
      <>
        {mark}
        {status}
        {notice && !notPasted && !learnedStamp && !toneStamp && !errorSay && <span className="ctl-say ctl-quiet">⌘V to paste</span>}
        <span className="ctl-fill" />
        {notPasted && <button type="button" className="ctl-btn" onClick={() => act('open_privacy_settings', { pane: 'accessibility' })}><ShieldCheck className="h-3.5 w-3.5" />Allow</button>}
        {size === 'result' && <button type="button" className="ctl-btn ctl-icon" onClick={() => act('show_launcher')} aria-label="Open in Eavesy" title="Open in Eavesy, with the whole transcript"><Maximize2 className="h-3.5 w-3.5" /></button>}
        {words && copyWords}
        {minimize}
        {close}
      </>
    );
    below = editable ? transcriptEditor() : <p className="ctl-line ctl-quiet" title={notice ?? undefined}>{notice}</p>;
    if (size === 'result' && editable) foot = toneControls;
  } else if (state.phase === 'saved' && notice) {
    // Saved, but not typed where the cursor was: say so, and why, never a plain "Saved".
    top = <>{mark}{errorSay ?? learnedStamp ?? <Stamp tone="warn" title={notice}>Not typed</Stamp>}<span className="ctl-fill" />{history}{minimize}{close}</>;
    below = <p className="ctl-line" title={notice}>{notice}</p>;
  } else if (learnedStamp && !errorSay && ['idle', 'saved', 'done'].includes(state.phase)) {
    // Briefly, the whole pill is the confirmation: a word fits where Close was.
    top = <>{mark}{learnedStamp}<span className="ctl-fill" /></>;
  } else if (state.phase === 'done' || state.phase === 'saved') {
    top = <>{mark}{errorSay ?? <Stamp tone="manila">Saved</Stamp>}<span className="ctl-fill" />{history}{minimize}{close}</>;
  } else if (state.phase === 'failed') {
    // A raw error isn't proof nothing was saved (the words may already be pasted): stay neutral.
    const why = state.message ? hudError(state.message, 'Something went wrong. Try again?') : 'Nothing was saved. Try again?';
    top = <>{mark}<span className="ctl-say ctl-warn">Didn’t catch that</span><span className="ctl-fill" />{history}{minimize}{close}</>;
    below = errorSay ? <p role="alert" className="ctl-line ctl-warn" title={actionError ?? undefined}>{actionError}</p> : <p className="ctl-line ctl-quiet" title={why}>{why}</p>;
  } else if (errorSay) {
    // Idle has no status slot: the error stands in for the capture buttons until it clears.
    top = <>{mark}{errorSay}<span className="ctl-fill" />{close}</>;
  } else {
    top = (
      <>
        {mark}
        <button type="button" disabled={busy} onClick={() => void startRecording()} aria-label={`Talk${kbd}`} title={`Talk, then paste where your cursor is${kbd}`} className="ctl-btn ctl-talk">
          <AudioLines className="h-3.5 w-3.5" />Talk{shortcut && <kbd className="ctl-kbd">{shortcut}</kbd>}
        </button>
        <button type="button" disabled={busy} onClick={() => void startRecording('image')} aria-label="Take screenshot" title="Take screenshot" className="ctl-btn ctl-icon"><Camera className="h-3.5 w-3.5" /></button>
        <button type="button" disabled={busy} onClick={() => void startRecording('video')} aria-label="Record screen video" title="Record your screen and mic" className="ctl-btn ctl-icon"><Clapperboard className="h-3.5 w-3.5" /></button>
        <span className="ctl-fill" />
        {close}
      </>
    );
  }

  if (saveError && ['recording', 'transcribing'].includes(state.phase)) {
    top = <>{top}<button type="button" className="ctl-btn ctl-warn" title={saveError} onClick={sendLiveEdit}>Retry save</button></>;
  }

  return (
    <div
      aria-label={live ? 'Eavesy recording' : 'Eavesy'}
      data-phase={opening ? 'starting' : state.phase}
      data-size={size}
      data-swap={swap % 2 ? 'a' : 'b'}
      data-marking={video && live && marking.tool ? 'true' : undefined}
      data-translucent={(look.translucent && !video) || undefined}
      style={state.phase === 'recording' || state.phase === 'transcribing' ? { '--ctl-lines': look.lines } as CSSProperties : undefined}
      onMouseDown={pressSurface}
      onMouseEnter={(event) => { if (pointer !== 'over') overSince.current = Date.now(); setPointer('over'); if (receipt && !(event.target as HTMLElement).closest('button')) openPeek(); }}
      onMouseMove={(event) => {
        // Resting on a button (Allow, collapse) is aiming at it, not asking for the words.
        if (receipt) { if ((event.target as HTMLElement).closest('button')) cancelPeekDwell(); else openPeek(); }
        if (Date.now() - lastPointerMove.current < 1000) return;
        lastPointerMove.current = Date.now();
        if (pointer !== 'over') overSince.current = Date.now();
        setPointer('over');
        setPointerMoved((n) => n + 1);
      }}
      onMouseLeave={() => { cancelPeekDwell(); setPointer((was) => was === 'over' ? 'left' : was); }}
      className="launcher-scope ev eavesy-control"
    >
      <div className="ctl-top">{top}</div>
      {below && <div className="ctl-below" data-busy={ownTone?.busy || undefined} onMouseDown={(event) => event.stopPropagation()}>{below}</div>}
      {foot && <div className="ctl-foot" onMouseDown={(event) => event.stopPropagation()}>{foot}</div>}
    </div>
  );
}

/** Fades the editor's last line while more words are below it: Mac scrollbars hide until you scroll. */
function markMore(editor: HTMLTextAreaElement) {
  const more = editor.scrollTop + editor.clientHeight < editor.scrollHeight - 2;
  editor.closest('.ctl-below')?.toggleAttribute('data-more', more);
}

/** Recording was asked for, and the mic is not live yet. */
function isOpening(state: HudState): boolean {
  return state.phase === 'recording' && !state.sessionId;
}

function MicState({ heard, silent }: { heard: boolean; silent: boolean }) {
  const label = silent ? 'No microphone audio is arriving' : heard ? 'Mic active' : 'Mic quiet';
  const Icon = silent ? MicOff : Mic;
  return <span className="ctl-mic" data-heard={heard || undefined} role="img" aria-label={label} title={label}><Icon className="h-3.5 w-3.5" /></span>;
}

/**
 * A screen recording's evidence: clicks are noted on their own, and Mark brings
 * out the marker to tag an element or an area. Tags are manila, never coral.
 */
function Marking({ state, act }: { state: MarkingState; act: (cmd: string, args?: Record<string, unknown>) => void }) {
  const tags = state.marks.length;
  const tagCount = tags > 0 && <span className="ctl-tag" title={`${tags} tagged`} aria-label={`${tags} tagged`}>{tags}</span>;
  if (state.tool) return (
    <>
      <span className="ctl-sep" aria-hidden />
      <span className="ctl-seg" role="group" aria-label="What to tag">
        <button type="button" aria-pressed={state.tool === 'element'} onClick={() => act('set_marking_tool', { tool: 'element' })} className="ctl-seg-btn"><MousePointer2 className="h-3 w-3" />Element</button>
        <button type="button" aria-pressed={state.tool === 'area'} onClick={() => act('set_marking_tool', { tool: 'area' })} className="ctl-seg-btn"><SquareDashed className="h-3 w-3" />Area</button>
      </span>
      {tagCount}
    </>
  );
  return (
    <>
      <span className="ctl-sep" aria-hidden />
      <button type="button" onClick={() => act('toggle_marking')} title={`Draw a box to highlight and clip part of the screen${state.shortcut ? ` (${state.shortcut})` : ''}`} className="ctl-btn ctl-marker">
        <Search className="h-3.5 w-3.5" />Highlight{state.shortcut && <kbd className="ctl-kbd">{state.shortcut}</kbd>}
      </button>
    </>
  );
}

/** A rubber stamp on the case file: what just happened to the capture. */
function Stamp({ tone, fit, title, children }: { tone: 'leaf' | 'manila' | 'warn'; fit?: boolean; title?: string; children: ReactNode }) {
  return <span className="ctl-stamp" data-tone={tone} data-fit={fit || undefined} title={title} role="status">{tone === 'leaf' && <Check className="h-3 w-3" strokeWidth={3} />}{fit ? <span className="ctl-stamp-text">{children}</span> : children}</span>;
}

/** Bars that move with the voice: tall while words are arriving, a low idle sway in the quiet. */
function VoiceBars({ level }: { level: number }) {
  return (
    <span className="ctl-bars" aria-hidden style={{ '--lvl': level.toFixed(2) } as CSSProperties}>
      <i /><i /><i /><i /><i />
    </span>
  );
}

/** The snoop mirrors the capture: hat up only while the mic is really live. */
function mascotState(phase: Phase): MascotState {
  switch (phase) {
    case 'recording': return 'listening';
    case 'transcribing': return 'thinking';
    case 'saved':
    case 'done': return 'happy';
    case 'failed': return 'confused';
    default: return 'idle';
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <Hud />
  </StrictMode>,
);
