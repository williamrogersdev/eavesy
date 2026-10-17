'use client';

import { ArrowLeft, ArrowUpRight, Check, FolderOpen, Loader2, LogOut } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { HotkeyRecorder } from '@/components/launcher/hotkey-recorder';
import { PermissionRow } from '@/components/launcher/permission-row';
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
  installUpdate,
  type AccountInfo,
  type LauncherPosition,
  type PermissionStatus,
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
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-[11px] font-medium text-muted-foreground">{title}</h3>
      <div className="rounded-xl border border-border bg-[var(--lr-hover)] p-3">{children}</div>
    </section>
  );
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
      <p role="status" className="min-w-0 flex-1 text-[12px] text-foreground">{error ?? line}</p>
      {status?.state === 'available' ? (
        <button type="button" disabled={busy !== null} onClick={() => run('install')} className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-[12px] text-background hover:opacity-90 disabled:opacity-50">
          {busy === 'install' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Install &amp; Relaunch
        </button>
      ) : (
        <button type="button" disabled={busy !== null} onClick={() => run('check')} className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] hover:bg-[var(--lr-selected)] disabled:opacity-50">
          {busy === 'check' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Check for Updates
        </button>
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
    return <p className="text-xs text-muted-foreground">Checking your account…</p>;
  }
  if (connecting) {
    return (
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground">Approve this Mac in your browser</p>
          <p className="text-[11px] text-muted-foreground">Click “Approve this Mac” on the page that opened. This updates on its own.</p>
        </div>
        {onCancelConnect && (
          <button type="button" onClick={onCancelConnect} className="ml-auto shrink-0 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-[var(--lr-selected)]">
            Cancel
          </button>
        )}
      </div>
    );
  }
  if (account === null) {
    return (
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-[13px] font-medium text-foreground">Not signed in</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            Sign in to get transcripts and summaries, and to see your captures on the web and your other devices.
          </p>
        </div>
        <button
          type="button"
          onClick={onConnect}
          className="self-start rounded-md bg-[var(--lr-brand)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
        >
          Sign in to Eavesy
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--lr-brand)] text-sm font-semibold text-white">
        {accountInitial(account)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-foreground">
          {account.name ?? account.email ?? 'Eavesy account'}
        </p>
        <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
          <Check className="h-3 w-3 shrink-0 text-emerald-500" />
          {account.name && account.email ? `${account.email} · syncing` : 'Connected · syncing this Mac'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onOpenWeb}
          title="Open Eavesy on the web"
          aria-label="Open Eavesy on the web"
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-[var(--lr-selected)] hover:text-foreground"
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onDisconnect}
          title="Sign out on this Mac"
          aria-label="Sign out on this Mac"
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-[var(--lr-selected)] hover:text-foreground"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
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
        className="relative aspect-[16/10] w-full max-w-[240px] overflow-hidden rounded-lg border border-border bg-background/60"
      >
        <div className="h-2.5 w-full bg-foreground/10" />
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
                selected ? 'bg-[var(--lr-brand-soft)]' : 'hover:bg-foreground/5',
              )}
            >
              <span
                className={cn(
                  'h-2.5 w-12 rounded-full transition-colors',
                  selected ? 'bg-[var(--lr-brand)]' : 'bg-foreground/15 group-hover:bg-foreground/30',
                )}
              />
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {custom ? 'You moved the control. Click a spot to snap it back.' : `${current?.label ?? 'Top center'}. Drag the control anywhere to fine-tune.`}
      </p>
    </div>
  );
}

/** Whether macOS has already asked, so Allow would do nothing and only System Settings helps. */
function answered(status: PermissionStatus | undefined): boolean | undefined {
  return status === undefined ? undefined : status !== 'notDetermined';
}

export function SettingsView({ permissions, checkingPermission, onRequestPermission, onOpenPrivacy, onRelaunch, account, connecting, onConnect, onCancelConnect, onDisconnect, onOpenWeb, onShortcutsChanged, onBack }: {
  permissions: Permissions | null;
  checkingPermission: SetupPermissionKind | null;
  onRequestPermission: (kind: SetupPermissionKind) => void;
  onOpenPrivacy: (pane: PrivacyPane) => void;
  onRelaunch: () => void;
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

  const toggleCaptions = () => {
    const next = !captionsOn;
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
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-3">
        <button
          type="button"
          onClick={onBack}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-[var(--lr-hover)] hover:text-foreground"
          aria-label="Back"
          title="Back (esc)"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-sm font-semibold text-foreground">Settings</h2>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4 pt-2">
        <Section title="Account">
          <AccountCard account={account} connecting={connecting} onConnect={onConnect} onCancelConnect={onCancelConnect} onDisconnect={onDisconnect} onOpenWeb={onOpenWeb} />
        </Section>

        {isDesktop() && (
          <Section title="Permissions">
            <div className="-m-1 grid">
              <PermissionRow
                label="Microphone"
                hint="Voice notes and dictation."
                settingsHint="Turn on Eavesy under Microphone in System Settings."
                granted={permissions?.mic}
                answered={permissions?.micAsked}
                checking={checkingPermission === 'mic'}
                onRequest={() => onRequestPermission('mic')}
                onOpenSettings={() => onOpenPrivacy('microphone')}
              />
              <PermissionRow
                label="Screen Recording"
                optional
                hint="Calls, screenshots and screen video."
                settingsHint="Turn on Eavesy under Screen Recording, then reopen Eavesy."
                granted={permissions?.screen}
                checking={checkingPermission === 'screen'}
                onRequest={() => onRequestPermission('screen')}
                onOpenSettings={() => onOpenPrivacy('screen')}
                onRelaunch={onRelaunch}
              />
              <PermissionRow
                label="Speech Recognition"
                optional
                hint="Live captions and instant dictation paste."
                settingsHint="Turn on Eavesy under Speech Recognition in System Settings."
                granted={permissions?.speech}
                answered={answered(permissions?.status?.speech)}
                checking={checkingPermission === 'speech'}
                onRequest={() => onRequestPermission('speech')}
                onOpenSettings={() => onOpenPrivacy('speech')}
              />
              <PermissionRow
                label="Accessibility"
                optional
                hint="Paste what you dictate right where your cursor is."
                settingsHint="Turn on Eavesy under Accessibility in System Settings."
                granted={permissions?.accessibility}
                checking={checkingPermission === 'accessibility'}
                onRequest={() => onRequestPermission('accessibility')}
                onOpenSettings={() => onOpenPrivacy('accessibility')}
              />
              <PermissionRow
                label="Input Monitoring"
                optional
                hint="Use the Fn / Globe key as a shortcut."
                settingsHint="Turn on Eavesy under Input Monitoring, then reopen Eavesy."
                granted={permissions?.inputMonitoring}
                answered={answered(permissions?.status?.inputMonitoring)}
                checking={checkingPermission === 'inputMonitoring'}
                onRequest={() => onRequestPermission('inputMonitoring')}
                onOpenSettings={() => onOpenPrivacy('input_monitoring')}
                onRelaunch={onRelaunch}
                relaunchTitle="macOS applies Input Monitoring after Eavesy restarts"
              />
              <PermissionRow
                label="Notifications"
                optional
                hint="Sign-in, upload and update alerts."
                settingsHint="Turn on notifications for Eavesy in System Settings → Notifications."
                granted={permissions?.notifications}
                answered={answered(permissions?.status?.notifications)}
                checking={checkingPermission === 'notifications'}
                onRequest={() => onRequestPermission('notifications')}
                onOpenSettings={() => onOpenPrivacy('notifications')}
              />
            </div>
          </Section>
        )}

        {isDesktop() && (
          <Section title="Live captions">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-foreground">Show captions while recording</p>
                <p className="text-[11px] text-muted-foreground">Transcribed on this Mac as you speak. The cloud transcript replaces them.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={captionsOn}
                aria-label="Live captions"
                disabled={!settings || captionsBusy}
                onClick={toggleCaptions}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${captionsOn ? 'bg-[var(--lr-brand)]' : 'bg-[var(--lr-selected)]'}`}
              >
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${captionsOn ? 'left-[18px]' : 'left-0.5'}`} />
              </button>
            </div>
            {captionsOn && (speech ?? permissions?.speech) === false && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Speech Recognition is off for Eavesy, so there are no captions and dictation waits for the cloud.{' '}
                <button type="button" onClick={() => onOpenPrivacy('speech')} className="underline">Open System Settings</button>
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
          {positionError ? <p role="alert" className="mt-2 text-center text-xs text-destructive">{positionError}</p> : null}
        </Section>

        <Section title="Shortcuts">
          {!loaded ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex flex-col gap-2">
              <HotkeyRecorder onSaved={onShortcutsChanged} action="toggle" initial={settings?.toggle_hotkey ?? 'Cmd+Shift+Space'} label="Open Eavesy" />
              <HotkeyRecorder onSaved={onShortcutsChanged} action="dictation" initial={settings?.dictation_hotkey ?? 'Cmd+Shift+D'} label="Start dictation" />
            </div>
          )}
        </Section>

        <Section title="Recordings folder">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[12px] text-foreground" title={folder}>{folder}</p>
            <button
              type="button"
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
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] hover:bg-[var(--lr-selected)] disabled:opacity-50"
            >
              {folderBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
              Change
            </button>
          </div>
          {folderStatus ? <p role="status" className="mt-2 text-[11px] text-muted-foreground">{folderStatus}</p> : null}
        </Section>

        {isDesktop() && (
          <Section title="Updates">
            <UpdatesCard />
          </Section>
        )}
      </div>
    </div>
  );
}
