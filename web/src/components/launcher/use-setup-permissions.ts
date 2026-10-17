import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
  type RefObject,
  type MutableRefObject,
} from 'react';
import {
  completeSetup,
  errMsg,
  openPrivacySettings,
  checkPermissions,
  requestAccessibility,
  requestInputMonitoring,
  requestMicrophone,
  requestNotifications,
  requestScreen,
  requestSpeech,
  type Permissions,
  type PrivacyPane,
} from '@/lib/desktop/bridge';
import { type Flash, type LauncherView, type RunTask } from './types';

export type SetupPermissionKind = 'mic' | 'screen' | 'speech' | 'accessibility' | 'inputMonitoring' | 'notifications';

export function useSetupPermissions({
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
}: {
  desktop: boolean;
  view: LauncherView;
  setView: Dispatch<SetStateAction<LauncherView>>;
  setupForced: MutableRefObject<boolean>;
  searchRef: RefObject<HTMLInputElement | null>;
  recording: object | null;
  setupPaired: boolean;
  dictationHotkey: string;
  flash: Flash;
  runTask: RunTask;
}) {
  const [setupPermissions, setSetupPermissions] = useState<Permissions | null>(null);
  const [checkingSetupPermissions, setCheckingSetupPermissions] = useState<SetupPermissionKind | null>(null);

  const refreshPermissionsQuietly = useCallback(async () => {
    const permissions = await checkPermissions({ prompt: false, needScreen: false });
    if (permissions) setSetupPermissions(permissions);
  }, []);

  // One macOS prompt at a time: each request asks for a single permission.
  const requestSetupPermission = useCallback(async (kind: SetupPermissionKind) => {
    setCheckingSetupPermissions(kind);
    try {
      if (kind === 'mic') {
        let permissions = await requestMicrophone();
        // First launch is when Speech Recognition is asked for (right after the mic),
        // so live captions never prompt in the middle of a meeting.
        if (permissions?.status?.speech === 'notDetermined') permissions = await requestSpeech();
        setSetupPermissions(permissions);
      } else if (kind === 'screen') {
        setSetupPermissions(await requestScreen());
      } else if (kind === 'speech') {
        setSetupPermissions(await requestSpeech());
      } else {
        if (kind === 'accessibility') await requestAccessibility();
        else if (kind === 'inputMonitoring') await requestInputMonitoring();
        else await requestNotifications();
        await refreshPermissionsQuietly();
      }
    } catch (error) {
      flash(errMsg(error, 'Could not check permissions'), 8000);
    } finally {
      setCheckingSetupPermissions(null);
    }
  }, [flash, refreshPermissionsQuietly]);

  const openPrivacy = useCallback((pane: PrivacyPane) => {
    runTask(() => openPrivacySettings(pane), 'Could not open System Settings');
  }, [runTask]);

  const permissionsView = desktop && (view === 'setup' || view === 'settings');
  const coreAllowed = !!setupPermissions?.mic && !!setupPermissions?.screen && !!setupPermissions?.accessibility;
  const allAllowed = coreAllowed && !!setupPermissions?.speech && !!setupPermissions?.inputMonitoring
    && !!setupPermissions?.notifications;
  useEffect(() => {
    if (!permissionsView || allAllowed) return;
    let busy = false;
    const refresh = () => {
      if (busy) return;
      busy = true;
      void refreshPermissionsQuietly().catch(() => {}).finally(() => { busy = false; });
    };
    refresh();
    const id = window.setInterval(refresh, 2000);
    return () => window.clearInterval(id);
  }, [permissionsView, allAllowed, refreshPermissionsQuietly]);

  const finishSetup = useCallback(async () => {
    try {
      await completeSetup();
      setupForced.current = false;
      setView('list');
      searchRef.current?.focus();
    } catch (error) {
      flash(errMsg(error, 'Could not finish setup'));
    }
  }, [flash, searchRef, setView, setupForced]);

  // Finish on its own only once nothing is left to allow; otherwise the remaining permissions
  // stay on screen until the user chooses to finish.
  useEffect(() => {
    if (view !== 'setup' || recording || !setupPaired || !coreAllowed) return;
    const id = window.setTimeout(() => {
      runTask(async () => {
        await finishSetup();
        if (dictationHotkey) flash(`You're set. Press ${dictationHotkey} anywhere to record.`, 5000);
      }, 'Could not finish setup');
    }, 700);
    return () => window.clearTimeout(id);
  }, [view, recording, setupPaired, coreAllowed, finishSetup, runTask, flash, dictationHotkey]);

  return {
    setupPermissions,
    setSetupPermissions,
    checkingSetupPermissions,
    requestSetupPermission,
    openPrivacy,
    finishSetup,
  };
}
