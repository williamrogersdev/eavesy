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
  pasteClip,
  checkPermissions,
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
} from '@/lib/desktop/bridge';
import { CaptureHistory, plainTranscript } from '@/components/launcher/capture-history';
import { InProgressCapture } from '@/components/launcher/in-progress-capture';
import { includeComputerAudio, onCapturePrefsChanged } from '@/lib/desktop/capture-prefs';
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
import { CaptureToolbar } from './capture-toolbar';
import { PaletteView } from './palette-view';
import { useSetupPermissions } from './use-setup-permissions';

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
  const [withComputerAudio, setWithComputerAudio] = useState(false);
  useEffect(() => {
    setWithComputerAudio(includeComputerAudio());
    return onCapturePrefsChanged(() => setWithComputerAudio(includeComputerAudio()));
  }, []);
  const [preflighting, setPreflighting] = useState(false);
  const [setupKnown, setSetupKnown] = useState(!desktop);
  const setupForced = useRef(false);
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
    recording,
    setupPaired,
    dictationHotkey,
    flash,
    runTask,
  });

  /** Reloads the list; on failure keeps what is shown and says the list is stale. */
  const refreshRecordings = useCallback(async () => {
    try {
      setRecordings(await loadRecordings(now));
      setLoadError(null);
    } catch (error) {
      setLoadError(errMsg(error, 'Could not load recordings'));
    }
  }, [now]);

  const pasteFromClipboard = useCallback(() => {
    runTask(async () => {
      try {
        await pasteClip();
        historyRef.current?.scrollTo({ top: 0 });
        flash('Saved to capture history');
      } catch (error) {
        throw new Error(errMsg(error, 'Could not paste from the clipboard'));
      }
    });
  }, [flash, runTask]);

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
            session: { session_id: state.sessionId!, started_at_ms: state.startedAtMs ?? Date.now(), mode: state.mode ?? 'audio', source: 'mixed' },
            mode: state.mode === 'screen' ? 'screen' : 'audio',
          });
        } else {
          setRecording((current) => current?.session.session_id === state.sessionId ? null : current);
        }
      };
      const listeners = await Promise.all([
        onLauncherSettings(() => setView('settings')),
        onLauncherRecordings(() => { setView((v) => (v === 'setup' ? v : 'list')); historyRef.current?.scrollTo({ top: 0 }); }),
        onLauncherSetup(() => { setupForced.current = true; setView('setup'); }),
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
    pasteFromClipboard,
    flash,
    runTask,
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
        className={cn(
          'launcher-panel relative z-10 flex flex-col overflow-hidden border border-border',
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
            capturePhase={capturePhase}
            elapsed={elapsed}
            view={view}
            account={account}
            connecting={connecting}
            recording={!!recording}
            goSettings={goSettings}
            runTask={runTask}
            stopRecording={stopRecording}
          />
        )}
        {desktop && view === 'list' && (
          <CaptureToolbar
            recording={!!recording}
            withComputerAudio={withComputerAudio}
            starting={starting}
            dictationHotkey={dictationHotkey}
            captureBusy={captureBusy}
            setStarting={setStarting}
            runTask={runTask}
            stopRecording={stopRecording}
            beginRecording={beginRecording}
          />
        )}
        {desktop && view === 'list' && signedOut && (
          <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-[var(--lr-brand-soft)] px-4 py-2 text-xs">
            <span>Eavesy is signed out. Recordings stay on this Mac and upload once you reconnect.</span>
            <button type="button" disabled={connecting} onClick={() => runTask(connectAccount, 'Could not connect account')} className="shrink-0 rounded-md bg-[var(--lr-brand)] px-2 py-1 text-white disabled:opacity-50">Reconnect</button>
          </div>
        )}
        {desktop && !setupKnown ? (
          <div className="min-h-0 flex-1" aria-busy="true" />
        ) : view === 'setup' && !recording ? (
          <SetupView
            paired={setupPaired}
            connecting={connecting}
            permissions={setupPermissions}
            checking={checkingSetupPermissions}
            onConnect={() => runTask(connectAccount, 'Could not connect account')}
            onCancelConnect={cancelConnect}
            onRequest={(kind) => runTask(() => requestSetupPermission(kind), 'Could not check permissions')}
            onOpenSettings={openPrivacy}
            onFinish={() => runTask(finishSetup, 'Could not finish setup')}
          />
        ) : view === 'settings' ? (
          <SettingsView
            permissions={setupPermissions}
            checkingPermission={checkingSetupPermissions}
            onRequestPermission={(kind) => runTask(() => requestSetupPermission(kind), 'Could not check permissions')}
            onOpenPrivacy={openPrivacy}
            onRelaunch={() => runTask(relaunchApp, 'Could not reopen Eavesy')}
            account={account}
            connecting={connecting}
            onCancelConnect={cancelConnect}
            onDisconnect={() => runTask(async () => { await disconnectAccount(); await refreshAccount(); flash('Signed out on this Mac'); })}
            onShortcutsChanged={() => runTask(async () => {
              const saved = await getSettings();
              if (saved) {
                setToggleHotkey(prettyAccel(saved.toggle_hotkey));
                setDictationHotkey(prettyAccel(saved.dictation_hotkey));
              }
            })}
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
          <div ref={historyRef} data-capture-history className="min-h-0 flex-1 overflow-y-auto p-4 [overflow-anchor:none]">
            {loadError && (
              <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs">
                <span>Couldn’t load your recordings: {loadError}</span>
                <button type="button" onClick={() => runTask(refreshRecordings)} className="shrink-0 rounded-md px-2 py-1 hover:bg-[var(--lr-hover)]">Retry</button>
              </div>
            )}
            {(recording || starting) && (
              <InProgressCapture
                sessionId={recording?.session.session_id ?? null}
                mode={recording?.mode ?? 'audio'}
                elapsed={elapsed}
                onStop={() => runTask(stopRecording, 'Could not stop recording')}
              />
            )}
            <CaptureHistory signedIn={account !== null} onSignIn={() => runTask(connectAccount, 'Could not connect account')} recordings={recordings} onPaste={pasteFromClipboard} onCopied={(message) => flash(message)} onError={(error) => flash(errMsg(error, 'Could not copy'), 5000)} />
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
          <div className="pointer-events-none absolute bottom-14 left-1/2 z-20 -translate-x-1/2 rounded-md bg-foreground px-3 py-1.5 text-[13px] font-medium text-background shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
