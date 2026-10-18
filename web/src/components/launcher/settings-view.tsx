'use client';

import { ArrowLeft, ArrowUpRight, Check, FolderOpen, Loader2, LogOut, RotateCcw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Card, IconButton, Switch } from '@/components/launcher/ui';
import { HotkeyRecorder } from '@/components/launcher/hotkey-recorder';
import { PermissionChecklist } from '@/components/launcher/permission-checklist';
import {
  chooseRecordingsFolder,
  errMsg,
  getSettings,
  isDesktop,
  setLauncherPosition,
  setLiveCaptions,
  checkPermissions,
  checkForUpdates,
  getAppInfo,
  getScreenshotFolder,
  installUpdate,
  setAutoImportScreenshots,
  type AccountInfo,
  type LauncherPosition,
  type Permissions,
  type PrivacyPane,
  type Settings,
  type UpdateStatus,
} from '@/lib/desktop/bridge';
import { cn } from '@/lib/utils';
import type { SetupPermissionKind } from './use-setup-permissions';

export type AccountState = AccountInfo | null | undefined;

export function accountInitial(account: AccountInfo): string {
  return (account.name ?? account.email ?? '?').trim().charAt(0).toUpperCase() || '?';
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <Card title={title}><div className="ev-set-body">{children}</div></Card>;
}

function UpdatesCard() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState<'check' | 'install' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void getAppInfo().then((info) => { if (info) setStatus(info.update); }).catch(() => {});
  }, []);
  const run = (kind: 'check' | 'install') => {
    setBusy(kind);
    setError(null);
    const task = kind === 'check'
      ? checkForUpdates().then((next) => { if (next) setStatus(next); })
      : installUpdate();
    void task
      .catch((e: unknown) => setError(errMsg(e, kind === 'check' ? 'Could not check for updates.' : 'Could not install the update.')))
      .finally(() => setBusy(null));
  };
  const line = !status ? '' : status.state === 'upToDate'
    ? `You're up to date (v${status.currentVersion}).`
    : status.state === 'available'
      ? `Eavesy ${status.version} is available. You have ${status.currentVersion}.`
      : status.state === 'error'
        ? `Couldn't check for updates: ${status.message}`
        : `Eavesy ${status.currentVersion}`;
  return (
    <div className="flex items-center gap-2">
      <p role="status" className="ev-set-label min-w-0 flex-1">{error ?? line}</p>
      {status?.state === 'available' ? (
        <Button variant="primary" size="sm" disabled={busy !== null} loading={busy === 'install'} onClick={() => run('install')}>
          Install &amp; Relaunch
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled={busy !== null} loading={busy === 'check'} onClick={() => run('check')}>
          Check for Updates
        </Button>
      )}
    </div>
  );
}

function AccountCard({ account, connecting, onConnect, onCancelConnect, onDisconnect, onOpenWeb }: {
  account: AccountState;
  connecting: boolean;
  onConnect: () => void;
  onCancelConnect?: () => void;
  onDisconnect: () => void;
  onOpenWeb: () => void;
}) {
  if (account === undefined) {
    return <p className="ev-set-hint">Checking your account…</p>;
  }
  if (connecting) {
    return (
      <div className="flex items-center gap-3">
        <Loader2 className="ev-spin h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" />
        <div className="min-w-0">
          <p className="ev-set-label">Approve this Mac in your browser</p>
          <p className="ev-set-hint">Click “Approve this Mac” on the page that opened. This updates on its own.</p>
        </div>
        {onCancelConnect && (
          <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={onCancelConnect}>Cancel</Button>
        )}
      </div>
    );
  }
  if (account === null) {
    return (
      <div className="flex flex-col gap-3">
        <div>
          <p className="ev-set-label">Not signed in</p>
          <p className="ev-set-hint">
            Sign in to get transcripts and summaries, and to see your captures on the web and your other devices.
          </p>
        </div>
        <Button variant="primary" size="sm" className="self-start" onClick={onConnect}>Sign in to Eavesy</Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <span className="ev-acct" data-size="lg" aria-hidden>
        {accountInitial(account)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="ev-set-label truncate">
          {account.name ?? account.email ?? 'Eavesy account'}
        </p>
        <p className="ev-set-hint flex items-center gap-1 truncate">
          <Check className="h-3 w-3 shrink-0 text-[var(--ev-leaf)]" />
          {account.name && account.email ? `${account.email} · syncing` : 'Connected · syncing this Mac'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton label="Open Eavesy on the web" icon={ArrowUpRight} onClick={onOpenWeb} />
        <IconButton label="Sign out on this Mac" icon={LogOut} onClick={onDisconnect} />
      </div>
    </div>
  );
}

const SPOTS: { value: LauncherPosition; label: string; className: string }[] = [
  { value: 'top_left', label: 'Top left', className: 'left-2' },
  { value: 'top_center', label: 'Top center', className: 'left-1/2 -translate-x-1/2' },
  { value: 'top_right', label: 'Top right', className: 'right-2' },
];

function PositionPicker({ value, custom, disabled, onPick }: {
  value: LauncherPosition;
  custom: boolean;
  disabled: boolean;
  onPick: (position: LauncherPosition) => void;
}) {
  const current = SPOTS.find((spot) => spot.value === value);
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        role="radiogroup"
        aria-label="Control position"
        className="relative aspect-[16/10] w-full max-w-[240px] overflow-hidden rounded-[var(--ev-r-ctl)] bg-[var(--ev-well)] shadow-[0_0_0_1px_var(--ev-line)]"
      >
        <div className="h-2.5 w-full bg-[var(--ev-line)]" />
        {SPOTS.map((spot) => {
          const selected = !custom && spot.value === value;
          return (
            <button
              key={spot.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={spot.label}
              title={spot.label}
              disabled={disabled}
              onClick={() => onPick(spot.value)}
              className={cn(
                'group absolute top-4 flex h-6 w-[30%] items-center justify-center rounded-md transition-colors disabled:cursor-default',
                spot.className,
                selected ? 'bg-[var(--ev-slate-soft)]' : 'hover:bg-[var(--ev-hover)]',
              )}
            >
              <span
                className={cn(
                  'h-2.5 w-12 rounded-full transition-colors',
                  selected ? 'bg-[var(--ev-slate)]' : 'bg-[var(--ev-line-strong)] group-hover:bg-[var(--ev-ink-3)]',
                )}
              />
            </button>
          );
        })}
      </div>
      <p className="ev-set-hint">
        {custom ? 'You moved the control. Click a spot to snap it back.' : `${current?.label ?? 'Top center'}. Drag the control anywhere to fine-tune.`}
      </p>
    </div>
  );
}

export function SettingsView({ permissions, checkingPermission, onRequestPermission, onOpenPrivacy, onRelaunch, onRunSetup, fnInUse, account, connecting, onConnect, onCancelConnect, onDisconnect, onOpenWeb, onShortcutsChanged, onBack }: {
  permissions: Permissions | null;
  checkingPermission: SetupPermissionKind | null;
  onRequestPermission: (kind: SetupPermissionKind) => void;
  onOpenPrivacy: (pane: PrivacyPane) => void;
  onRelaunch: () => void;
  onRunSetup: () => void;
  fnInUse: boolean;
  account: AccountState;
  connecting: boolean;
  onConnect: () => void;
  onCancelConnect?: () => void;
  onDisconnect: () => void;
  onOpenWeb: () => void;
  onShortcutsChanged: () => void;
  onBack: () => void;
}) {
  const [settings, setSettings] = useState<(Settings & { hud_frame?: unknown }) | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [positionBusy, setPositionBusy] = useState(false);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderStatus, setFolderStatus] = useState<string | null>(null);
  const [captionsBusy, setCaptionsBusy] = useState(false);
  const [speech, setSpeech] = useState<boolean | undefined>(permissions?.speech);
  const captionsOn = settings?.live_captions ?? true;
  const [shotFolder, setShotFolder] = useState<string | null>(null);
  const [shotsBusy, setShotsBusy] = useState(false);
  const [shotsError, setShotsError] = useState<string | null>(null);
  const shotsOn = settings?.auto_import_screenshots ?? false;

  useEffect(() => { void getScreenshotFolder().then(setShotFolder); }, []);

  const toggleScreenshots = (next: boolean) => {
    setShotsBusy(true);
    setShotsError(null);
    void setAutoImportScreenshots(next)
      .then(() => setSettings((current) => current ? { ...current, auto_import_screenshots: next } : current))
      .catch((error: unknown) => setShotsError(errMsg(error, 'Could not change that setting.')))
      .finally(() => setShotsBusy(false));
  };

  const toggleCaptions = (next: boolean) => {
    setCaptionsBusy(true);
    void setLiveCaptions(next)
      .then(async () => {
        setSettings((current) => current ? { ...current, live_captions: next } : current);
        // Turning captions on is when Speech Recognition is asked for.
        if (next) setSpeech((await checkPermissions({ needScreen: false, needSpeech: true }))?.speech);
      })
      .catch(() => {})
      .finally(() => setCaptionsBusy(false));
  };

  useEffect(() => {
    void getSettings()
      .then(setSettings)
      .catch(() => setSettings(null))
      .finally(() => setLoaded(true));
  }, []);

  const pickPosition = (position: LauncherPosition) => {
    setPositionBusy(true);
    setPositionError(null);
    void setLauncherPosition(position)
      .then(() => setSettings((current) => current ? { ...current, launcher_position: position, hud_frame: null } : current))
      .catch((error: unknown) => setPositionError(errMsg(error, 'Could not change position.')))
      .finally(() => setPositionBusy(false));
  };

  const folder = settings?.recordings_root ?? '~/Eavesy/Recordings';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* On the Mac the title bar carries Back and the title. */}
      {!isDesktop() && (
        <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-3">
          <IconButton label="Back" title="Back (esc)" icon={ArrowLeft} onClick={onBack} />
          <h2 className="ev-set-label">Settings</h2>
        </div>
      )}

      <div className="ev-settings">
        <Section title="Account">
          <AccountCard account={account} connecting={connecting} onConnect={onConnect} onCancelConnect={onCancelConnect} onDisconnect={onDisconnect} onOpenWeb={onOpenWeb} />
        </Section>

        {isDesktop() && (
          <Card title="Permissions">
            <PermissionChecklist
              permissions={permissions}
              checking={checkingPermission}
              fnInUse={fnInUse}
              onRequest={onRequestPermission}
              onOpenSettings={onOpenPrivacy}
              onRelaunch={onRelaunch}
            />
            <div className="ev-set-row">
              <p className="ev-set-hint min-w-0">Walk through sign-in, permissions and shortcuts again.</p>
              <Button variant="outline" size="sm" icon={RotateCcw} className="shrink-0" onClick={onRunSetup}>Run setup again</Button>
            </div>
          </Card>
        )}

        {isDesktop() && (
          <Section title="Live captions">
            <Switch
              checked={captionsOn}
              onCheckedChange={toggleCaptions}
              disabled={!settings || captionsBusy}
              label="Show captions while recording"
              hint="Transcribed on this Mac as you speak. The cloud transcript replaces them."
            />
            {captionsOn && (speech ?? permissions?.speech) === false && (
              <p className="ev-set-hint mt-2">
                Speech Recognition is off for Eavesy, so there are no captions and dictation waits for the cloud.{' '}
                <button type="button" onClick={() => onOpenPrivacy('speech')} className="ev-link">Open System Settings</button>
              </p>
            )}
          </Section>
        )}

        <Section title="Position">
          <PositionPicker
            value={settings?.launcher_position ?? 'top_center'}
            custom={!!settings?.hud_frame}
            disabled={!settings || positionBusy || !isDesktop()}
            onPick={pickPosition}
          />
          {positionError ? <p role="alert" className="ev-set-hint mt-2 text-center text-[var(--ev-warn-ink)]">{positionError}</p> : null}
        </Section>

        <Section title="Shortcuts">
          {!loaded ? (
            <p className="ev-set-hint">Loading…</p>
          ) : (
            <div className="flex flex-col gap-2">
              <HotkeyRecorder onSaved={onShortcutsChanged} action="toggle" initial={settings?.toggle_hotkey ?? 'Cmd+Shift+Space'} label="Open Eavesy" />
              <HotkeyRecorder onSaved={onShortcutsChanged} action="dictation" initial={settings?.dictation_hotkey ?? 'Cmd+Shift+D'} label="Start dictation" />
            </div>
          )}
        </Section>

        <Section title="Recordings folder">
          <div className="flex items-center gap-2">
            <p className="ev-set-path flex-1" title={folder}>{folder}</p>
            <Button
              variant="outline"
              size="sm"
              icon={FolderOpen}
              loading={folderBusy}
              disabled={folderBusy}
              onClick={() => {
                setFolderBusy(true);
                setFolderStatus(null);
                void chooseRecordingsFolder(settings?.recordings_root)
                  .then((root) => {
                    if (!root) return;
                    setSettings((current) => current ? { ...current, recordings_root: root } : current);
                    setFolderStatus('New recordings will be saved here. Existing ones stay put.');
                  })
                  .catch((error: unknown) => setFolderStatus(errMsg(error, 'Could not change the recordings folder.')))
                  .finally(() => setFolderBusy(false));
              }}
            >
              Change
            </Button>
          </div>
          {folderStatus ? <p role="status" className="ev-set-hint mt-2">{folderStatus}</p> : null}
        </Section>

        {isDesktop() && (
          <Section title="Screenshots">
            <Switch
              checked={shotsOn}
              onCheckedChange={toggleScreenshots}
              disabled={!settings || shotsBusy}
              label="Add macOS screenshots automatically"
              hint={shotFolder
                ? `New screenshots saved to ${shotFolder} are copied into Eavesy. The originals stay where they are.`
                : 'New macOS screenshots are copied into Eavesy. The originals stay where they are.'}
            />
            {shotsError ? <p role="alert" className="ev-set-hint mt-2 text-[var(--ev-warn-ink)]">{shotsError}</p> : null}
          </Section>
        )}

        {isDesktop() && (
          <Section title="Updates">
            <UpdatesCard />
          </Section>
        )}
      </div>
    </div>
  );
}
