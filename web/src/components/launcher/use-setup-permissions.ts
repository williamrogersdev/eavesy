import { useCallback, useEffect, useState } from 'react';
import {
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
import { needsPermissionPoll, samePermissions } from './permission-checklist';
import { type Flash, type RunTask } from './types';

export type SetupPermissionKind = 'mic' | 'screen' | 'speech' | 'accessibility' | 'inputMonitoring' | 'notifications';

/**
 * What Eavesy may use on this Mac, re-checked whenever the window comes back to
 * the front. `poll` says a permissions list is on screen: it then re-checks every
 * 2s as well, but only while one of its rows that matters (`fnInUse` decides
 * Input Monitoring) is still off.
 */
export function useSetupPermissions({
  desktop,
  poll,
  fnInUse,
  flash,
  runTask,
}: {
  desktop: boolean;
  poll: boolean;
  fnInUse: boolean;
  flash: Flash;
  runTask: RunTask;
}) {
  const [setupPermissions, setPermissionsState] = useState<Permissions | null>(null);
  const [checkingSetupPermissions, setCheckingSetupPermissions] = useState<SetupPermissionKind | null>(null);

  // Polls mostly return the same answers: keep the old object so nothing re-renders.
  const setSetupPermissions = useCallback((next: Permissions | null) => {
    setPermissionsState((current) => (samePermissions(current, next) ? current : next));
  }, []);

  const refreshPermissionsQuietly = useCallback(async () => {
    const permissions = await checkPermissions({ prompt: false, needScreen: false });
    if (permissions) setSetupPermissions(permissions);
  }, [setSetupPermissions]);

  // One macOS prompt at a time: each request asks for a single permission. Resolves with
  // whether the request ran; a failure is shown here and resolves false.
  const requestSetupPermission = useCallback(async (kind: SetupPermissionKind): Promise<boolean> => {
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
      return true;
    } catch (error) {
      flash(errMsg(error, 'Couldn’t check permissions'), 8000);
      return false;
    } finally {
      setCheckingSetupPermissions(null);
    }
  }, [flash, refreshPermissionsQuietly, setSetupPermissions]);

  const openPrivacy = useCallback((pane: PrivacyPane) => {
    runTask(() => openPrivacySettings(pane), 'Couldn’t open System Settings');
  }, [runTask]);

  const polling = poll && needsPermissionPoll(setupPermissions, fnInUse);
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
    const id = polling ? window.setInterval(refresh, 2000) : undefined;
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      if (id !== undefined) window.clearInterval(id);
    };
  }, [desktop, polling, refreshPermissionsQuietly]);

  return {
    setupPermissions,
    setSetupPermissions,
    checkingSetupPermissions,
    requestSetupPermission,
    openPrivacy,
  };
}
