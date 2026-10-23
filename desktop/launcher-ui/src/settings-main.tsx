import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsView, type AccountState } from '@/components/launcher/settings-view';
import { usesFnKey } from '@/components/launcher/permission-checklist';
import { useSetupPermissions } from '@/components/launcher/use-setup-permissions';
import { useToastTasks } from '@/components/launcher/use-toast-tasks';
import {
  cancelPairing, closeSettingsWindow, disconnectAccount, getAccountInfo, getSettings,
  onSettingsSection, openSetup, openWebApp, pairDevice, relaunchApp, takeSettingsSection,
  type SettingsSection,
} from '@/lib/desktop/bridge';
import './styles.css';

if (import.meta.env.DEV) {
  const { installDevMock } = await import('./dev-mock');
  installDevMock();
}

/** Escape closes the window unless something on it wants the key (a field, a menu, a dialog). */
function wantsEscape(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return !!document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]');
}

function Preferences() {
  const [account, setAccount] = useState<AccountState>(undefined);
  const [connecting, setConnecting] = useState(false);
  const connectingRef = useRef(false);
  const [fnInUse, setFnInUse] = useState(false);
  // The panel can ask for a section (Manage projects… opens Projects).
  const [section, setSection] = useState<SettingsSection>(() => takeSettingsSection() ?? 'capture');
  const { toast, flash, runTask } = useToastTasks();
  const { setupPermissions, checkingSetupPermissions, requestSetupPermission, openPrivacy } = useSetupPermissions({
    desktop: true, poll: section === 'permissions', fnInUse, flash, runTask,
  });
  const refreshShortcuts = useCallback(async () => {
    const settings = await getSettings();
    if (settings) setFnInUse(usesFnKey(settings.dictation_hotkey, settings.toggle_hotkey));
  }, []);
  useEffect(() => {
    const refresh = () => {
      void getAccountInfo().then(setAccount);
      void refreshShortcuts();
      const asked = takeSettingsSection();
      if (asked) setSection(asked);
    };
    refresh();
    window.addEventListener('focus', refresh);
    const stop = onSettingsSection(setSection);
    return () => { window.removeEventListener('focus', refresh); stop(); };
  }, [refreshShortcuts]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !wantsEscape(event.target)) {
        runTask(closeSettingsWindow, 'Couldn’t close settings');
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [runTask]);
  return <main className="launcher-scope ev-panel ev-preferences-window">
    <SettingsView
      standalone
      section={section}
      onSection={setSection}
      permissions={setupPermissions}
      checkingPermission={checkingSetupPermissions}
      onRequestPermission={requestSetupPermission}
      onOpenPrivacy={openPrivacy}
      onRelaunch={() => runTask(relaunchApp, 'Couldn’t reopen Eavesy')}
      onRunSetup={() => runTask(async () => { await openSetup(); await closeSettingsWindow(); }, 'Couldn’t open setup')}
      fnInUse={fnInUse}
      account={account}
      connecting={connecting}
      onConnect={() => {
        if (connectingRef.current) return;
        connectingRef.current = true;
        setConnecting(true);
        runTask(async () => {
          try { await pairDevice(); setAccount(await getAccountInfo()); }
          finally { connectingRef.current = false; setConnecting(false); }
        }, 'Couldn’t connect your account');
      }}
      onCancelConnect={() => runTask(cancelPairing, 'Couldn’t cancel sign-in')}
      onDisconnect={() => runTask(async () => { await disconnectAccount(); setAccount(await getAccountInfo()); }, 'Couldn’t sign out')}
      onOpenWeb={() => runTask(openWebApp, 'Couldn’t open your account')}
      onShortcutsChanged={() => { void refreshShortcuts(); }}
      onBack={() => runTask(closeSettingsWindow, 'Couldn’t close settings')}
    />
    {toast && <div className="ev-preferences-notice" role="status">{toast.message}</div>}
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Settings root not found');
createRoot(root).render(<StrictMode><Preferences /></StrictMode>);
