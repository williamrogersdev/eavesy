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
  type Permissions,
  type PrivacyPane,
} from '@/lib/desktop/bridge';
import { type Flash, type LauncherView, type RunTask } from './types';

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
  const [checkingSetupPermissions, setCheckingSetupPermissions] = useState<'mic' | 'screen' | null>(null);

  const refreshPermissionsQuietly = useCallback(async () => {
    const permissions = await checkPermissions({ prompt: false, needScreen: false });
    if (permissions) setSetupPermissions(permissions);
  }, []);

  const requestSetupPermission = useCallback(async (kind: 'mic' | 'screen') => {
    setCheckingSetupPermissions(kind);
    try {
      // First launch is when Speech Recognition is asked for (with the mic),
      // so live captions never prompt in the middle of a meeting.
      setSetupPermissions(await checkPermissions({ needScreen: kind === 'screen', needSpeech: kind === 'mic' }));
    } catch (error) {
      flash(errMsg(error, 'Could not check permissions'), 8000);
    } finally {
      setCheckingSetupPermissions(null);
    }
  }, [flash]);

  const openPrivacy = useCallback((pane: PrivacyPane) => {
    runTask(() => openPrivacySettings(pane), 'Could not open System Settings');
  }, [runTask]);

  const permissionsView = desktop && (view === 'setup' || view === 'settings');
  const allAllowed = !!setupPermissions?.mic && !!setupPermissions?.screen && !!setupPermissions?.accessibility;
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

  useEffect(() => {
    if (view !== 'setup' || recording || !setupPaired || !setupPermissions?.mic) return;
    const id = window.setTimeout(() => {
      runTask(async () => {
        await finishSetup();
        if (dictationHotkey) flash(`You're set. Press ${dictationHotkey} anywhere to record.`, 5000);
      }, 'Could not finish setup');
    }, 700);
    return () => window.clearTimeout(id);
  }, [view, recording, setupPaired, setupPermissions?.mic, finishSetup, runTask, flash, dictationHotkey]);

  return {
    setupPermissions,
    setSetupPermissions,
    checkingSetupPermissions,
    requestSetupPermission,
    openPrivacy,
    finishSetup,
  };
}
