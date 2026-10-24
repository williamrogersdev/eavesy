'use client';

import { useState } from 'react';
import { ArrowDownCircle, FolderOpen, Globe, LogOut, Settings, X } from 'lucide-react';
import { hidePanel, installUpdate, openRecordingsFolder, openWebApp } from '@/lib/desktop/bridge';
import { type AccountState } from '@/components/launcher/settings-view';
import { Button, IconButton, Mascot, Menu, type MenuItem } from './ui';
import { type RunTask } from './types';
import { useUpdateStatus } from './use-update-status';
import { ProjectChip } from './project-chip';
import type { ProjectChoice } from './use-project';

/** Quiet "Update" pill, shown only once a newer version is ready to install. */
function UpdateButton({ runTask }: { runTask: RunTask }) {
  const status = useUpdateStatus();
  const [installing, setInstalling] = useState(false);
  if (status?.state !== 'available') return null;
  const install = () => {
    if (installing) return;
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
      disabled={installing}
      onClick={install}
      title={`Eavesy ${status.version} is ready (you have ${status.currentVersion}). Install and relaunch.`}
    >
      {installing ? 'Updating…' : 'Update'}
    </Button>
  );
}

/** What the panel's one mascot shows: idle, or the live capture's state (hat up while the mic is live). */
export type TitleMascot = 'idle' | 'listening' | 'thinking';

/**
 * 44px drag region: close, mascot + wordmark, then "Sign in" when signed
 * out, and one Settings menu that also holds the account. The mascot is the panel's only one, so it carries
 * the live capture's state; the live card below has the words and Stop.
 */
export function TitleBar({
  setup,
  account,
  connecting,
  signedOut,
  goSettings,
  connect,
  disconnect,
  runTask,
  project,
  onManageProjects,
  mascot = 'idle',
}: {
  /** First-run setup is showing: no update pill, sign-in button or project chip. */
  setup: boolean;
  account: AccountState;
  connecting: boolean;
  /** The sync loop's token was rejected: recordings wait on this Mac. */
  signedOut: boolean;
  goSettings: () => void;
  connect: () => void;
  disconnect: () => void;
  runTask: RunTask;
  /** Shown on the main list once signed in. */
  project?: ProjectChoice;
  /** Opens Settings on Projects. */
  onManageProjects?: () => void;
  mascot?: TitleMascot;
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
      <Mascot size={22} state={mascot} recording={mascot === 'listening'} />
      <span data-tauri-drag-region className="ev-tb-word">Eavesy</span>
      <span data-tauri-drag-region className="ev-tb-spacer" />
      {!setup && <UpdateButton runTask={runTask} />}
      {!setup && account === null && (
        <Button size="sm" variant="ghost" loading={connecting} onClick={connect}>
          {connecting ? 'Waiting for you in the browser…' : 'Sign in'}
        </Button>
      )}
      {account && project && !setup && <ProjectChip choice={project} runTask={runTask} onManage={onManageProjects ?? goSettings} />}
      <Menu
        align="end"
        trigger={<IconButton label="Settings and account" icon={Settings} title="Settings (⌘,)" />}
        header={account ? (
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
        ) : undefined}
        items={account ? [
          settingsItem,
          { label: 'Open eavesy.com', icon: Globe, onSelect: () => runTask(openWebApp, 'Couldn’t open the web app') },
          folderItem,
          'separator',
          { label: 'Sign out', icon: LogOut, tone: 'warn', onSelect: disconnect },
        ] : [settingsItem, folderItem]}
      />
    </div>
  );
}
