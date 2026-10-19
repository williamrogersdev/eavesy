import { StrictMode, useEffect, useRef, useState, type MouseEvent } from 'react';
import { AudioLines, Camera, Check, Clapperboard, Copy, History, Maximize2, ShieldCheck, Square, X } from 'lucide-react';
import { Mascot, type MascotState } from '@/components/launcher/ui/mascot';
import { clock } from '@/components/launcher/history-model';
import { errMsg } from '@/lib/desktop/errors';
import {
  addCaption,
  captionTail,
  EMPTY_RUNNING,
  runningText,
  trackLabel,
  type LiveCaption,
  type RunningTranscript,
} from '@/lib/desktop/live-captions';
import { prettyAccel } from '@/lib/launcher/accel';
import { createRoot } from 'react-dom/client';
import { HudSheet } from './hud-sheet';
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

function elapsedLabel(startedAtMs: number | null, now: number): string {
  if (!startedAtMs) return '';
  return clock(Math.max(0, Math.floor((now - startedAtMs) / 1000)));
}

/** The sheet's tallest, while recording and after: matches `MAX_SHEET` in hud.rs at most. */
const LIVE_SHEET = 112;
const RESULT_SHEET = 240;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function browserPreviewState(): HudState | null {
  if (tauri()) return null;
  const params = new URLSearchParams(window.location.search);
  const phase = (params.get('hud') ?? 'idle') as Phase;
  const image = params.has('image');
  return {
    phase,
    sessionId: 'preview',
    mode: image ? 'image' : 'audio',
    notice: params.get('notice'),
    startedAtMs: Date.now() - 78_000,
    message: phase === 'done' && !image
      ? 'Ideas for the onboarding email: lead with the mascot, keep one screenshot instead of three, and end on the shortcut so people try it straight away. It is just not really fleshed out yet, but the shape is right.'
      : null,
  };
}

function Hud() {
  const [state, setState] = useState<HudState | null>(browserPreviewState);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [shortcut, setShortcut] = useState('');
  // The newest caption of each track, so the mic and the call never replace each other.
  const [captions, setCaptions] = useState<Record<string, LiveCaption>>({});
  // Everything heard in the current recording, for the transcript under the bar.
  const [running, setRunning] = useState<RunningTranscript>(EMPTY_RUNNING);
  // The height the sheet's content needs, and whether it opens above the bar.
  const [sheetNeeds, setSheetNeeds] = useState(0);
  const [growsUp, setGrowsUp] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  // Bumped each time the control is shown again, having lost its room.
  const [shown, setShown] = useState(0);
  const sheetHeight = useRef(0);
  const resizing = useRef<Promise<void>>(Promise.resolve());
  // A resize the window refused is asked for again, a few times.
  const [retry, setRetry] = useState(0);
  const failures = useRef(0);
  const retryTimer = useRef<number | undefined>(undefined);
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
        setCaptions((current) => {
          const sameSession = Object.values(current).every((c) => c.sessionId === caption.sessionId);
          return { ...(sameSession ? current : {}), [caption.track]: caption };
        });
        setRunning((current) => addCaption(current, caption));
      });
      if (disposed) off?.(); else unlisten = off;
    })().catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const act = (cmd: string, args?: Record<string, unknown>) => {
    setActionError(null);
    void invoke(cmd, args).catch((error: unknown) => setActionError(errMsg(error, 'Could not complete action')));
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
      // The HUD's mic button is Talk: microphone only. Meetings start from the panel.
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

  const transcript = hudTranscript(state, running);
  // From the moment the mic is live until the words land, the sheet stays
  // open: what is being heard is always in view, and the HUD never shrinks
  // and grows again between stopping and pasting.
  const listening = state?.phase === 'recording' && !!state.sessionId && state.mode !== 'video';
  const hint = listening ? 'Your words show up here as you talk' : state?.phase === 'transcribing' && state.sessionId && state.mode !== 'video' ? 'Almost there…' : null;
  const screenshot = state?.phase === 'done' && state.mode === 'image' && !!state.sessionId;
  const sheet: 'live' | 'result' | 'image' | null = screenshot
    ? 'image'
    : state && ['done', 'saved', 'failed'].includes(state.phase) && (transcript.text || transcript.notice)
      ? 'result'
      : hint !== null || transcript.text
        ? 'live'
        : null;
  const target = sheet ? Math.min(sheetNeeds, sheet === 'live' ? LIVE_SHEET : RESULT_SHEET) : 0;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void tauri()?.event?.listen('hud:shown', () => {
      // Shown afresh at its own frame: the sheet's room is gone.
      sheetHeight.current = 0;
      failures.current = 0;
      setShown((n) => n + 1);
    }).then((off) => { if (disposed) off(); else unlisten = off; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // The window makes room for the sheet one step at a time, in order. Which
  // way it opens is settled first, so the layout flips before the window
  // grows and the bar never jumps.
  // A new size to make room for gets its own retries.
  useEffect(() => { failures.current = 0; }, [target]);
  useEffect(() => () => window.clearTimeout(retryTimer.current), []);

  useEffect(() => {
    window.clearTimeout(retryTimer.current);
    resizing.current = resizing.current.then(async () => {
      if (target === sheetHeight.current) return;
      if (sheetHeight.current === 0 && target > 0) {
        const up = await invoke('hud_sheet_opens_up', { height: target }).catch(() => false);
        setGrowsUp(up === true);
        await nextFrame();
      }
      // Only room the window really made counts: a failed resize is asked for again next time.
      const up = await invoke('set_hud_sheet', { height: target }).then((value) => value === true, () => null);
      if (up === null) {
        if (++failures.current <= 3) retryTimer.current = window.setTimeout(() => setRetry((n) => n + 1), 300 * failures.current);
        return;
      }
      failures.current = 0;
      sheetHeight.current = target;
      setGrowsUp(target > 0 && up);
    });
  }, [target, shown, retry]);

  useEffect(() => setCopied(false), [sheet, state?.sessionId, state?.phase]);

  const copy = (cmd: string, args: Record<string, unknown>) => {
    setActionError(null);
    void invoke(cmd, args)
      .then(() => setCopied(true))
      .catch((error: unknown) => setActionError(errMsg(error, 'Could not copy')));
  };

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

  useEffect(() => {
    if (!state || !['saved', 'done', 'failed'].includes(state.phase)) return;
    const sessionId = state.sessionId;
    // Long enough to read the words or grab the screenshot; held open while
    // the pointer is on the control, then a short grace once it leaves.
    const key = `${state.phase}:${sessionId ?? ''}`;
    if (hovered) { visited.current = key; return; }
    const timeout = window.setTimeout(() => {
      void invoke('dismiss_hud', { sessionId }).catch(() => {});
    }, visited.current === key ? 2500 : sheet ? 8000 : 3500);
    return () => window.clearTimeout(timeout);
  }, [state?.phase, state?.sessionId, state?.mode, sheet, hovered]);

  useEffect(() => {
    if (state?.phase !== 'recording') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state?.phase]);

  if (!state) return null;

  const recording = state.phase === 'recording';
  // Recording with no session yet: the mic is still opening.
  const opening = recording && !state.sessionId;
  const live = recording && !opening;
  const liveCaptions = live && !sheet
    ? ['mic', 'system']
        .map((track) => captions[track])
        .filter((c): c is LiveCaption => !!c && c.sessionId === state.sessionId && !!c.text.trim())
    : [];
  const labelled = liveCaptions.length > 1;
  const closable = !recording && state.phase !== 'transcribing';
  const busy = starting || state.phase === 'transcribing';

  const pressSurface = (e: MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const inSheet = !!(e.target as HTMLElement).closest('.ctl-sheet');
    const origin = { x: e.screenX, y: e.screenY };
    const cleanup = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    const move = (ev: globalThis.MouseEvent) => {
      if (Math.hypot(ev.screenX - origin.x, ev.screenY - origin.y) < 4) return;
      cleanup();
      // The sheet's words can be selected; the rest of the control drags.
      if (!inSheet) void invoke('plugin:window|start_dragging', { label: 'hud' }).catch(() => {});
    };
    const up = () => {
      cleanup();
      if (inSheet) return;
      act('show_launcher');
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div aria-label={live ? 'Eavesy recording' : 'Eavesy'} data-phase={opening ? 'starting' : state.phase} data-grow={growsUp ? 'up' : undefined} onMouseDown={pressSurface} onMouseEnter={() => { loadShortcut(); setHovered(true); }} onMouseLeave={() => setHovered(false)} className="launcher-scope ev eavesy-control">
      <div className="ctl-bar">
      <div className="ctl-grid">
        <button type="button" onClick={() => act('show_launcher')} aria-label="Open Eavesy" title="Open Eavesy" className="ctl-mark">
          <Mascot size={18} state={opening ? 'idle' : mascotState(state.phase)} />
        </button>
        <div className="ctl-title" title={actionError ?? undefined}>
          {live && <span className="ctl-rec" aria-hidden />}
          {live && <span className="ctl-timer">{elapsedLabel(state.startedAtMs, now)}</span>}
          {opening && <span className="ctl-quiet ctl-writing">Starting…</span>}
          {live && liveCaptions.length === 0 && <span className="ctl-quiet">Listening</span>}
          {liveCaptions.map((c) => (
            <span key={c.track} aria-live="polite" title={c.text} data-final={c.isFinal || undefined} className="ctl-caption">
              <bdi>{labelled && <span className="ctl-caption-label">{trackLabel(c.track)}</span>}{captionTail(c.text, 120)}</bdi>
            </span>
          ))}
          {state.phase === 'transcribing' && <span className="ctl-quiet ctl-writing">Writing it down…</span>}
          {state.phase === 'done' && state.mode === 'audio' && transcript.text && (
            <span className="ctl-done"><Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />{transcript.notice ? 'Copied' : 'Pasted'}</span>
          )}
          {screenshot && <span className="ctl-done"><Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />Screenshot</span>}
          {state.phase === 'done' && state.mode === 'video' && <span className="ctl-done"><Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />Saved</span>}
          {state.phase === 'saved' && <span className="ctl-done"><Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />Saved</span>}
          {state.phase === 'failed' && !actionError && <span className="ctl-error" title={state.message ?? undefined}>Didn’t work</span>}
          {actionError && <span role="alert" title={actionError} className="ctl-error">{actionError}</span>}
        </div>
        <div className="ctl-actions">
          {recording ? (
            <button type="button" disabled={opening} onClick={() => act('stop_capture', { sessionId: state.sessionId })} aria-label={`Stop and save${shortcut ? ` (${shortcut})` : ''}`} title={`Stop and save${shortcut ? ` (${shortcut})` : ''}`} className="ctl-btn ctl-stop"><Square className="h-3 w-3" fill="currentColor" /><span className="ctl-label">Stop</span></button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => void startRecording()} aria-label={`Talk${shortcut ? ` (${shortcut})` : ''}`} title={`Talk, then paste where your cursor is${shortcut ? ` (${shortcut})` : ''}`} className="ctl-btn"><AudioLines className="h-3.5 w-3.5" /><span className="ctl-label">Talk</span></button>
              <button type="button" disabled={busy} onClick={() => void startRecording('image')} aria-label="Take screenshot" title="Take screenshot" className="ctl-btn"><Camera className="h-3.5 w-3.5" /><span className="ctl-label">Screenshot</span></button>
              <button type="button" disabled={busy} onClick={() => void startRecording('video')} aria-label="Record screen video" title="Record your screen and mic" className="ctl-btn"><Clapperboard className="h-3.5 w-3.5" /><span className="ctl-label">Video</span></button>
            </>
          )}
        </div>
        <div className="ctl-tools">
          <button type="button" onClick={() => act('show_launcher')} aria-label="Open capture history" title="Capture history" className="ctl-btn"><History className="h-3.5 w-3.5" /></button>
          {closable && <button type="button" onClick={() => act('close_hud')} aria-label="Close capture control" title="Close (reopen from the menu bar)" className="ctl-btn ctl-close"><X className="h-3.5 w-3.5" /></button>}
        </div>
      </div>
      </div>
      {sheet === 'live' && (
        <HudSheet key="live" onHeight={setSheetNeeds} follow={transcript.text}>
          {transcript.text ? <p>{transcript.text}</p> : hint && <p className="ctl-sheet-hint">{hint}</p>}
        </HudSheet>
      )}
      {sheet === 'result' && (
        <HudSheet
          key={`result-${state.sessionId}`}
          onHeight={setSheetNeeds}
          footer={transcript.text ? (
            <>
              {transcript.notice && <span className="ctl-sheet-notice" title={transcript.notice}>{transcript.notice.includes('Accessibility') ? 'Not pasted' : transcript.notice}</span>}
              <span className="ctl-sheet-spacer" />
              {transcript.notice?.includes('Accessibility') && (
                <button type="button" className="ctl-btn ctl-sheet-btn" onClick={() => act('open_privacy_settings', { pane: 'accessibility' })}><ShieldCheck className="h-3.5 w-3.5" />Allow pasting</button>
              )}
              <button type="button" className="ctl-btn ctl-sheet-btn" onClick={() => copy('copy_text', { text: transcript.text })}>{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy'}</button>
            </>
          ) : undefined}
        >
          {transcript.text ? <p>{transcript.text}</p> : transcript.notice && <p className="ctl-sheet-notice">{transcript.notice}</p>}
        </HudSheet>
      )}
      {sheet === 'image' && (
        <HudSheet
          key={`image-${state.sessionId}`}
          onHeight={setSheetNeeds}
          footer={(
            <>
              <span className="ctl-sheet-notice">{copied ? 'Copied — press ⌘V to paste' : 'Saved'}</span>
              <span className="ctl-sheet-spacer" />
              <button type="button" className="ctl-btn ctl-sheet-btn" onClick={() => act('show_launcher')}><Maximize2 className="h-3.5 w-3.5" />Open</button>
              <button type="button" className="ctl-btn ctl-sheet-btn" onClick={() => copy('copy_capture_media', { id: state.sessionId })}><Copy className="h-3.5 w-3.5" />Copy</button>
            </>
          )}
        >
          <button type="button" className="ctl-shot" onClick={() => act('show_launcher')} aria-label="Open the screenshot" title="Open the screenshot">
            {imageSrc ? <img src={imageSrc} alt="" draggable={false} /> : <span className="ctl-shot-wait" />}
          </button>
        </HudSheet>
      )}
    </div>
  );
}

/** The mascot mirrors the capture: eaves up only while the mic is really live. */
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

/**
 * What the transcript under the bar shows. While recording: what has been
 * heard. After: the words that were pasted or stored, or the notice about
 * where they went ("Copied — …") over what was heard. A failure shows why.
 */
function hudTranscript(state: HudState | null, running: RunningTranscript): { text: string; notice: string | null } {
  if (!state) return { text: '', notice: null };
  const heard = state.sessionId && running.sessionId === state.sessionId ? runningText(running) : '';
  const message = state.message?.trim() || null;
  switch (state.phase) {
    case 'recording':
    case 'transcribing':
      return { text: heard, notice: null };
    case 'saved':
      return { text: heard, notice: state.notice ?? null };
    case 'done':
      return { text: message ?? heard, notice: state.notice ?? null };
    case 'failed':
      return { text: '', notice: message };
    default:
      return { text: '', notice: null };
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <Hud />
  </StrictMode>,
);
