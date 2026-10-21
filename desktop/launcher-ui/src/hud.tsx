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
import { prettyAccel } from '@/lib/launcher/accel';
import { clicksLabel, NO_MARKING, useMarking, type MarkingState } from './marking';
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
type Size = 'pill' | 'bar' | 'wide' | 'result' | 'shot' | 'video';

/** How the control looks while recording, from Settings → App → Capture. */
type Look = { lines: 0 | 1 | 2 | 4; translucent: boolean };

const DEFAULT_LOOK: Look = { lines: 4, translucent: true };

/** How long Stop waits for a live correction to reach the app before stopping anyway. */
const LIVE_EDIT_WAIT_MS = 1500;
/** How long a finished result stays open once nobody is editing it. */
const DONE_HOLD_MS = 10_000;
/** How long a result stays once the pointer has been over it and left. */
const LEFT_HOLD_MS = 2500;

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

function sizeFor(state: HudState, lines: Look['lines']): Size {
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
      if (state.message?.trim()) return 'result';
      return state.notice ? 'wide' : 'pill';
  }
}

const PREVIEW_SIZES: Record<Size, [number, number]> = { pill: [216, 36], bar: [264, 40], wide: [400, 142], result: [400, 142], shot: [360, 172], video: [420, 36] };

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
      ? 'Ideas for the onboarding email: lead with the mascot, keep one screenshot instead of three, and end on the shortcut so people try it straight away.'
      : phase === 'failed' ? 'No speech was heard' : null,
  };
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

  useEffect(() => { setCopied(false); setEditing(false); setPointer('away'); setComposition(null); nativeEditReady.current = null; if (!pendingEdit.current) setSaveError(null); pendingLiveEdit.current = null; editorRef.current?.blur(); editHistory.current = { undo: [], redo: [] }; typingGroup.current = null; }, [state?.sessionId]);

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

  const size = state ? sizeFor(state, look.lines) : 'pill';

  useEffect(() => {
    if (!state || pointer === 'over' || editing || saving || saveError || pendingEdit.current || !['saved', 'done'].includes(state.phase)) return;
    const sessionId = state.sessionId;
    const timeout = window.setTimeout(() => {
      if (tauri()) void invoke('dismiss_hud', { sessionId }).catch(() => {});
      else setState({ ...state, phase: 'idle', message: null, notice: null });
    }, pointer === 'left' ? LEFT_HOLD_MS : state.phase === 'done' ? DONE_HOLD_MS : 3500);
    return () => window.clearTimeout(timeout);
  }, [state?.phase, state?.sessionId, pointer, editing, saving, saveError, draft, saveRevision]);

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

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (document.activeElement === editor) {
      const saved = selection.current;
      editor.setSelectionRange(saved.start, saved.end, saved.direction);
      editor.scrollTop = saved.scroll;
    } else editor.scrollTop = editor.scrollHeight;
  }, [words, state?.sessionId]);

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

  const opening = state.phase === 'recording' && !state.sessionId;
  const video = state.mode === 'video';
  const editable = !!source || !!ownDraft;
  const notice = state.notice ?? null;
  const notPasted = !!notice?.includes('Accessibility');
  const busy = starting || state.phase === 'transcribing';
  const kbd = shortcut ? ` (${shortcut})` : '';

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
    ref={editorRef}
    aria-label="Edit transcript preview"
    className="ctl-words ctl-editor"
    value={composition?.text ?? words}
    placeholder={hint}
    spellCheck
    readOnly={!state.sessionId}
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

  let top: ReactNode;
  let below: ReactNode = null;

  if (actionError) {
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
        {video && marking.tool
          ? <button type="button" onClick={() => act('stop_marking')} title="Put the marker away (esc)" className="ctl-btn ctl-primary">Done</button>
          : <button type="button" disabled={opening || !state.sessionId || stopping === state.sessionId} onClick={() => stopRecording(state.sessionId)} aria-label={`Stop${kbd}`} title={`Stop${video ? '' : ' and paste'}${kbd}`} className="ctl-btn ctl-stop"><Square className="h-2.5 w-2.5" fill="currentColor" />Stop</button>}
      </>
    );
    const noLiveWords = !!state.sessionId && captionsOff === state.sessionId;
    const doneHint = shortcut ? `tap ${shortcut} to paste` : 'press Stop to paste';
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
  } else if (state.phase === 'done' && (size === 'wide' || size === 'result')) {
    const stamp = notPasted ? <Stamp tone="warn">Not pasted</Stamp> : notice ? <Stamp tone="manila">Copied</Stamp> : <Stamp tone="leaf">Pasted</Stamp>;
    top = (
      <>
        {mark}
        {saveError ? <span role="alert"><span className="ctl-say ctl-warn">Save failed </span><button ref={retrySaveButton} className="ctl-btn ctl-warn" title={saveError} onClick={() => void flushEdit()}>Retry save</button></span> : saving ? <span className="ctl-say ctl-quiet">Saving…</span> : stamp}
        {notice && !notPasted && <span className="ctl-say ctl-quiet">⌘V to paste</span>}
        <span className="ctl-fill" />
        {notPasted && <button type="button" className="ctl-btn" onClick={() => act('open_privacy_settings', { pane: 'accessibility' })}><ShieldCheck className="h-3.5 w-3.5" />Allow</button>}
        {words && copyWords}
        {minimize}
        {close}
      </>
    );
    below = editable ? transcriptEditor() : <p className="ctl-line ctl-quiet" title={notice ?? undefined}>{notice}</p>;
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
      data-marking={video && live && marking.tool ? 'true' : undefined}
      data-translucent={look.translucent || undefined}
      style={state.phase === 'recording' || state.phase === 'transcribing' ? { '--ctl-lines': look.lines } as CSSProperties : undefined}
      onMouseDown={pressSurface}
      onMouseEnter={() => { loadShortcut(); setPointer('over'); }}
      onMouseLeave={() => setPointer((was) => was === 'over' ? 'left' : was)}
      className="launcher-scope ev eavesy-control"
    >
      <div className="ctl-top">{top}</div>
      {below && <div ref={transcriptBox} className="ctl-below" onMouseDown={(event) => event.stopPropagation()}>{below}</div>}
    </div>
  );
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
      <span className="ctl-count" title="Each click is saved with what was under the pointer"><MousePointerClick className="h-3.5 w-3.5" />{clicksLabel(state.clicks)}</span>
      {tagCount}
      <button type="button" onClick={() => act('toggle_marking')} title={`Tag something on screen for your AI${state.shortcut ? ` (${state.shortcut})` : ''}`} className="ctl-btn ctl-marker">
        <Search className="h-3.5 w-3.5" />Mark{state.shortcut && <kbd className="ctl-kbd">{state.shortcut}</kbd>}
      </button>
    </>
  );
}

/** A rubber stamp on the case file: what just happened to the capture. */
function Stamp({ tone, children }: { tone: 'leaf' | 'manila' | 'warn'; children: ReactNode }) {
  return <span className="ctl-stamp" data-tone={tone} role="status">{tone === 'leaf' && <Check className="h-3 w-3" strokeWidth={3} />}{children}</span>;
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
