import { StrictMode, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { AudioLines, Camera, Check, Clapperboard, Copy, History, Maximize2, ShieldCheck, Square, X } from 'lucide-react';
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
import { prettyAccel } from '@/lib/launcher/accel';
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
type Size = 'pill' | 'wide' | 'result' | 'shot';

function sizeFor(state: HudState): Size {
  const video = state.mode === 'video';
  switch (state.phase) {
    case 'idle':
    case 'saved':
      return 'pill';
    case 'recording':
    case 'transcribing':
      return video ? 'pill' : 'wide';
    case 'failed':
      return 'wide';
    case 'done':
      if (state.mode === 'image') return 'shot';
      if (video) return 'pill';
      if (state.message?.trim()) return 'result';
      return state.notice ? 'wide' : 'pill';
  }
}

const PREVIEW_SIZES: Record<Size, [number, number]> = { pill: [216, 36], wide: [360, 64], result: [360, 100], shot: [360, 172] };

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
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  // The Mac's own recognizer could not run for this recording: no live words.
  const [captionsOff, setCaptionsOff] = useState<string | null>(null);
  // The result the pointer has already visited: once it leaves, a short grace.
  const visited = useRef<string | null>(null);
  const loadShortcut = () => {
    void invoke('get_settings')
      .then((settings) => {
        const accel = (settings as { dictation_hotkey?: string } | null)?.dictation_hotkey;
        setShortcut(accel ? prettyAccel(accel) : '');
      })
      .catch(() => {});
  };
  useEffect(loadShortcut, []);

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

  const act = (cmd: string, args?: Record<string, unknown>) => {
    setActionError(null);
    void invoke(cmd, args).catch((error: unknown) => setActionError(errMsg(error, 'Could not complete action')));
  };

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
      else await invoke('start_capture', { source: 'mic' });
    }
    catch (error) {
      const message = errMsg(error, mode === 'image' ? 'Could not take the screenshot' : 'Could not start recording');
      setActionError(message);
      void invoke('show_notice', { title: mode === 'image' ? "Eavesy couldn't take the screenshot" : "Eavesy couldn't start recording", body: message }).catch(() => {});
    }
    finally { setStarting(false); }
  };

  const screenshot = state?.phase === 'done' && state.mode === 'image' && !!state.sessionId;

  useEffect(() => setCopied(false), [state?.sessionId, state?.phase]);

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

  const size = state ? sizeFor(state) : 'pill';

  useEffect(() => {
    if (!state || !['saved', 'done', 'failed'].includes(state.phase)) return;
    const sessionId = state.sessionId;
    // Long enough to read the words or grab the screenshot; held open while
    // the pointer is on the control, then a short grace once it leaves.
    const key = `${state.phase}:${sessionId ?? ''}`;
    if (hovered) { visited.current = key; return; }
    const timeout = window.setTimeout(() => {
      void invoke('dismiss_hud', { sessionId }).catch(() => {});
    }, visited.current === key ? 2500 : size === 'pill' ? 3500 : size === 'result' ? 9000 : 7000);
    return () => window.clearTimeout(timeout);
  }, [state?.phase, state?.sessionId, size, hovered]);

  // In a browser the page stands in for the window: give it the window's size.
  useEffect(() => {
    if (tauri()) return;
    const [width, height] = PREVIEW_SIZES[size];
    const root = document.getElementById('root');
    if (root) Object.assign(root.style, { width: `${width}px`, height: `${height}px`, margin: '28px auto 0' });
    document.body.style.background = 'linear-gradient(160deg, #e9e4dc, #cfd6dd)';
    document.body.style.minHeight = '100vh';
  }, [size]);

  if (!state) return null;

  const opening = state.phase === 'recording' && !state.sessionId;
  const video = state.mode === 'video';
  const heard = state.sessionId && running.sessionId === state.sessionId ? runningText(running) : '';
  const words = state.phase === 'done' ? (state.message?.trim() || heard) : heard;
  const notice = state.notice ?? null;
  const notPasted = !!notice?.includes('Accessibility');
  const busy = starting || state.phase === 'transcribing';
  const kbd = shortcut ? ` (${shortcut})` : '';

  const pressSurface = (e: MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
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
    <button type="button" onClick={() => act('close_hud')} aria-label="Close capture control" title="Close (reopen from the menu bar)" className="ctl-btn ctl-icon"><X className="h-3.5 w-3.5" /></button>
  );
  const history = (
    <button type="button" onClick={() => act('show_launcher')} aria-label="Open capture history" title="Capture history" className="ctl-btn ctl-icon"><History className="h-3.5 w-3.5" /></button>
  );
  const copyWords = (
    <button type="button" className="ctl-btn ctl-primary" onClick={() => copy('copy_text', { text: words })}>{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy'}</button>
  );
  const expand = (
    <button type="button" onClick={() => act('show_launcher')} aria-label="Open Eavesy" title="Open Eavesy" className="ctl-btn ctl-icon"><Maximize2 className="h-3.5 w-3.5" /></button>
  );

  let top: ReactNode;
  let below: ReactNode = null;

  if (actionError) {
    top = <>{mark}<span role="alert" title={actionError} className="ctl-say ctl-warn">{actionError}</span><span className="ctl-fill" />{close}</>;
  } else if (state.phase === 'recording') {
    top = (
      <>
        {mark}
        {opening ? <span className="ctl-say ctl-quiet ctl-breathe">Starting…</span> : (
          <>
            <span className="ctl-rec" aria-hidden />
            <span className="ctl-timer">{clock(Math.max(0, Math.floor((now - (state.startedAtMs ?? now)) / 1000)))}</span>
            {video ? <span className="ctl-say ctl-quiet">Screen</span> : <VoiceBars level={voice} />}
          </>
        )}
        <span className="ctl-fill" />
        <button type="button" disabled={opening} onClick={() => act('stop_capture', { sessionId: state.sessionId })} aria-label={`Stop${kbd}`} title={`Stop${video ? '' : ' and paste'}${kbd}`} className="ctl-btn ctl-stop"><Square className="h-2.5 w-2.5" fill="currentColor" />Stop</button>
      </>
    );
    const noLiveWords = !!state.sessionId && captionsOff === state.sessionId;
    const doneHint = shortcut ? `tap ${shortcut} to paste` : 'press Stop to paste';
    if (!video) below = <Ticker text={heard} hint={opening ? 'Opening the mic…' : noLiveWords ? `Live words are off on this Mac. Talk, then ${doneHint}` : `Listening… ${doneHint}`} />;
  } else if (state.phase === 'transcribing') {
    top = <>{mark}<span className="ctl-say">{video ? 'Saving' : 'Writing it down'}<span className="ctl-dots" aria-hidden><i /><i /><i /></span></span><span className="ctl-fill" /></>;
    if (!video) below = <Ticker text={heard} hint="Turning your words into text…" working />;
  } else if (state.phase === 'done' && state.mode === 'image') {
    top = (
      <>
        {mark}
        <Stamp tone="manila">{copied ? 'Copied' : 'Snapped'}</Stamp>
        <span className="ctl-fill" />
        <button type="button" className="ctl-btn" onClick={() => act('show_launcher')}><Maximize2 className="h-3.5 w-3.5" />Open</button>
        <button type="button" className="ctl-btn" onClick={() => copy('copy_capture_media', { id: state.sessionId })}><Copy className="h-3.5 w-3.5" />Copy</button>
        {close}
      </>
    );
    below = (
      <button type="button" className="ctl-shot" onClick={() => act('show_launcher')} aria-label="Open the screenshot" title="Open the screenshot">
        {imageSrc ? <img src={imageSrc} alt="" draggable={false} /> : <span className="ctl-shot-wait" />}
      </button>
    );
  } else if (state.phase === 'done' && (size === 'wide' || size === 'result')) {
    const stamp = notPasted ? <Stamp tone="warn">Not pasted</Stamp> : notice ? <Stamp tone="manila">On clipboard</Stamp> : <Stamp tone="leaf">Pasted</Stamp>;
    top = (
      <>
        {mark}
        {stamp}
        {notice && !notPasted && <span className="ctl-say ctl-quiet">⌘V to paste</span>}
        <span className="ctl-fill" />
        {notPasted && <button type="button" className="ctl-btn" onClick={() => act('open_privacy_settings', { pane: 'accessibility' })}><ShieldCheck className="h-3.5 w-3.5" />Allow</button>}
        {words && copyWords}
        {expand}
        {close}
      </>
    );
    below = words
      ? <p className="ctl-words" title={words}>{words}</p>
      : <p className="ctl-line ctl-quiet" title={notice ?? undefined}>{notice}</p>;
  } else if (state.phase === 'done' || state.phase === 'saved') {
    top = <>{mark}<Stamp tone="manila">Saved</Stamp><span className="ctl-fill" />{history}{close}</>;
  } else if (state.phase === 'failed') {
    top = <>{mark}<span className="ctl-say ctl-warn">Didn’t catch that</span><span className="ctl-fill" />{history}{close}</>;
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

  return (
    <div
      aria-label={live ? 'Eavesy recording' : 'Eavesy'}
      data-phase={opening ? 'starting' : state.phase}
      data-size={size}
      onMouseDown={pressSurface}
      onMouseEnter={() => { loadShortcut(); setHovered(true); }}
      onMouseLeave={() => setHovered(false)}
      className="launcher-scope ev eavesy-control"
    >
      <div className="ctl-top">{top}</div>
      {below && <div className="ctl-below">{below}</div>}
    </div>
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

/** One line of what is being heard, the newest words always in view. */
function Ticker({ text, hint, working }: { text: string; hint: string; working?: boolean }) {
  return (
    <p className="ctl-line ctl-ticker" data-working={working || undefined} aria-live="polite">
      {text ? <bdi>{text.replace(/\s+/g, ' ').trim().slice(-240)}</bdi> : <span className="ctl-hint">{hint}</span>}
    </p>
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
