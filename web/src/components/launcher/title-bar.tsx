'use client';

import { useState } from 'react';
import { ArrowDownCircle, ArrowLeft, FolderOpen, Globe, LogOut, Settings, X } from 'lucide-react';
import { hidePanel, installUpdate, openRecordingsFolder, openWebApp } from '@/lib/desktop/bridge';
import { accountInitial, type AccountState } from '@/components/launcher/settings-view';
import { Button, IconButton, Mascot, Menu, type MenuItem } from './ui';
import { type LauncherView, type RunTask } from './types';
import { useUpdateStatus } from './use-update-status';

/** Quiet "Update" pill, shown only once a newer version is ready to install. */
function UpdateButton({ runTask }: { runTask: RunTask }) {
  const status = useUpdateStatus();
  const [installing, setInstalling] = useState(false);
  if (status?.state !== 'available') return null;
  const install = () => {
    setInstalling(true);
    runTask(
      () => installUpdate().finally(() => setInstalling(false)),
      'Couldn’t install the update',
    );
  };
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={ArrowDownCircle}
      loading={installing}
      onClick={install}
      title={`Eavesy ${status.version} is ready (you have ${status.currentVersion}). Install and relaunch.`}
    >
      {installing ? 'Updating…' : 'Update'}
    </Button>
  );
}

/**
 * 44px drag region: close, mascot + wordmark, then the account chip (or
 * "Sign in") and Settings. Recording state lives in the HUD, not here.
 */
export function TitleBar({
  view,
  account,
  connecting,
  signedOut,
  goSettings,
  goBack,
  connect,
  disconnect,
  runTask,
}: {
  view: LauncherView;
  account: AccountState;
  connecting: boolean;
  /** The sync loop's token was rejected: recordings wait on this Mac. */
  signedOut: boolean;
  goSettings: () => void;
  goBack: () => void;
  connect: () => void;
  disconnect: () => void;
  runTask: RunTask;
}) {
  const folderItem: MenuItem = {
    label: 'Open ~/Eavesy folder',
    icon: FolderOpen,
    onSelect: () => runTask(openRecordingsFolder, 'Couldn’t open your Eavesy folder'),
  };
  const settingsItem: MenuItem = { label: 'Settings', icon: Settings, kbd: '⌘,', onSelect: goSettings };

  return (
    <div data-tauri-drag-region className="ev-tb">
      <button
        type="button"
        title="Close (esc)"
        aria-label="Close"
        onClick={() => runTask(hidePanel, 'Couldn’t close the panel')}
        className="ev-tb-close"
      >
        <X size={11} strokeWidth={2.5} aria-hidden />
      </button>
      {view === 'settings' ? (
        <>
          <IconButton size={24} label="Back" icon={ArrowLeft} onClick={goBack} />
          <span data-tauri-drag-region className="ev-tb-back">Settings</span>
        </>
      ) : (
        <>
          <Mascot size={22} state="idle" />
          <span data-tauri-drag-region className="ev-tb-word">Eavesy</span>
        </>
      )}
      <span data-tauri-drag-region className="ev-tb-spacer" />
      {view !== 'setup' && <UpdateButton runTask={runTask} />}
      {view !== 'settings' && view !== 'setup' && account === null && (
        <Button size="sm" variant="ghost" loading={connecting} onClick={connect}>
          {connecting ? 'Waiting…' : 'Sign in'}
        </Button>
      )}
      {account && (
        <Menu
          align="end"
          trigger={
            <button type="button" className="ev-acct" aria-label="Account" title={account.email ?? account.name ?? 'Account'}>
              {accountInitial(account)}
            </button>
          }
          header={
            <>
              <div className="ev-menu-header-title">{account.name ?? account.email ?? 'Eavesy account'}</div>
              {account.name && account.email && <div className="ev-menu-header-sub">{account.email}</div>}
              <div className="ev-menu-header-sub" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <span
                  aria-hidden
                  style={{ width: 6, height: 6, borderRadius: 99, background: signedOut ? 'var(--ev-warn-ink)' : 'var(--ev-leaf)' }}
                />
                {signedOut ? 'Sync paused: sign in again' : 'Syncing to eavesy.com'}
              </div>
            </>
          }
          items={[
            { label: 'Open eavesy.com', icon: Globe, onSelect: () => runTask(openWebApp, 'Couldn’t open the web app') },
            folderItem,
            settingsItem,
            'separator',
            { label: 'Sign out', icon: LogOut, tone: 'warn', onSelect: disconnect },
          ]}
        />
      )}
      {view !== 'settings' && (
        account === null ? (
          <Menu
            align="end"
            trigger={<IconButton label="Settings" icon={Settings} title="Settings (⌘,)" />}
            items={[folderItem, settingsItem]}
          />
        ) : (
          <IconButton label="Settings" icon={Settings} title="Settings (⌘,)" onClick={goSettings} />
        )
      )}
    </div>
  );
}
