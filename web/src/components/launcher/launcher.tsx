'use client';

import { useRouter } from '@/lib/next-compat/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getSettings,
  getCaptureStatus,
  getSetupStatus,
  hidePanel,
  relaunchApp,
  isDesktop,
  onLauncherOpened,
  onLauncherSettings,
  onLauncherSetup,
  cancelPairing,
  errMsg,
  onLauncherRecordings,
  onCaptureState,
  onRecordingsUpdated,
  pairDevice,
  checkPermissions,
  captureScreenshot,
  importFiles,
  onDragDrop,
  pasteToComposer,
  pickAndImportFiles,
  saveNote,
  type ImportResult,
  startAudioCapture,
  startScreenCapture,
  stopCapture,
  setPanelPinned,
  getAccountInfo,
  disconnectAccount,
  openWebApp,
  type CaptureSession,
  type CaptureStatus,
  type Permissions,
  type PrivacyPane,
} from '@/lib/desktop/bridge';
import { CaptureHistory, plainTranscript, type LiveCapture } from '@/components/launcher/capture-history';
import { SettingsView, type AccountState } from '@/components/launcher/settings-view';
import { loadRecordings } from '@/lib/launcher/data';
import { prettyAccel } from '@/lib/launcher/accel';
import type { Recording } from '@/lib/launcher/types';
import { cn } from '@/lib/utils';
import { ResizeHandles } from './resize-handles';
import { SetupView } from './setup-view';
import { ContextView } from './context-view';
import { RecordingView, StartingView } from './recording-views';
import { useToastTasks } from './use-toast-tasks';
import { useSignedOut } from './use-signed-out';
import { useLauncherCommands } from './use-launcher-commands';
import { useLauncherItems } from './use-launcher-items';
import { useRecordingActions } from './use-recording-actions';
import { useLauncherKeyDown } from './use-launcher-keydown';
import { TitleBar } from './title-bar';
import { CaptureToolbar, type CaptureKind } from './capture-toolbar';
import { Composer, Mascot, type ComposerHandle } from './ui';
import { PaletteView } from './palette-view';
import { useSetupPermissions } from './use-setup-permissions';
import { usesFnKey } from './permission-checklist';

export { plainTranscript };

export function Launcher() {
  const router = useRouter();
  const desktop = isDesktop();
  const now = useRef(Date.now()).current;

  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionsQuery, setActionsQuery] = useState('');
  const [actionsSel, setActionsSel] = useState(0);
  const captureBusy = useRef(false);
  const [starting, setStarting] = useState(false);
  const [view, setView] = useState<'setup' | 'list' | 'context' | 'settings'>(
    desktop ? 'setup' : 'list',
  );
  const [setupPaired, setSetupPaired] = useState(false);
  const [account, setAccount] = useState<AccountState>(undefined);
  const [connecting, setConnecting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [setupKnown, setSetupKnown] = useState(!desktop);
  const setupForced = useRef(false);
  const [setupStep, setSetupStep] = useState(0);
  // Settings opened from setup's Shortcuts step: Back returns there instead of to the list.
  const settingsFromSetup = useRef(false);
  const connectingRef = useRef(false);
  const [toggleHotkey, setToggleHotkey] = useState('⌘⇧Space');
  const [dictationHotkey, setDictationHotkey] = useState('');
  const [recording, setRecording] = useState<{
    session: CaptureSession;
    mode: 'audio' | 'screen';
  } | null>(null);
  const [capturePhase, setCapturePhase] = useState('idle');
  const [elapsed, setElapsed] = useState(0);

  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusPanel = useCallback(() => {
    const target = searchRef.current ?? panelRef.current;
    target?.focus({ preventScroll: true });
    searchRef.current?.select();
  }, []);
  const actionsInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const { toast, flash, runTask } = useToastTasks();
  // However Settings is left (title bar, Esc, tray, panel reopening), the detour is over.
  useEffect(() => {
    if (view !== 'settings') settingsFromSetup.current = false;
  }, [view]);
  const {
    setupPermissions,
    setSetupPermissions,
    checkingSetupPermissions,
    requestSetupPermission,
    openPrivacy,
    finishSetup,
  } = useSetupPermissions({
    desktop,
    view,
    setView,
    setupForced,
    searchRef,
    flash,
    runTask,
  });

  // A quiet, lasting note on the list while something dictation relies on is off.
  const permissionNudge: { text: string; pane: PrivacyPane } | null = !setupPermissions
    ? null
    : setupPermissions.accessibility === false
      ? { text: 'Dictation is copied, not pasted: Accessibility is off for Eavesy.', pane: 'accessibility' }
      : setupPermissions.inputMonitoring === false && usesFnKey(dictationHotkey, toggleHotkey)
        ? { text: 'fn can’t start dictation: Input Monitoring is off for Eavesy.', pane: 'input_monitoring' }
        : null;

  /** Reloads the list; on failure keeps what is shown and says the list is stale. */
  const refreshRecordings = useCallback(async () => {
    try {
      setRecordings(await loadRecordings(now));
      setLoadError(null);
    } catch (error) {
      setLoadError(errMsg(error, 'Could not load recordings'));
    }
  }, [now]);

  /** Something landed in the history from the composer: show it and say so quietly. */
  const landed = useCallback((result?: ImportResult | null) => {
    if (result && result.skipped.length) flash(result.skipped.join(' '), 5000, 'warn');
    if (!result || result.ids.length) {
      historyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      composerRef.current?.confirm();
    }
  }, [flash]);

  /** ⌘V outside a text field: files and images save at once, text becomes a draft. */
  const pasteFromClipboard = useCallback(() => {
    runTask(async () => {
      const outcome = await pasteToComposer();
      if (outcome.kind === 'text') composerRef.current?.insertText(outcome.text);
      else landed({ ids: Array.from({ length: outcome.count }, () => ''), skipped: outcome.skipped });
    }, 'Couldn’t paste that');
  }, [landed, runTask]);

  const refreshAccount = useCallback(async () => {
    if (!desktop) return;
    const info = await getAccountInfo();
    setAccount(info);
    setSetupPaired(info !== null);
  }, [desktop]);

  useEffect(() => { runTask(refreshAccount); }, [refreshAccount, runTask]);

  const refreshSetup = useCallback(
    async (chooseView = false) => {
      if (!desktop) return;
      try {
        const status = await getSetupStatus();
        if (status) setSetupPaired(status.paired);
        if (chooseView) {
          setView((current) =>
            current === 'settings' || (current === 'setup' && setupForced.current)
              ? current
              : status && !status.completed
                ? 'setup'
                : 'list',
          );
        }
      } finally {
        setSetupKnown(true);
      }
    },
    [desktop],
  );

  const keepPinned =
    desktop && (view === 'setup' || view === 'settings' || checkingSetupPermissions !== null || preflighting);
  useEffect(() => {
    if (!desktop) return;
    runTask(() => setPanelPinned(keepPinned), 'Could not keep settings open');
  }, [desktop, keepPinned, runTask]);

  const deniedPermission = useCallback(
    async (
      mode: 'audio' | 'screen',
      source: 'mixed' | 'system' | 'mic',
      withMic: boolean,
    ): Promise<string | null> => {
      const needsMic = mode === 'screen' ? withMic : source !== 'system';
      const needsScreen = mode === 'screen' || source !== 'mic';
      setPreflighting(true);
      let perms: Permissions | null;
      try {
        perms = await checkPermissions({ needScreen: needsScreen });
      } finally {
        setPreflighting(false);
      }
      if (!perms) return null;
      if ((needsMic && !perms.mic) || (needsScreen && !perms.screen)) {
        setSetupPermissions(perms);
        if (needsMic && !perms.mic) {
          setupForced.current = true;
          setView('setup');
        } else {
          setView('settings');
        }
      }
      if (needsMic && !perms.mic) {
        return 'Microphone access is off. Turn it on in System Settings → Privacy & Security → Microphone.';
      }
      if (needsScreen && !perms.screen) {
        return 'Screen Recording access is off. Turn it on in System Settings → Privacy & Security → Screen Recording, then quit and reopen Eavesy.';
      }
      return null;
    },
    [setSetupPermissions],
  );

  const beginRecording = useCallback(
    async (
      mode: 'audio' | 'screen',
      opts?: {
        source?: 'mixed' | 'system' | 'mic';
        mic?: boolean;
        contextBlurb?: string;
        dictation?: boolean;
      },
    ) => {
      if (captureBusy.current) return;
      captureBusy.current = true;
      const source = opts?.source ?? 'mixed';
      setStarting(true);
      try {
        const denied = await deniedPermission(mode, source, opts?.mic ?? false);
        if (denied) {
          flash(denied, 8000);
          return;
        }
        const session =
          mode === 'screen'
            ? await startScreenCapture(opts?.mic ?? false)
            : await startAudioCapture(source, opts?.contextBlurb, opts?.dictation);
        if (session) {
          setRecording({ session, mode });
          setView('list');
          setElapsed(0);
          await hidePanel();
        }
      } catch (e) {
        flash(errMsg(e, 'Could not start recording'), 8000);
      } finally {
        captureBusy.current = false;
        setStarting(false);
      }
    },
    [flash, deniedPermission],
  );

  const beginMeetingRecording = useCallback(() => {
    if (desktop) {
      setView('context');
      return;
    }
    void beginRecording('audio', { source: 'mixed' });
  }, [beginRecording, desktop]);

  const stopRecording = useCallback(async () => {
    if (!recording || captureBusy.current) return;
    captureBusy.current = true;
    const id = recording.session.session_id;
    try {
      await stopCapture(id);
      setRecording(null);
      flash('Recording saved');
      await refreshRecordings();
      setQuery('');
      setSelected(0);
    } catch (e) {
      flash(errMsg(e, 'Could not save recording'), 8000);
    } finally { captureBusy.current = false; }
  }, [recording, flash, refreshRecordings]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    runTask(async () => {
      let receivedCaptureState = false;
      const applyCaptureState = (state: CaptureStatus) => {
        if (disposed) return;
        setCapturePhase(state.phase);
        if (state.phase === 'recording' && state.sessionId) {
          setRecording((current) => current?.session.session_id === state.sessionId ? current : {
            session: { session_id: state.sessionId!, started_at_ms: state.startedAtMs ?? Date.now(), mode: state.mode ?? 'audio', source: 'mic' },
            mode: state.mode === 'screen' || state.mode === 'video' ? 'screen' : 'audio',
          });
        } else {
          setRecording((current) => current?.session.session_id === state.sessionId ? null : current);
        }
      };
      const listeners = await Promise.all([
        onLauncherSettings(() => setView('settings')),
        onLauncherRecordings(() => { setView((v) => (v === 'setup' ? v : 'list')); historyRef.current?.scrollTo({ top: 0 }); }),
        onLauncherSetup(() => { setupForced.current = true; setSetupStep(0); setView('setup'); }),
        onCaptureState((state) => {
          receivedCaptureState = true;
          applyCaptureState(state);
        }),
      ]);
      const initial = await getCaptureStatus();
      if (!disposed && !receivedCaptureState && initial) applyCaptureState(initial);
      if (disposed) listeners.forEach((off) => off()); else unlisteners.push(...listeners);
    });
    return () => { disposed = true; unlisteners.forEach((off) => off()); };
  }, [runTask]);

  useEffect(() => {
    if (!recording) return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - (recording.session.started_at_ms ?? Date.now())) / 1000)));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [recording]);

  useEffect(() => {
    runTask(async () => {
      await refreshRecordings();
    }, 'Could not load recordings');
    runTask(async () => {
      const settings = await getSettings();
      if (settings?.toggle_hotkey) setToggleHotkey(prettyAccel(settings.toggle_hotkey));
      if (settings?.dictation_hotkey) setDictationHotkey(prettyAccel(settings.dictation_hotkey));
    }, 'Could not load desktop settings');
    runTask(() => refreshSetup(true), 'Could not load setup status');
  }, [refreshRecordings, refreshSetup, runTask]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    runTask(async () => {
      const stopListening = await onRecordingsUpdated(() => {
        runTask(async () => {
          await refreshRecordings();
        }, 'Could not refresh recordings');
      });
      if (disposed) stopListening();
      else unlisten = stopListening;
    }, 'Could not watch recording updates');
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshRecordings, runTask]);

  const signedOut = useSignedOut(desktop, runTask);

  const liveKind: CaptureKind | null = recording
    ? recording.mode === 'screen'
      ? 'video'
      : recording.session.source === 'mic'
        ? 'talk'
        : 'meeting'
    : null;
  const live: LiveCapture | null = recording
    ? { sessionId: recording.session.session_id, kind: liveKind ?? 'talk', phase: capturePhase === 'transcribing' ? 'thinking' : 'listening', elapsed }
    : starting
      ? { sessionId: null, kind: 'talk', phase: 'listening', elapsed: 0 }
      : null;

  const takeScreenshot = useCallback(() => {
    runTask(async () => {
      if (captureBusy.current) return;
      captureBusy.current = true;
      setStarting(true);
      try {
        await captureScreenshot();
      } finally {
        captureBusy.current = false;
        setStarting(false);
      }
    }, 'Screenshot didn’t work');
  }, [runTask]);

  // Native drag-drop (real file paths): the composer becomes the drop target.
  // Subscribed once; the handler reads the latest callbacks through a ref.
  const onDrop = useRef<(paths: string[]) => void>(() => {});
  useEffect(() => {
    onDrop.current = (paths) => runTask(async () => landed(await importFiles(paths)), 'Couldn’t add those files');
  }, [landed, runTask]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onDragDrop((event) => {
      if (event.type === 'enter' || event.type === 'over') setDragging(true);
      else if (event.type === 'leave') setDragging(false);
      else {
        setDragging(false);
        setView('list');
        onDrop.current(event.paths);
      }
    })
      .then((off) => { if (disposed) off(); else unlisten = off; })
      .catch((error: unknown) => flash(errMsg(error, 'Couldn’t listen for dropped files'), 5000, 'warn'));
    return () => { disposed = true; unlisten?.(); };
  }, [desktop, flash]);


  useEffect(() => {
    focusPanel();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    runTask(async () => {
      const stopListening = await onLauncherOpened(() => {
        setupForced.current = false;
        setView((v) => (desktop && v === 'setup' ? v : 'list'));
        historyRef.current?.scrollTo({ top: 0 });
        setQuery('');
        setSelected(0);
        setActionsOpen(false);
        if (desktop) {
          runTask(() => refreshSetup(true), 'Could not refresh setup status');
          runTask(refreshAccount);
        } else setView('list');
        requestAnimationFrame(focusPanel);
      });
      if (disposed) stopListening();
      else unlisten = stopListening;
    }, 'Could not register the launcher shortcut');
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop, focusPanel, refreshSetup, refreshAccount, runTask]);

  const connectAccount = useCallback(async () => {
    if (!desktop || connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    try {
      await hidePanel();
      await pairDevice();
      flash('Account connected');
    } catch (error) {
      const message = errMsg(error, 'Could not connect account');
      if (!/cancelled/i.test(message)) flash(message, 6000);
    } finally {
      connectingRef.current = false;
      setConnecting(false);
      await refreshAccount();
      await refreshSetup(true);
    }
  }, [desktop, flash, refreshAccount, refreshSetup]);

  const cancelConnect = useCallback(() => {
    runTask(cancelPairing, 'Could not cancel sign-in');
  }, [runTask]);

  const goSettings = useCallback(() => {
    if (desktop) {
      setView('settings');
      return;
    }
    runTask(() => router.push('/app/settings'), 'Could not open settings');
  }, [desktop, router, runTask]);

  // Document-level keys for the history view, so they work wherever focus is
  // (the panel div only gets keys while it has focus): ⌘V pastes, / searches,
  // N writes a note, Esc closes.
  useEffect(() => {
    if (!desktop || view !== 'list') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable);
      // A menu handles its own keys, even when focus has left it for the body.
      const inMenu = !!target?.closest('[role="menu"]') || !!document.querySelector('[role="menu"][data-state="open"]');
      if (inMenu) return;
      if (typing) {
        if (e.key === 'Escape' && target === searchRef.current && !searchRef.current.value) {
          e.preventDefault();
          runTask(hidePanel, 'Couldn’t close the panel');
        }
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === ',') {
        e.preventDefault();
        goSettings();
      } else if (meta && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        pasteFromClipboard();
      } else if (!meta && !e.altKey && e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (!meta && !e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        composerRef.current?.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        runTask(hidePanel, 'Couldn’t close the panel');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [desktop, view, pasteFromClipboard, goSettings, runTask]);

  const commands = useLauncherCommands({
    desktop,
    router,
    runTask,
    beginRecording,
    beginMeetingRecording,
    connectAccount,
    goSettings,
  });

  const { items, commandCount } = useLauncherItems(commands, recordings, query);

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items.length]);

  const current = items[selected];
  const currentRec = current?.kind === 'recording' ? current.rec : null;

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${selected}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const openRecording = useCallback(
    (rec: Recording) => {
      if (rec.id.startsWith('demo_')) {
        flash('Demo recording — sign in to open');
        return;
      }
      if (desktop) runTask(hidePanel, 'Could not close the launcher');
      runTask(
        () => router.push(`/app/meetings/${rec.id}`),
        'Could not open recording',
      );
    },
    [desktop, router, flash, runTask],
  );

  const actions = useRecordingActions({
    current,
    currentRec,
    desktop,
    flash,
    runTask,
    setActionsOpen,
    openRecording,
  });

  const filteredActions = useMemo(() => {
    const q = actionsQuery.trim();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()));
  }, [actions, actionsQuery]);

  useEffect(() => {
    setActionsSel((s) => Math.min(s, Math.max(0, filteredActions.length - 1)));
  }, [filteredActions.length]);

  const runPrimary = useCallback(() => {
    if (!current) return;
    if (current.kind === 'command') {
      runTask(current.run);
      return;
    }
    openRecording(current.rec);
  }, [current, openRecording, runTask]);


  const openActions = useCallback(() => {
    if (!current) return;
    setActionsQuery('');
    setActionsSel(0);
    setActionsOpen(true);
    requestAnimationFrame(() => actionsInputRef.current?.focus());
  }, [current]);

  const onKeyDown = useLauncherKeyDown({
    desktop,
    view,
    setView,
    actionsOpen,
    setActionsOpen,
    actionsSel,
    setActionsSel,
    setSelected,
    setQuery,
    query,
    items,
    filteredActions,
    currentRec,
    searchRef,
    runPrimary,
    goSettings,
    openActions,
    flash,
    runTask,
  });

  const reloadShortcuts = () => runTask(async () => {
    const saved = await getSettings();
    if (saved) {
      setToggleHotkey(prettyAccel(saved.toggle_hotkey));
      setDictationHotkey(prettyAccel(saved.dictation_hotkey));
    }
  });

  return (
    <div
      className={cn(
        'launcher-scope fixed inset-0 flex',
        desktop ? 'items-stretch justify-stretch' : 'items-center justify-center',
      )}
      data-desktop={desktop ? 'true' : 'false'}
    >
      {!desktop && <div className="launcher-scrim absolute inset-0" />}
      <div
        data-dragging={dragging}
        className={cn(
          'launcher-panel ev-panel relative z-10 flex flex-col overflow-hidden border border-border',
          desktop
            ?
              'h-full w-full rounded-[12px]'
            : 'h-[min(460px,92vh)] w-[min(92vw,720px)] rounded-2xl',
          'outline-none',
        )}
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {desktop && <ResizeHandles />}
        {desktop && (
          <TitleBar
            view={view}
            account={account}
            connecting={connecting}
            signedOut={signedOut}
            goSettings={goSettings}
            goBack={() => setView(view === 'settings' && settingsFromSetup.current ? 'setup' : 'list')}
            connect={() => runTask(connectAccount, 'Couldn’t connect your account')}
            disconnect={() => runTask(async () => { await disconnectAccount(); await refreshAccount(); flash('Signed out on this Mac'); })}
            runTask={runTask}
          />
        )}
        {desktop && view === 'list' && (
          <CaptureToolbar
            active={liveKind}
            elapsed={elapsed}
            busy={starting}
            dictationHotkey={dictationHotkey}
            onTalk={() => runTask(() => beginRecording('audio', { source: 'mic', dictation: true }))}
            onMeeting={() => runTask(() => beginRecording('audio', { source: 'mixed' }))}
            onVideo={() => runTask(() => beginRecording('screen', { mic: true }))}
            onScreenshot={takeScreenshot}
            onStop={() => runTask(stopRecording, 'Couldn’t stop the recording')}
          />
        )}
        {desktop && view === 'list' && signedOut && account !== null && (
          <div role="alert" className="ev-banner">
            <span>Sync is paused. Captures stay on this Mac until you sign in again.</span>
            <button type="button" className="ev-link" disabled={connecting} onClick={() => runTask(connectAccount, 'Couldn’t connect your account')}>Sign in</button>
          </div>
        )}
        {desktop && view === 'list' && permissionNudge && (
          <div role="status" className="ev-banner" data-tone="quiet">
            <span>{permissionNudge.text}</span>
            <button type="button" className="ev-link" onClick={() => openPrivacy(permissionNudge.pane)}>Open Settings</button>
          </div>
        )}
        {desktop && !setupKnown ? (
          <div className="min-h-0 flex-1" aria-busy="true" />
        ) : view === 'setup' && (desktop || !recording) ? (
          <SetupView
            step={setupStep}
            onStep={setSetupStep}
            paired={setupPaired}
            connecting={connecting}
            account={account}
            permissions={setupPermissions}
            checking={checkingSetupPermissions}
            listening={!!recording}
            dictationHotkey={dictationHotkey}
            toggleHotkey={toggleHotkey}
            onConnect={() => runTask(connectAccount, 'Could not connect account')}
            onCancelConnect={cancelConnect}
            onRequest={requestSetupPermission}
            onOpenPrivacy={openPrivacy}
            onRelaunch={() => runTask(relaunchApp, 'Could not reopen Eavesy')}
            onShortcutsChanged={reloadShortcuts}
            onFinish={() => runTask(async () => {
              // The toast is about Talk, so it looks at the dictation shortcut alone.
              if (!(await finishSetup())) return;
              flash(usesFnKey(dictationHotkey) ? 'You’re set. Tap fn anywhere to talk.' : `You’re set. Press ${dictationHotkey || '⌘⇧D'} anywhere to talk.`, 5000);
            }, 'Could not finish setup')}
          />
        ) : view === 'settings' ? (
          <SettingsView
            permissions={setupPermissions}
            checkingPermission={checkingSetupPermissions}
            onRequestPermission={requestSetupPermission}
            onOpenPrivacy={openPrivacy}
            onRelaunch={() => runTask(relaunchApp, 'Could not reopen Eavesy')}
            onRunSetup={() => { setupForced.current = true; setSetupStep(0); setView('setup'); }}
            fnInUse={usesFnKey(dictationHotkey, toggleHotkey)}
            account={account}
            connecting={connecting}
            onCancelConnect={cancelConnect}
            onDisconnect={() => runTask(async () => { await disconnectAccount(); await refreshAccount(); flash('Signed out on this Mac'); })}
            onShortcutsChanged={reloadShortcuts}
            onBack={() => setView('list')}
            onConnect={() => runTask(connectAccount, 'Could not connect account')}
            onOpenWeb={() => runTask(openWebApp, 'Could not open the web app')}
          />
        ) : starting && !recording && !desktop ? (
          <StartingView />
        ) : view === 'context' && !recording ? (
          <ContextView
            onBack={() => setView('list')}
            onStart={(contextBlurb) =>
              runTask(
                () => beginRecording('audio', { source: 'mixed', contextBlurb }),
                'Could not start recording',
              )
            }
          />
        ) : recording && !desktop ? (
          <RecordingView
            mode={recording.mode}
            elapsed={elapsed}
            onStop={() => runTask(stopRecording, 'Could not stop recording')}
          />
        ) : desktop ? (
          <div className="ev-history">
            <CaptureHistory
              recordings={recordings}
              live={live}
              signedIn={account !== null}
              onSignIn={() => runTask(connectAccount, 'Couldn’t connect your account')}
              flash={flash}
              runTask={runTask}
              searchRef={searchRef}
              scrollRef={historyRef}
              loadError={loadError}
              onRetry={() => runTask(refreshRecordings)}
            />
            <Composer
              ref={composerRef}
              dragActive={dragging}
              onSaveError={(error) => flash(errMsg(error, 'Couldn’t save that note'), 5000, 'warn')}
              onSaveNote={async (text) => {
                await saveNote(text);
                historyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              onFiles={pasteFromClipboard}
              onPick={() => runTask(async () => landed(await pickAndImportFiles()), 'Couldn’t add those files')}
              onEscapeEmpty={() => runTask(hidePanel)}
            />
          </div>
        ) : (
          <PaletteView
            desktop={desktop}
            setupPaired={setupPaired}
            query={query}
            setQuery={setQuery}
            selected={selected}
            setSelected={setSelected}
            items={items}
            commandCount={commandCount}
            now={now}
            current={current}
            currentRec={currentRec}
            searchRef={searchRef}
            listRef={listRef}
            runPrimary={runPrimary}
            flash={flash}
            runTask={runTask}
            actionsOpen={actionsOpen}
            setActionsOpen={setActionsOpen}
            openActions={openActions}
            actionsQuery={actionsQuery}
            setActionsQuery={setActionsQuery}
            actionsSel={actionsSel}
            setActionsSel={setActionsSel}
            actionsInputRef={actionsInputRef}
            filteredActions={filteredActions}
            onKeyDown={onKeyDown}
            beginMeetingRecording={beginMeetingRecording}
            beginRecording={beginRecording}
            goSettings={goSettings}
            toggleHotkey={toggleHotkey}
          />
        )}

        {toast && (
          <div className="ev-toast" role="status" data-tone={toast.tone}>
            <Mascot size={16} state={toast.tone === 'warn' ? 'confused' : 'happy'} />
            {toast.message}
          </div>
        )}
      </div>
    </div>
  );
}
