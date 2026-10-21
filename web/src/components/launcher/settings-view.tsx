'use client';

import { ArrowLeft, ArrowUpRight, AudioLines, Check, CircleUser, FolderOpen, Loader2, LogOut, RotateCcw, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Card, IconButton, Row, Select, Switch } from '@/components/launcher/ui';
import { RestoreDefaultShortcuts, ShortcutRow, talkHint, useShortcuts } from '@/components/launcher/shortcut-row';
import { isGranted, PermissionChecklist, permissionSpecs } from '@/components/launcher/permission-checklist';
import {
  chooseRecordingsFolder,
  errMsg,
  getSettings,
  isDesktop,
  setLauncherPosition,
  setLiveCaptions,
  setCaptureSounds,
  setHudLook,
  checkPermissions,
  checkForUpdates,
  getAppInfo,
  getScreenshotFolder,
  installUpdate,
  setAutoImportScreenshots,
  type AccountInfo,
  type HudPreviewLines,
  type LauncherPosition,
  type Permissions,
  type PrivacyPane,
  type Settings,
  type UpdateStatus,
} from '@/lib/desktop/bridge';
import type { SetupPermissionKind } from './use-setup-permissions';
import { DictionarySettings } from '@/components/dictionary/dictionary-settings';
import { DictationCard, ProjectsSettings, TranscriptionCard, useAccountPrefs } from './account-settings';

export type AccountState = AccountInfo | null | undefined;

const PREVIEW_OPTIONS: { value: string; label: string }[] = [
  { value: '0', label: 'Off' },
  { value: '1', label: '1 line' },
  { value: '2', label: '2 lines' },
  { value: '4', label: '4 lines' },
];

export function accountInitial(account: AccountInfo): string {
  return (account.name ?? account.email ?? '?').trim().charAt(0).toUpperCase() || '?';
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <Card title={title}><div className="ev-set-body">{children}</div></Card>;
}

function UpdatesRow() {
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
      : status.state === 'installed'
        ? `Eavesy ${status.version} is installed. It takes effect the next time Eavesy starts.`
      : status.state === 'error'
        ? `Couldn't check for updates: ${status.message}`
        : `Eavesy ${status.currentVersion}`;
  return (
    <Row label="Updates" hint={<span role="status">{error ?? line}</span>}>
      {status?.state === 'available' ? (
        <Button variant="primary" size="sm" disabled={busy !== null} loading={busy === 'install'} onClick={() => run('install')}>
          Install &amp; Relaunch
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled={busy !== null} loading={busy === 'check'} onClick={() => run('check')}>
          Check Now
        </Button>
      )}
    </Row>
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

const SPOTS: { value: LauncherPosition; label: string }[] = [
  { value: 'top_left', label: 'Top left' },
  { value: 'top_center', label: 'Top center' },
  { value: 'top_right', label: 'Top right' },
  { value: 'bottom_center', label: 'Bottom center' },
];

type SettingsTab = 'general' | 'dictation' | 'projects' | 'account';
const TAB_KEY = 'ev-settings-tab';
const TABS: { value: SettingsTab; label: string; icon: typeof SlidersHorizontal }[] = [
  { value: 'general', label: 'General', icon: SlidersHorizontal },
  { value: 'dictation', label: 'Dictation', icon: AudioLines },
  { value: 'projects', label: 'Projects', icon: FolderOpen },
  { value: 'account', label: 'Account', icon: CircleUser },
];

function readTab(): SettingsTab {
  try {
    const saved = sessionStorage.getItem(TAB_KEY);
    return TABS.some((tab) => tab.value === saved) ? saved as SettingsTab : 'general';
  } catch {
    return 'general';
  }
}


export function SettingsView({ permissions, checkingPermission, onRequestPermission, onOpenPrivacy, onRelaunch, onRunSetup, fnInUse, account, connecting, onConnect, onCancelConnect, onDisconnect, onOpenWeb, onShortcutsChanged, onProjectsChanged, onBack }: {
  permissions: Permissions | null;
  checkingPermission: SetupPermissionKind | null;
  onRequestPermission: (kind: SetupPermissionKind) => Promise<boolean>;
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
  onProjectsChanged?: () => void;
  onBack: () => void;
}) {
  const [settings, setSettings] = useState<(Settings & { hud_frame?: unknown }) | null>(null);
  const [tab, setTab] = useState<SettingsTab>(() => readTab());
  useEffect(() => { try { sessionStorage.setItem(TAB_KEY, tab); } catch { /* storage is optional */ } }, [tab]);
  const signedIn = isDesktop() && !!account;
  const accountPrefs = useAccountPrefs();
  const [showPermissions, setShowPermissions] = useState(false);
  const allGranted = !!permissions && permissionSpecs(fnInUse).filter((spec) => spec.need !== 'not-needed').every((spec) => isGranted(permissions, spec.kind) === true);
  useEffect(() => { if (!allGranted) setShowPermissions(false); }, [allGranted]);
  const shortcuts = useShortcuts(onShortcutsChanged);
  const [positionBusy, setPositionBusy] = useState(false);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderStatus, setFolderStatus] = useState<string | null>(null);
  const [captionsBusy, setCaptionsBusy] = useState(false);
  const [speech, setSpeech] = useState<boolean | undefined>(permissions?.speech);
  const captionsOn = settings?.live_captions ?? true;
  const soundsOn = settings?.capture_sounds ?? true;
  const [soundsBusy, setSoundsBusy] = useState(false);
  const toggleSounds = (next: boolean) => {
    setSoundsBusy(true);
    void setCaptureSounds(next)
      .then(() => setSettings((current) => current ? { ...current, capture_sounds: next } : current))
      .catch(() => {})
      .finally(() => setSoundsBusy(false));
  };
  const savedLines = settings?.hud_preview_lines;
  const previewLines: HudPreviewLines = savedLines === 0 || savedLines === 1 || savedLines === 2 ? savedLines : 4;
  const translucent = settings?.hud_translucent ?? true;
  const [lookError, setLookError] = useState<string | null>(null);
  const changeLook = (lines: HudPreviewLines, see: boolean) => {
    setLookError(null);
    setSettings((current) => current ? { ...current, hud_preview_lines: lines, hud_translucent: see } : current);
    void setHudLook(lines, see).catch((error: unknown) => {
      setLookError(errMsg(error, 'Could not change how the recording looks.'));
      // Show what is actually saved, whichever change failed.
      void getSettings().then((saved) => setSettings((current) => current && saved
        ? { ...current, hud_preview_lines: saved.hud_preview_lines, hud_translucent: saved.hud_translucent }
        : current)).catch(() => {});
    });
  };
  const [shotFolder, setShotFolder] = useState<string | null>(null);
  const [shotsBusy, setShotsBusy] = useState(false);
  const [shotsError, setShotsError] = useState<string | null>(null);
  const shotsOn = settings?.add_screenshots ?? true;

  useEffect(() => { void getScreenshotFolder().then(setShotFolder); }, []);

  const toggleScreenshots = (next: boolean) => {
    setShotsBusy(true);
    setShotsError(null);
    void setAutoImportScreenshots(next)
      .then(() => setSettings((current) => current ? { ...current, add_screenshots: next } : current))
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
      .catch(() => setSettings(null));
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

      <div role="tablist" aria-label="Settings section" className="ev-set-tabs">
        {TABS.map(({ value, label, icon: Icon }) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} className="ev-set-tab" onClick={() => setTab(value)}>
            <Icon aria-hidden strokeWidth={1.8} />
            {label}
          </button>
        ))}
      </div>

      <div className="ev-settings" role="tabpanel">
        {tab === 'general' && (
          <>
            <Card title="Shortcuts">
              <ShortcutRow shortcuts={shortcuts} action="dictation" hint={talkHint(shortcuts.bindings?.dictation ?? '')} />
              <ShortcutRow shortcuts={shortcuts} action="toggle" hint="Show or hide this panel." />
              {shortcuts.bindings ? <RestoreDefaultShortcuts shortcuts={shortcuts} /> : null}
            </Card>

            {isDesktop() && (
              <Card title="Recording control">
                <Row
                  label="Position"
                  hint={settings?.hud_frame ? 'You dragged it. Pick a spot to snap it back.' : 'Or drag the control anywhere.'}
                >
                  <Select
                    label="Control position"
                    value={settings?.hud_frame ? 'custom' : settings?.launcher_position ?? 'top_center'}
                    options={settings?.hud_frame ? [{ value: 'custom', label: 'Where you left it' }, ...SPOTS] : SPOTS}
                    disabled={!settings || positionBusy}
                    onChange={(next) => { if (next !== 'custom') pickPosition(next); }}
                  />
                </Row>
                <Row label="Live words" hint={captionsOn ? 'What you say, under the timer, as you say it.' : 'Needs captions, under Capture.'}>
                  <Select
                    label="Lines of live words while recording"
                    value={String(previewLines)}
                    options={PREVIEW_OPTIONS}
                    disabled={!settings || !captionsOn}
                    onChange={(next) => changeLook(Number(next) as HudPreviewLines, translucent)}
                  />
                </Row>
                <div className="ev-set-row">
                  <Switch
                    className="w-full"
                    checked={translucent}
                    onCheckedChange={(next) => changeLook(previewLines, next)}
                    disabled={!settings}
                    label="See-through"
                    hint="Lets the screen show through, so it sits back while you talk."
                  />
                </div>
                <div className="ev-set-row">
                  <Switch
                    className="w-full"
                    checked={soundsOn}
                    onCheckedChange={toggleSounds}
                    disabled={!settings || soundsBusy}
                    label="Start and stop sounds"
                    hint="A tick as the mic goes live, a pop when it stops."
                  />
                </div>
                {positionError || lookError ? <p role="alert" className="ev-set-hint px-3 py-2 text-[var(--ev-warn-ink)]">{positionError ?? lookError}</p> : null}
              </Card>
            )}

            {isDesktop() && (
              <Card title="Capture">
                <div className="ev-set-row flex-col items-stretch">
                  <Switch
                    className="w-full"
                    checked={captionsOn}
                    onCheckedChange={toggleCaptions}
                    disabled={!settings || captionsBusy}
                    label="Captions while recording"
                    hint="Written on this Mac as you speak. The cloud transcript replaces them."
                  />
                  {captionsOn && (speech ?? permissions?.speech) === false && (
                    <p className="ev-set-hint mt-2">
                      Speech Recognition is off for Eavesy, so there are no captions and dictation waits for the cloud.{' '}
                      <button type="button" onClick={() => onOpenPrivacy('speech')} className="ev-link">Open System Settings</button>
                    </p>
                  )}
                </div>
                <div className="ev-set-row flex-col items-stretch">
                  <Switch
                    className="w-full"
                    checked={shotsOn}
                    onCheckedChange={toggleScreenshots}
                    disabled={!settings || shotsBusy}
                    label="Add macOS screenshots"
                    hint={shotFolder ? `Copies new ones from ${shotFolder}. The originals stay put.` : 'Copies new ones in. The originals stay put.'}
                  />
                  {shotsError ? <p role="alert" className="ev-set-hint mt-2 text-[var(--ev-warn-ink)]">{shotsError}</p> : null}
                </div>
                <Row label="Recordings folder" hint={<span className="ev-set-path block" title={folder}>{folderStatus ?? folder}</span>}>
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
                          setFolderStatus('New recordings go here. Existing ones stay put.');
                        })
                        .catch((error: unknown) => setFolderStatus(errMsg(error, 'Could not change the recordings folder.')))
                        .finally(() => setFolderBusy(false));
                    }}
                  >
                    Change
                  </Button>
                </Row>
              </Card>
            )}

            {isDesktop() && (
              <Card title="This Mac">
                {allGranted && !showPermissions ? (
                  <Row label="Permissions" hint="Everything Eavesy needs is on.">
                    <ShieldCheck className="h-4 w-4 text-[var(--ev-leaf)]" aria-hidden />
                    <Button variant="ghost" size="sm" onClick={() => setShowPermissions(true)}>Review</Button>
                  </Row>
                ) : (
                  <PermissionChecklist
                    permissions={permissions}
                    checking={checkingPermission}
                    fnInUse={fnInUse}
                    onRequest={onRequestPermission}
                    onOpenSettings={onOpenPrivacy}
                    onRelaunch={onRelaunch}
                  />
                )}
                <Row label="Setup" hint="Sign-in, permissions and shortcuts, step by step.">
                  <Button variant="outline" size="sm" icon={RotateCcw} onClick={onRunSetup}>Run again</Button>
                </Row>
                <UpdatesRow />
              </Card>
            )}
          </>
        )}

        {tab === 'dictation' && (
          signedIn ? (
            <>
              <DictationCard account={accountPrefs} />
              <TranscriptionCard account={accountPrefs} />
              <DictionarySettings />
            </>
          ) : <SignInFirst what="choose how dictations are written: their tone, AI formatting, languages and your words" />
        )}

        {tab === 'projects' && (
          signedIn
            ? <ProjectsSettings account={accountPrefs.prefs} onChanged={onProjectsChanged} />
            : <SignInFirst what="make projects: one per codebase or client, each with its own words and dictation tone" />
        )}

        {tab === 'account' && (
          <Section title="Profile">
            <AccountCard account={account} connecting={connecting} onConnect={onConnect} onCancelConnect={onCancelConnect} onDisconnect={onDisconnect} onOpenWeb={onOpenWeb} />
          </Section>
        )}
      </div>
    </div>
  );
}

function SignInFirst({ what }: { what: string }) {
  return <Section title="Signed out"><p className="ev-set-hint">Sign in under Account to {what}.</p></Section>;
}
