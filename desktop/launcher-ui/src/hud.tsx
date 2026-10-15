import { StrictMode, useEffect, useState, type MouseEvent } from 'react';
import { Camera, History, Mic, Square, Video, X } from 'lucide-react';
import { includeComputerAudio } from '@/lib/desktop/capture-prefs';
import { errMsg } from '@/lib/desktop/errors';
import { captionTail, trackLabel, type LiveCaption } from '@/lib/desktop/live-captions';
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
  const total = Math.max(0, Math.floor((now - startedAtMs) / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function browserPreviewState(): HudState | null {
  if (tauri()) return null;
  const phase = (new URLSearchParams(window.location.search).get('hud') ??
    'idle') as Phase;
  return {
    phase,
    sessionId: 'preview',
    mode: 'audio',
    startedAtMs: Date.now() - 78_000,
    message: null,
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
      });
      if (disposed) off?.(); else unlisten = off;
    })().catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const act = (cmd: string, args?: Record<string, unknown>) => {
    setActionError(null);
    void invoke(cmd, args).catch((error: unknown) => setActionError(errMsg(error, 'Could not complete action')));
  };

  const readyToCapture = async (mode: 'audio' | 'video' | 'image', mixed: boolean): Promise<boolean> => {
    const setup = (await invoke('get_setup_status')) as { completed?: boolean } | undefined;
    if (setup && !setup.completed) {
      await invoke('show_setup');
      return false;
    }
    const needsScreen = mode !== 'audio' || mixed;
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
      const mixed = mode === 'audio' && includeComputerAudio();
      if (!(await readyToCapture(mode, mixed))) return;
      if (mode === 'image') await invoke('capture_screenshot');
      else if (mode === 'video') await invoke('start_screen_capture', { mic: true });
      else await invoke('start_capture', { source: mixed ? 'mixed' : 'mic' });
    }
    catch (error) {
      const message = errMsg(error, mode === 'image' ? 'Could not take the screenshot' : 'Could not start recording');
      setActionError(message);
      void invoke('show_notice', { title: mode === 'image' ? "Eavesy couldn't take the screenshot" : "Eavesy couldn't start recording", body: message }).catch(() => {});
    }
    finally { setStarting(false); }
  };

  useEffect(() => {
    if (!state || !['saved', 'done', 'failed'].includes(state.phase)) return;
    const sessionId = state.sessionId;
    const timeout = window.setTimeout(() => {
      void invoke('dismiss_hud', { sessionId }).catch(() => {});
    }, 3500);
    return () => window.clearTimeout(timeout);
  }, [state?.phase, state?.sessionId, state?.mode]);

  useEffect(() => {
    if (state?.phase !== 'recording') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state?.phase]);

  if (!state) return null;

  const recording = state.phase === 'recording';
  const liveCaptions = recording
    ? ['mic', 'system']
        .map((track) => captions[track])
        .filter((c): c is LiveCaption => !!c && c.sessionId === state.sessionId && !!c.text.trim())
    : [];
  const labelled = liveCaptions.length > 1;
  const closable = !recording && state.phase !== 'transcribing';
  const busy = starting || recording || state.phase === 'transcribing';

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

  return (
    <div aria-label={recording ? 'Eavesy recording' : 'Eavesy'} data-phase={state.phase} onMouseDown={pressSurface} onMouseEnter={loadShortcut} className="launcher-scope eavesy-control">
      <div className="ctl-grid">
        <button type="button" onClick={() => recording ? act('stop_capture', { sessionId: state.sessionId }) : act('show_launcher')} aria-label={recording ? 'Stop recording' : 'Open Eavesy'} title={recording ? 'Stop recording' : 'Open Eavesy'} className={`ctl-mark ${recording ? 'animate-recording-pulse' : ''}`}>
          {recording ? <Square className="h-2.5 w-2.5" fill="currentColor" /> : <span className="ctl-dot" />}
        </button>
        <div className="ctl-title" title={actionError ?? undefined}>
          {recording && <span className="font-mono tabular-nums text-white/75">{elapsedLabel(state.startedAtMs, now)}</span>}
          {liveCaptions.map((c) => (
            <span key={c.track} aria-live="polite" title={c.text} className={`ctl-caption ${c.isFinal ? 'text-white/90' : 'text-white/65'}`}>
              <bdi>{labelled && <span className="ctl-caption-label">{trackLabel(c.track)}</span>}{captionTail(c.text, 120)}</bdi>
            </span>
          ))}
          {state.phase === 'transcribing' && <span className="text-white/60">Transcribing…</span>}
          {actionError && <span role="alert" title={actionError} className="line-clamp-2 min-w-0 whitespace-normal leading-tight text-[#ffc9b5]">{actionError}</span>}
        </div>
        <div className="ctl-actions">
          <button type="button" disabled={starting || state.phase === 'transcribing'} onClick={() => recording ? act('stop_capture', { sessionId: state.sessionId }) : void startRecording()} aria-label={recording ? 'Stop & save' : 'Start voice note'} title={`${recording ? 'Stop & save' : 'Record microphone'}${shortcut ? ` (${shortcut})` : ''}`} className="ctl-btn">{recording ? <Square className="h-3 w-3" fill="currentColor" /> : <Mic className="h-3.5 w-3.5" />}<span className="ctl-label">{recording ? 'Stop' : 'Mic'}</span></button>
          <button type="button" disabled={busy} onClick={() => void startRecording('image')} aria-label="Take screenshot" title="Take screenshot" className="ctl-btn"><Camera className="h-3.5 w-3.5" /><span className="ctl-label">Screenshot</span></button>
          <button type="button" disabled={busy} onClick={() => void startRecording('video')} aria-label="Record screen video" title="Record screen video and audio" className="ctl-btn"><Video className="h-3.5 w-3.5" /><span className="ctl-label">Video</span></button>
        </div>
        <div className="ctl-tools">
          <button type="button" onClick={() => act('show_launcher')} aria-label="Open capture history" title="Capture history" className="ctl-btn"><History className="h-3.5 w-3.5" /></button>
          {closable && <button type="button" onClick={() => act('close_hud')} aria-label="Close capture control" title="Close (reopen from the menu bar)" className="ctl-btn ctl-close"><X className="h-3.5 w-3.5" /></button>}
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <Hud />
  </StrictMode>,
);
