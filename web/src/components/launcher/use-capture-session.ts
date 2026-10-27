import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  cancelCapture,
  captureScreenshot,
  checkPermissions,
  errMsg,
  getCaptureStatus,
  hidePanel,
  onCaptureState,
  startAudioCapture,
  startScreenCapture,
  stopCapture,
  type CaptureSession,
  type CaptureStatus,
  type Permissions,
} from '@/lib/desktop/bridge';
import type { CaptureKind, LiveCapture } from './capture-toolbar';
import {
  cancelFailureNotice,
  captureNeeds,
  deniedNotice,
  noticeResolved,
  screenshotNotice,
  startFailureNotice,
  stopFailureNotice,
  type PanelNotice,
} from './panel-notice';
import type { BeginRecording, Flash, RunTask } from './types';

export interface PanelRecording {
  session: CaptureSession;
  mode: 'audio' | 'screen';
}

/** Talk, Meeting or Video, from what is recording. */
export function captureKind(recording: PanelRecording): CaptureKind {
  if (recording.mode === 'screen') return 'video';
  return recording.session.source === 'mic' ? 'talk' : 'meeting';
}

/** A notice with what its button does when that is "Try again". */
export type SessionNotice = PanelNotice & { retry?: () => void };

/**
 * The capture the panel started or is showing (the HUD owns the session; this
 * mirrors it for the live bar), and the one warn notice its failures leave.
 */
export function useCaptureSession({ flash, runTask, projectIdRef, permissions, setPermissions, onStopped }: {
  flash: Flash;
  runTask: RunTask;
  /** Read when a recording starts, so starting doesn't wait on the project list. */
  projectIdRef: RefObject<string | undefined>;
  permissions: Permissions | null;
  setPermissions: (permissions: Permissions | null) => void;
  /** A capture stopped from the panel: the history should catch up. */
  onStopped?: () => void;
}) {
  const busy = useRef(false);
  const [starting, setStarting] = useState(false);
  // A screenshot is being taken: the toolbar waits, but nothing is recording.
  const [shooting, setShooting] = useState(false);
  // A capture started elsewhere (hotkey, HUD) whose mic is still opening.
  const [opening, setOpening] = useState(false);
  // Checking permissions before a start: the panel stays put meanwhile.
  const [preflighting, setPreflighting] = useState(false);
  const [recording, setRecording] = useState<PanelRecording | null>(null);
  const [phase, setPhase] = useState('idle');
  const [notice, setNotice] = useState<SessionNotice | null>(null);
  const stopped = useRef(onStopped);
  stopped.current = onStopped;

  const clearNotice = useCallback(() => setNotice(null), []);
  // Turned on in System Settings: the notice has nothing left to say.
  useEffect(() => {
    if (noticeResolved(notice, permissions)) setNotice(null);
  }, [notice, permissions]);

  const begin = useCallback<BeginRecording>(async (mode, opts) => {
    if (busy.current) return;
    busy.current = true;
    const source = opts?.source ?? 'mixed';
    const retry = () => runTask(() => begin(mode, opts));
    setStarting(true);
    setNotice(null);
    try {
      const needs = captureNeeds(mode, source, opts?.mic ?? false);
      setPreflighting(true);
      let checked: Permissions | null;
      try {
        checked = await checkPermissions({ needScreen: needs.screen });
      } finally {
        setPreflighting(false);
      }
      const denied = deniedNotice(needs, checked);
      if (denied) {
        // Said in place, with the button that fixes it: the panel doesn't switch views.
        setPermissions(checked);
        setNotice(denied);
        return;
      }
      const session = mode === 'screen'
        ? await startScreenCapture(opts?.mic ?? false)
        : await startAudioCapture(source, opts?.contextBlurb, opts?.dictation, projectIdRef.current);
      if (session) {
        setRecording({ session: { ...session, started_at_ms: session.started_at_ms ?? Date.now() }, mode });
        // Talk pastes into the app underneath, and Video records the screen:
        // both need the panel gone. A meeting keeps its live bar in view.
        if (source === 'mic' || mode === 'screen') await hidePanel();
      }
    } catch (error) {
      setNotice({ ...startFailureNotice(errMsg(error, '')), retry });
    } finally {
      busy.current = false;
      setStarting(false);
    }
  }, [projectIdRef, runTask, setPermissions]);

  const stop = useCallback(async () => {
    if (!recording || busy.current) return;
    busy.current = true;
    const id = recording.session.session_id;
    const kind = captureKind(recording);
    try {
      await stopCapture(id);
      // The HUD says what happened to a Talk; the capture state decides when
      // the live bar goes (a dictation is still being written down).
      const status = await getCaptureStatus().catch(() => null);
      if (!status || status.sessionId !== id || !['recording', 'transcribing'].includes(status.phase)) setRecording(null);
      if (kind !== 'talk') flash('Saved');
      stopped.current?.();
    } catch (error) {
      setNotice({ ...stopFailureNotice(errMsg(error, '')), retry: () => runTask(stop) });
    } finally {
      busy.current = false;
    }
  }, [recording, flash, runTask]);

  const cancel = useCallback(async () => {
    if (!recording || busy.current) return;
    busy.current = true;
    try {
      await cancelCapture(recording.session.session_id);
      setRecording(null);
      flash('Discarded');
    } catch (error) {
      setNotice({ ...cancelFailureNotice(errMsg(error, '')), retry: () => runTask(cancel) });
    } finally {
      busy.current = false;
    }
  }, [recording, flash, runTask]);

  const screenshot = useCallback(() => {
    runTask(async () => {
      if (busy.current) return;
      busy.current = true;
      setShooting(true);
      setNotice(null);
      try {
        await captureScreenshot();
      } catch (error) {
        const checked = await checkPermissions({ prompt: false, needScreen: false }).catch(() => null);
        if (checked) setPermissions(checked);
        const failed = screenshotNotice(errMsg(error, ''), checked);
        if (failed) setNotice({ ...failed, retry: screenshot });
      } finally {
        busy.current = false;
        setShooting(false);
      }
    }, 'Screenshot didn’t work');
  }, [runTask, setPermissions]);

  // Mirror the HUD's capture state, whoever started it.
  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    runTask(async () => {
      let received = false;
      const apply = (state: CaptureStatus) => {
        if (disposed) return;
        setPhase(state.phase);
        setOpening(state.phase === 'recording' && !state.sessionId);
        // Stopped and being written down: the live bar stays until the words land.
        if (state.phase === 'transcribing') return;
        if (state.phase === 'recording' && state.sessionId) {
          setRecording((current) => current?.session.session_id === state.sessionId ? current : {
            session: { session_id: state.sessionId!, started_at_ms: state.startedAtMs ?? Date.now(), mode: state.mode ?? 'audio', source: 'mic' },
            mode: state.mode === 'screen' || state.mode === 'video' ? 'screen' : 'audio',
          });
        } else {
          setRecording((current) => current?.session.session_id === state.sessionId ? null : current);
        }
      };
      const off = await onCaptureState((state) => { received = true; apply(state); });
      const initial = await getCaptureStatus();
      if (!disposed && !received && initial) apply(initial);
      if (disposed) off(); else unlisteners.push(off);
    });
    return () => { disposed = true; unlisteners.forEach((off) => off()); };
  }, [runTask]);

  // Only changes when the capture does, so the history below can skip re-rendering.
  const live = useMemo<LiveCapture | null>(() => {
    if (recording) {
      return {
        sessionId: recording.session.session_id,
        kind: captureKind(recording),
        phase: phase === 'transcribing' ? 'thinking' : 'listening',
        startedAtMs: recording.session.started_at_ms,
      };
    }
    if ((starting && !preflighting) || opening) return { sessionId: null, kind: 'talk', phase: 'listening', startedAtMs: null };
    return null;
  }, [recording, phase, starting, preflighting, opening]);

  return {
    recording,
    phase,
    live,
    starting,
    shooting,
    preflighting,
    notice,
    clearNotice,
    begin,
    stop,
    cancel,
    screenshot,
  };
}
