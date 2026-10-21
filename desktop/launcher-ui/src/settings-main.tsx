import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsView, type AccountState } from '@/components/launcher/settings-view';
import { usesFnKey } from '@/components/launcher/permission-checklist';
import { useSetupPermissions } from '@/components/launcher/use-setup-permissions';
import { useToastTasks } from '@/components/launcher/use-toast-tasks';
import type { LauncherView } from '@/components/launcher/types';
import {
  cancelPairing, closeSettingsWindow, disconnectAccount, getAccountInfo, getSettings,
  openSetup, openWebApp, pairDevice, relaunchApp,
} from '@/lib/desktop/bridge';
import './styles.css';

if (import.meta.env.DEV) {
  const { installDevMock } = await import('./dev-mock');
  installDevMock();
}

function Preferences() {
  const [account, setAccount] = useState<AccountState>(undefined);
  const [connecting, setConnecting] = useState(false);
  const [fnInUse, setFnInUse] = useState(false);
  const [view, setView] = useState<LauncherView>('settings');
  const forced = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  const { toast, flash, runTask } = useToastTasks();
  const { setupPermissions, checkingSetupPermissions, requestSetupPermission, openPrivacy } = useSetupPermissions({
    desktop: true, view, setView, setupForced: forced, searchRef: search, flash, runTask,
  });
  const refreshShortcuts = useCallback(async () => {
    const settings = await getSettings();
    if (settings) setFnInUse(usesFnKey(settings.dictation_hotkey, settings.toggle_hotkey));
  }, []);
  useEffect(() => {
    const refresh = () => {
      void getAccountInfo().then(setAccount);
      void refreshShortcuts();
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refreshShortcuts]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && event.target === document.body) {
        runTask(closeSettingsWindow, 'Could not close settings');
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [runTask]);
  return <main className="launcher-scope ev-panel ev-preferences-window">
    <SettingsView
      standalone
      permissions={setupPermissions}
      checkingPermission={checkingSetupPermissions}
      onRequestPermission={requestSetupPermission}
      onOpenPrivacy={openPrivacy}
      onRelaunch={() => runTask(relaunchApp, 'Could not reopen Eavesy')}
      onRunSetup={() => runTask(async () => { await openSetup(); await closeSettingsWindow(); }, 'Could not open setup')}
      fnInUse={fnInUse}
      account={account}
      connecting={connecting}
      onConnect={() => {
        if (connecting) return;
        setConnecting(true);
        runTask(async () => {
          try { await pairDevice(); setAccount(await getAccountInfo()); }
          finally { setConnecting(false); }
        }, 'Could not connect your account');
      }}
      onCancelConnect={() => runTask(cancelPairing, 'Could not cancel sign-in')}
      onDisconnect={() => runTask(async () => { await disconnectAccount(); setAccount(await getAccountInfo()); }, 'Could not sign out')}
      onOpenWeb={() => runTask(openWebApp, 'Could not open your account')}
      onShortcutsChanged={() => { void refreshShortcuts(); }}
      onBack={() => runTask(closeSettingsWindow, 'Could not close settings')}
    />
    {toast && <div className="ev-preferences-notice" role="status">{toast.message}</div>}
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Settings root not found');
createRoot(root).render(<StrictMode><Preferences /></StrictMode>);
