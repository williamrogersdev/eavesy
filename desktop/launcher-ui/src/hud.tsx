import { StrictMode, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { AudioLines, Camera, Check, Clapperboard, Copy, History, Maximize2, Mic, MicOff, Minus, MousePointer2, MousePointerClick, Search, ShieldCheck, Square, SquareDashed, X } from 'lucide-react';
import { useLiveLines } from '@/components/launcher/use-live-lines';
import { Mascot, type MascotState } from '@/components/launcher/ui/mascot';
import { clock } from '@/components/launcher/history-model';
import { errMsg } from '@/lib/desktop/errors';
import {
  addCaption,
  EMPTY_RUNNING,
  runningText,
  type LiveCaption,
  type RunningTranscript,
} from '@/lib/desktop/live-captions';
import { mergeTranscript } from '@/lib/desktop/live-edit';
import { learnedLabel, type LearningEvent } from '@/lib/desktop/learning';
import { DICTATION_STYLES, FOR_AGENTS_HINT, type DictationStyle } from '@/lib/transcription/dictation-style';
import { prettyAccel } from '@/lib/launcher/accel';
import { clicksLabel, NO_MARKING, useMarking, type MarkingState } from './marking';
import { holdMs, type Receipt } from './hud-hold';
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
}

interface TauriGlobal {
  core?: { convertFileSrc?(path: string): string; invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
  event?: {
    listen(
      event: string,
      handler: (e: { payload: unknown }) => void,
    ): Promise<() => void>;
  };
}

function tauri(): TauriGlobal | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

async function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  return tauri()?.core?.invoke(cmd, args);
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

const DEFAULT_LOOK: Look = { lines: 4, translucent: true };

/** How long Stop waits for a live correction to reach the app before stopping anyway. */
const LIVE_EDIT_WAIT_MS = 1500;
/** How long the pill confirms a word added to the dictionary. */
const LEARNED_MS = 4000;
/** The drawer's tone buttons: the words as pasted, then each rewrite tone ("As spoken" is the original's). */
type Tone = 'original' | Exclude<DictationStyle, 'natural'>;
const TONES: { id: Tone; label: string; hint: string }[] = [
  { id: 'original', label: 'Original', hint: 'The words as they were first pasted.' },
  ...DICTATION_STYLES.filter((style): style is Extract<typeof style, { id: Tone }> => style.id !== 'natural'),
];

/** A finished dictation's tone change: what it's rewritten from, what's picked, and where the rewrite went. */
interface ToneChange {
  sessionId: string;
  base: string;
  pick: Tone;
  forAgents: boolean;
  busy: boolean;
  landed: 'replaced' | 'copied' | null;
}

/** Past this many characters (MAX_POLISH_CHARS on the server) words are too long to rewrite here. */
const MAX_REWRITE_CHARS = 20_000;

/** In the browser preview, rewrites of the sample words instead of a server round trip. */
const PREVIEW_REWRITES: Record<Exclude<Tone, 'original'>, string> = {
  professional: 'For the onboarding email, I suggest leading with the mascot, using one screenshot rather than three, and closing with the shortcut so that people try it immediately.',
  friendly: 'Ideas for the onboarding email: let’s lead with the mascot, keep it to one screenshot instead of three, and finish on the shortcut so people can try it right away!',
  concise: 'Onboarding email: lead with the mascot, one screenshot not three, end on the shortcut.',
};

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
  if (state.phase !== 'done' || state.mode === 'image' || state.mode === 'video' || !state.message?.trim()) return null;
  if (state.notice?.includes('Accessibility')) return 'blocked';
  return state.notice ? 'copied' : 'pasted';
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
    case 'saved':
      return 'pill';
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
    startedAtMs: Date.now() - 78_000,
    message: phase === 'done' && mode === 'audio'
      ? params.has('long')
        ? Array.from({ length: Number(params.get('long')) || 12 }, (_, i) => `Point ${i + 1}: lead with the mascot, keep one screenshot instead of three, and end on the shortcut so people try it straight away.`).join(' ')
        : 'Ideas for the onboarding email: lead with the mascot, keep one screenshot instead of three, and end on the shortcut so people try it straight away.'
      : phase === 'failed' ? 'No speech was heard' : null,
  };
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

function browserPreviewWords(): RunningTranscript {
  if (tauri() || !new URLSearchParams(window.location.search).has('words')) return EMPTY_RUNNING;
  return addCaption(EMPTY_RUNNING, {
    sessionId: 'preview',
    track: 'mic',
    text: 'so the plan is we ship on Thursday and ask Sam for the deck before the call',
    isFinal: false,
    startMs: 0,
    endMs: 4_000,
  });
}

function Hud() {
  const [state, setState] = useState<HudState | null>(browserPreviewState);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [shortcut, setShortcut] = useState('');
  // Everything heard in the current recording, for the line under the bar.
  const [running, setRunning] = useState<RunningTranscript>(browserPreviewWords);
  // How lively the voice is right now, 0–1: a caption arriving lifts it, quiet lets it settle.
  const [voice, setVoice] = useState(0);
  const [micSignal, setMicSignal] = useState({rms: 0, at: 0});
  const [copied, setCopied] = useState(false);
  const marking = useMarking(browserPreviewMarking());
  const [editing, setEditing] = useState(false);
  const [pointer, setPointer] = useState<'away' | 'over' | 'left'>('away');
  // The finished dictation whose transcript drawer is open: hovering its pill opens it.
  const [peek, setPeek] = useState<string | null>(browserPreviewPeek);
  const [tone, setTone] = useState<ToneChange | null>(null);
  const peekDwell = useRef<number | null>(null);
  // Bumped (at most once a second) while the pointer moves over the control.
  const [pointerMoved, setPointerMoved] = useState(0);
  const lastPointerMove = useRef(0);
  // When the pointer came over the control, so moving it can't hold a result forever.
  const overSince = useRef(0);
  const [learned, setLearned] = useState<{ text: string; title?: string; tone: 'leaf' | 'warn' } | null>(browserPreviewLearned);
  const collapseRef = useRef<(() => void) | null>(null);
  const [draft, setDraft] = useState<{ sessionId: string | null; source: string | null; text: string } | null>(null);
  const [saveRevision, setSaveRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const pendingEdit = useRef<{ sessionId: string; text: string; live?: boolean } | null>(null);
  const latestEdit = useRef<{ sessionId: string; text: string; live?: boolean } | null>(null);
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
  const transcriptBox = useRef<HTMLDivElement>(null);
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
  const [look, setLook] = useState<Look>(() => {
    const params = new URLSearchParams(window.location.search);
    return tauri() ? DEFAULT_LOOK : lookFrom({ lines: params.has('lines') ? Number(params.get('lines')) : undefined, translucent: !params.has('solid') });
  });
  const loadShortcut = () => {
    void invoke('get_settings')
      .then((settings) => {
        const accel = (settings as { dictation_hotkey?: string } | null)?.dictation_hotkey;
        setShortcut(accel ? prettyAccel(accel) : '');
      })
      .catch(() => {});
  };
  useEffect(loadShortcut, []);
  // The saved look once at start; after that only `hud:look` changes it, so a
  // slow first read can't undo a change made in Settings meanwhile.
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    let changed = false;
    void tauri()?.event?.listen('hud:look', (event) => { changed = true; setLook(lookFrom(event.payload)); })
      .then((unlisten) => { if (disposed) unlisten(); else off = unlisten; });
    const load = (attempt: number) => {
      void invoke('get_settings')
        .then((settings) => { if (settings && !changed && !disposed) setLook(lookFrom(settings)); })
        .catch(() => { if (attempt < 4 && !changed && !disposed) window.setTimeout(() => load(attempt + 1), 500 * 2 ** attempt); });
    };
    if (tauri()) load(0);
    return () => { disposed = true; off?.(); };
  }, []);

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

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const off = await tauri()?.event?.listen('recording:caption', (e) => {
        const caption = e.payload as LiveCaption;
        if (caption.sessionId !== currentSession.current) return;
        setRunning((current) => addCaption(current, caption));
        if (caption.text.trim()) setVoice(1);
      });
      const offStatus = await tauri()?.event?.listen('recording:captions_status', (e) => {
        const status = e.payload as { sessionId: string; live: boolean };
        setCaptionsOff(status.live ? null : status.sessionId);
      });
      if (disposed) { off?.(); offStatus?.(); } else unlisten = () => { off?.(); offStatus?.(); };
    })().catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // A stop hands the keyboard back to the user's app, so the paste lands
  // there; leaving the app does too. Either way this box is no longer typed in.
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    const release = () => { editorRef.current?.blur(); setEditing(false); };
    window.addEventListener('blur', release);
    void tauri()?.event?.listen('hud:release-editor', release)
      .then((unlisten) => { if (disposed) unlisten(); else off = unlisten; });
    return () => { disposed = true; off?.(); window.removeEventListener('blur', release); };
  }, []);

  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void tauri()?.event?.listen('recording:level', (event) => {
      const value = event.payload as {sessionId: string; rms: number};
      if (value.sessionId === currentSession.current) setMicSignal({rms:value.rms, at:Date.now()});
    }).then((unlisten) => { if (disposed) unlisten(); else off = unlisten; });
    return () => { disposed = true; off?.(); };
  }, []);

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

  const act = (cmd: string, args?: Record<string, unknown>): Promise<boolean> => {
    setActionError(null);
    return invoke(cmd, args).then(() => true, (error: unknown) => {
      setActionError(errMsg(error, 'Could not complete action'));
      return false;
    });
  };

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
      .catch((error: unknown) => setActionError(errMsg(error, 'Could not copy')));
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
      const message = errMsg(error, mode === 'image' ? 'Could not take the screenshot' : 'Could not start recording');
      setActionError(message);
      void invoke('show_notice', { title: mode === 'image' ? "Eavesy couldn't take the screenshot" : "Eavesy couldn't start recording", body: message }).catch(() => {});
    }
    finally { setStarting(false); }
  };

  const screenshot = state?.phase === 'done' && state.mode === 'image' && !!state.sessionId;

  useEffect(() => { setCopied(false); setEditing(false); setPointer('away'); cancelPeekDwell(); setTone(null); setComposition(null); nativeEditReady.current = null; if (!pendingEdit.current) setSaveError(null); pendingLiveEdit.current = null; editorRef.current?.blur(); editHistory.current = { undo: [], redo: [] }; typingGroup.current = null; }, [state?.sessionId]);

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
  const size = state ? sizeFor(state, look.lines, peeking || keepDrawer) : 'pill';
  // Until its drawer is opened, a finished dictation is just a stamp on the pill.
  const receipt = state && !peeking && !keepDrawer ? receiptFor(state) : null;

  useEffect(() => {
    if (!state || editing || saving || saveError || ownTone?.busy || pendingEdit.current || !['saved', 'done'].includes(state.phase)) return;
    const hold = holdMs(state.phase, pointer, overSince.current, Date.now(), receipt);
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
  useEffect(() => {
    if (keepDrawer && !peeking && state?.sessionId && state.phase === 'done' && receiptFor(state)) void showDrawer(state.sessionId);
  }, [keepDrawer, peeking, state?.phase, state?.sessionId]);

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
  const heard = snapshotWords || (state?.sessionId && running.sessionId === state.sessionId ? runningText(running) : '');
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

  // A correction typed here or in the app the words went to reaches the
  // dictionary in the background: say so on the control, in leaf.
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void tauri()?.event?.listen('dictionary:learning', (e) => {
      const event = e.payload as LearningEvent;
      const text = learnedLabel(event);
      if (text) setLearned({ text, title: 'Saved to your dictionary', tone: 'leaf' });
      else if (event.status === 'failed') setLearned({ text: 'Not saved to dictionary', title: event.message, tone: 'warn' });
    }).then((stop) => { if (disposed) stop?.(); else off = stop; });
    return () => { disposed = true; off?.(); };
  }, []);
  useEffect(() => {
    if (!learned) return;
    const timer = window.setTimeout(() => setLearned(null), LEARNED_MS);
    return () => window.clearTimeout(timer);
  }, [learned]);

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
  const close = (
    <button type="button" onClick={() => { void flushEdit().then((saved) => saved ? invoke('dismiss_hud', { sessionId: state.sessionId }).then(() => invoke('close_hud')) : window.requestAnimationFrame(() => retrySaveButton.current?.focus())).catch((error) => setActionError(errMsg(error, 'Could not close'))); }} aria-label="Hide Eavesy" title="Hide Eavesy (reopen it from the menu bar)" className="ctl-btn ctl-icon"><X className="h-3.5 w-3.5" /></button>
  );
  const collapse = () => {
    void flushEdit()
      .then((saved) => {
        if (!saved) return window.requestAnimationFrame(() => retrySaveButton.current?.focus());
        if (tauri()) return invoke('dismiss_hud', { sessionId: state.sessionId });
        setState({ ...state, phase: 'idle', message: null, notice: null });
      })
      .catch((error) => setActionError(errMsg(error, 'Could not close')));
  };
  collapseRef.current = ['done', 'saved', 'failed'].includes(state.phase) ? collapse : null;
  const minimize = (
    <button type="button" onClick={collapse} aria-label="Collapse to the pill" title="Collapse to the pill (esc)" className="ctl-btn ctl-icon"><Minus className="h-3.5 w-3.5" /></button>
  );
  const history = (
    <button type="button" onClick={() => act('show_launcher')} aria-label="Open capture history" title="Capture history" className="ctl-btn ctl-icon"><History className="h-3.5 w-3.5" /></button>
  );
  const copyWords = (
    <button type="button" className="ctl-btn" onClick={() => copy('copy_text', { text: words })}>{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy'}</button>
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
    // Typed over a rewrite: that's now the words, and the next tone starts from them.
    if (ownTone) setTone(null);
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
  const transcriptEditor = (hint?: string) => <textarea
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
    onBlur={() => { setEditing(false); if (state.phase === 'done') void flushEdit(); }}
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

  // A tone button rewrites the words from where they started (so tones don't
  // compound), puts the rewrite where the words went, and saves it as the
  // transcript without teaching the dictionary: a rewrite isn't a correction.
  const restyle = async (pick: Tone, forAgents: boolean) => {
    const sessionId = state.sessionId;
    if (!sessionId || ownTone?.busy) return;
    const base = ownTone?.base ?? words;
    const before = ownTone;
    setActionError(null);
    setTone({ sessionId, base, pick, forAgents, busy: true, landed: null });
    try {
      const text = pick === 'original' && !forAgents ? base
        : !tauri() ? (pick === 'original' ? base : PREVIEW_REWRITES[pick])
        : String(await invoke('restyle_dictation', { sessionId, text: base, style: pick === 'original' ? 'natural' : pick, forAgents }));
      if (currentSession.current !== sessionId) return;
      const landed = tauri() ? (await invoke('replace_dictation', { sessionId, text })) === 'replaced' ? 'replaced' : 'copied' : 'replaced';
      setDraft({ sessionId, source: null, text });
      void invoke('save_preview_transcript', { sessionId, text, learn: false }).catch(() => {});
      setCopied(false);
      setTone((now) => now?.sessionId === sessionId ? { ...now, busy: false, landed } : now);
    } catch (error) {
      setTone((now) => now?.sessionId === sessionId ? before : now);
      setActionError(errMsg(error, 'Could not change the tone'));
    }
  };
  const tonePick = ownTone?.pick ?? 'original';
  const forAgents = ownTone?.forAgents ?? false;
  const tooLong = words.length > MAX_REWRITE_CHARS;
  const toneRow = !!state.sessionId && (tooLong ? (
    <div className="ctl-tones">
      <span className="ctl-say ctl-quiet">Too long to change the tone here</span>
      <span className="ctl-fill" />
      <button type="button" className="ctl-tone" onClick={() => act('show_launcher')}>Open in Eavesy</button>
    </div>
  ) : (
    <div className="ctl-tones" role="group" aria-label="Rewrite in another tone">
      {TONES.map((choice) => (
        <button key={choice.id} type="button" className="ctl-tone" aria-pressed={tonePick === choice.id} disabled={!!ownTone?.busy} title={choice.hint}
          onClick={() => { if (choice.id !== tonePick) void restyle(choice.id, forAgents); }}>
          {choice.label}
        </button>
      ))}
      <span className="ctl-fill" />
      <span className="ctl-sep" aria-hidden />
      <button type="button" className="ctl-tone" aria-pressed={forAgents} disabled={!!ownTone?.busy} title={FOR_AGENTS_HINT}
        onClick={() => void restyle(tonePick, !forAgents)}>
        For AI
      </button>
    </div>
  ));
  const toneStamp = ownTone?.busy ? <span className="ctl-say ctl-quiet">Rewriting<span className="ctl-dots" aria-hidden><i /><i /><i /></span></span>
    : ownTone?.landed === 'replaced' ? <Stamp tone="leaf">Updated</Stamp>
    : ownTone?.landed === 'copied' ? <><Stamp tone="manila">Copied</Stamp><span className="ctl-say ctl-quiet">⌘V to paste</span></>
    : null;

  let top: ReactNode;
  let below: ReactNode = null;
  let foot: ReactNode = null;

  if (actionError && !(video && state.phase === 'recording')) {
    top = <>{mark}<span role="alert" title={actionError} className="ctl-say ctl-warn">{actionError}</span><span className="ctl-fill" />{close}</>;
    if (!video && state.sessionId) below = transcriptEditor();
  } else if (state.phase === 'recording') {
    top = (
      <>
        {mark}
        {opening ? <span className="ctl-say ctl-quiet ctl-breathe">Starting…</span> : (
          <>
            <span className="ctl-rec" aria-hidden />
            <span className="ctl-timer">{clock(Math.max(0, Math.floor((now - (state.startedAtMs ?? now)) / 1000)))}</span>
            {video && marking.tool ? null : video ? <MicState heard={now - micSignal.at < 2000 && micSignal.rms >= 0.002} silent={micSignal.at > 0 && now - micSignal.at > 5000} /> : <VoiceBars level={voice} />}
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
    top = <>{mark}<span className="ctl-say">{video ? 'Saving' : 'Writing it down'}<span className="ctl-dots" aria-hidden><i /><i /><i /></span></span><span className="ctl-fill" /></>;
    if (!video && look.lines) below = transcriptEditor('Turning your words into text…');
  } else if (state.phase === 'done' && video) {
    top = <>{mark}<span className="ctl-say ctl-quiet" title={notice ?? undefined}>{copied ? 'Copied' : 'Saved'}</span>
      <span className="ctl-fill" />
      <button type="button" className="ctl-btn" onClick={() => act('show_launcher')} aria-label="Open recording"><Maximize2 className="h-3.5 w-3.5" /></button>
      <button type="button" className="ctl-btn" onClick={() => copy('copy_capture_media', { id: state.sessionId })}><Copy className="h-3.5 w-3.5" />Copy</button>{minimize}{close}</>;
  } else if (state.phase === 'done' && state.mode === 'image') {
    top = (
      <>
        {mark}
        <Stamp tone="manila">{copied ? 'Copied' : 'Snapped'}</Stamp>
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
        {learnedStamp ?? stamp}
        <span className="ctl-fill" />
        {receipt === 'blocked' && <button type="button" className="ctl-btn" onClick={() => act('open_privacy_settings', { pane: 'accessibility' })}><ShieldCheck className="h-3.5 w-3.5" />Allow</button>}
        {receipt === 'blocked' && minimize}
      </>
    );
  } else if (state.phase === 'done' && (size === 'wide' || size === 'result')) {
    const stamp = toneStamp ?? learnedStamp ?? (notPasted ? <Stamp tone="warn">Not pasted</Stamp> : notice ? <Stamp tone="manila">Copied</Stamp> : <Stamp tone="leaf">Pasted<span className="ctl-stamp-sub"> · {wordCount(words)}</span></Stamp>);
    top = (
      <>
        {mark}
        {saveError ? <span role="alert"><span className="ctl-say ctl-warn">Save failed </span><button ref={retrySaveButton} className="ctl-btn ctl-warn" title={saveError} onClick={() => void flushEdit()}>Retry save</button></span> : saving ? <span className="ctl-say ctl-quiet">Saving…</span> : stamp}
        {notice && !notPasted && !learnedStamp && !toneStamp && <span className="ctl-say ctl-quiet">⌘V to paste</span>}
        <span className="ctl-fill" />
        {notPasted && <button type="button" className="ctl-btn" onClick={() => act('open_privacy_settings', { pane: 'accessibility' })}><ShieldCheck className="h-3.5 w-3.5" />Allow</button>}
        {size === 'result' && <button type="button" className="ctl-btn ctl-icon" onClick={() => act('show_launcher')} aria-label="Open in Eavesy" title="Open in Eavesy, with the whole transcript"><Maximize2 className="h-3.5 w-3.5" /></button>}
        {words && copyWords}
        {minimize}
        {close}
      </>
    );
    below = editable ? transcriptEditor() : <p className="ctl-line ctl-quiet" title={notice ?? undefined}>{notice}</p>;
    if (size === 'result' && editable) foot = toneRow;
  } else if (learnedStamp && ['idle', 'saved', 'done'].includes(state.phase)) {
    // Briefly, the whole pill is the confirmation: a word fits where Close was.
    top = <>{mark}{learnedStamp}<span className="ctl-fill" /></>;
  } else if (state.phase === 'done' || state.phase === 'saved') {
    top = <>{mark}<Stamp tone="manila">Saved</Stamp><span className="ctl-fill" />{history}{minimize}{close}</>;
  } else if (state.phase === 'failed') {
    top = <>{mark}<span className="ctl-say ctl-warn">Didn’t catch that</span><span className="ctl-fill" />{history}{minimize}{close}</>;
    below = <p className="ctl-line ctl-quiet" title={state.message ?? undefined}>{state.message || 'Nothing was saved. Try again?'}</p>;
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
      onMouseEnter={(event) => { loadShortcut(); if (pointer !== 'over') overSince.current = Date.now(); setPointer('over'); if (receipt && !(event.target as HTMLElement).closest('button')) openPeek(); }}
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
      {below && <div ref={transcriptBox} className="ctl-below" data-busy={ownTone?.busy || undefined} onMouseDown={(event) => event.stopPropagation()}>{below}</div>}
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
