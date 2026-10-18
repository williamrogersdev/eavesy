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
  flash,
  runTask,
}: {
  desktop: boolean;
  view: LauncherView;
  setView: Dispatch<SetStateAction<LauncherView>>;
  setupForced: MutableRefObject<boolean>;
  searchRef: RefObject<HTMLInputElement | null>;
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
        setSetupPermissions(await requestMicrophone());
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

  // Setup and Settings show every row live: poll while something is still off. Everywhere else
  // (the list's banner) a re-check whenever the panel comes back to the front is enough.
  const permissionsView = desktop && (view === 'setup' || view === 'settings');
  const allAllowed = !!setupPermissions?.mic && !!setupPermissions?.screen && !!setupPermissions?.accessibility
    && !!setupPermissions?.speech && !!setupPermissions?.inputMonitoring && !!setupPermissions?.notifications;
  useEffect(() => {
    if (!desktop) return;
    let busy = false;
    const refresh = () => {
      if (busy) return;
      busy = true;
      void refreshPermissionsQuietly().catch(() => {}).finally(() => { busy = false; });
    };
    refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    const id = permissionsView && !allAllowed ? window.setInterval(refresh, 2000) : undefined;
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      if (id !== undefined) window.clearInterval(id);
    };
  }, [desktop, view, permissionsView, allAllowed, refreshPermissionsQuietly]);

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

  return {
    setupPermissions,
    setSetupPermissions,
    checkingSetupPermissions,
    requestSetupPermission,
    openPrivacy,
    finishSetup,
  };
}
