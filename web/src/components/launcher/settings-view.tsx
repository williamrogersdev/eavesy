'use client';

import './preferences.css';

import { ArrowLeft, ArrowUpRight, AudioLines, BookOpen, Check, FolderOpen, Keyboard, Loader2, LogOut, RotateCcw, ShieldCheck, SlidersHorizontal, UserRound } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
import { cn } from '@/lib/utils';
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
      : status.state === 'installed'
        ? `Eavesy ${status.version} is installed. It takes effect the next time Eavesy starts.`
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
        {account.name || account.email ? accountInitial(account) : <UserRound size={20} strokeWidth={1.75} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="ev-set-label truncate">
          {account.name ?? account.email ?? 'Eavesy account'}
        </p>
        <p className="ev-set-hint flex items-center gap-1 truncate">
          <Check className="h-3 w-3 shrink-0 text-[var(--ev-leaf)]" />
          {account.name && account.email ? account.email : 'Signed in on this Mac'}
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
  { value: 'top_left', label: 'Top left', className: 'top-4 left-2' },
  { value: 'top_center', label: 'Top center', className: 'top-4 left-1/2 -translate-x-1/2' },
  { value: 'top_right', label: 'Top right', className: 'top-4 right-2' },
  { value: 'bottom_center', label: 'Bottom center', className: 'bottom-1 left-1/2 -translate-x-1/2' },
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
                'group absolute flex h-6 w-[30%] items-center justify-center rounded-md transition-colors disabled:cursor-default',
                spot.className,
                selected ? 'bg-[var(--ev-coat-soft)]' : 'hover:bg-[var(--ev-hover)]',
              )}
            >
              <span
                className={cn(
                  'h-2.5 w-12 rounded-full transition-colors',
                  selected ? 'bg-[var(--ev-coat)]' : 'bg-[var(--ev-line-strong)] group-hover:bg-[var(--ev-ink-3)]',
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

export function SettingsView({ standalone = false, permissions, checkingPermission, onRequestPermission, onOpenPrivacy, onRelaunch, onRunSetup, fnInUse, account, connecting, onConnect, onCancelConnect, onDisconnect, onOpenWeb, onShortcutsChanged, onProjectsChanged, onBack }: {
  standalone?: boolean;
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
  const [localError, setLocalError] = useState<string | null>(null);
  const [loadingLocal, setLoadingLocal] = useState(true);
  const [section, setSection] = useState('capture');
  const accountPrefs = useAccountPrefs();
  const sections = [
    { id: 'capture', label: 'Capture', icon: SlidersHorizontal, hint: 'Recording, screenshots, and where things are saved.' },
    { id: 'dictation', label: 'Dictation', icon: AudioLines, hint: 'Choose the tone and formatting used when you talk.' },
    { id: 'transcription', label: 'Transcription', icon: AudioLines, hint: 'Languages and words Eavesy should recognize.' },
    { id: 'dictionary', label: 'Dictionary', icon: BookOpen, hint: 'Review the spellings learned from your corrections.' },
    { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, hint: 'Make Eavesy work the way you do.' },
    { id: 'projects', label: 'Projects', icon: FolderOpen, hint: 'Keep related captures and vocabulary together.' },
    { id: 'permissions', label: 'Permissions', icon: ShieldCheck, hint: 'You decide what Eavesy can access on this Mac.' },
    { id: 'account', label: 'Account', icon: UserRound, hint: 'Your account, connection, and app updates.' },
  ];
  const activeSection = sections.find((item) => item.id === section)!;
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
    setLocalError(null);
    void setCaptureSounds(next)
      .then(() => setSettings((current) => current ? { ...current, capture_sounds: next } : current))
      .catch(() => setLocalError('The recording sound preference could not be saved. Try the switch again.'))
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
    setLocalError(null);
    void setLiveCaptions(next)
      .then(async () => {
        setSettings((current) => current ? { ...current, live_captions: next } : current);
        // Turning captions on is when Speech Recognition is asked for.
        if (next) setSpeech((await checkPermissions({ needScreen: false, needSpeech: true }))?.speech);
      })
      .catch(() => setLocalError('The live captions preference could not be saved. Try the switch again.'))
      .finally(() => setCaptionsBusy(false));
  };

  const loadLocal = useCallback(async () => {
    setLoadingLocal(true);
    setLocalError(null);
    const current = await getSettings();
    if (current) setSettings(current);
    else setLocalError('Preferences on this Mac could not be loaded. Try again.');
    setLoadingLocal(false);
  }, []);
  useEffect(() => { void loadLocal(); }, [loadLocal]);

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
    <div className="ev-preferences" data-standalone={standalone}>
      {/* On the Mac the title bar carries Back and the title. */}
      {!isDesktop() && !standalone && (
        <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-3">
          <IconButton label="Back" title="Back (esc)" icon={ArrowLeft} onClick={onBack} />
          <h2 className="ev-set-label">Settings</h2>
        </div>
      )}

      <div className="ev-settings-layout">
        <nav className="ev-settings-nav" aria-label="Settings sections">
          <div className="ev-settings-nav-title">Settings</div>
          {sections.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" aria-current={section === id ? 'page' : undefined} aria-controls={`settings-${id}`} onClick={() => setSection(id)}>
              <Icon size={17} strokeWidth={1.75} aria-hidden />{label}
            </button>
          ))}
        </nav>
        <div className="ev-settings-pane">
          <header className="ev-settings-heading">
            <h1>{activeSection.label}</h1>
            <p>{activeSection.hint}</p>
          </header>
          <div className="ev-settings">
        {loadingLocal && <p role="status" className="ev-set-hint">Loading Mac preferences…</p>}
        {localError && <div role="alert" className="ev-settings-feedback"><p>{localError}</p>{!settings && <Button variant="outline" size="sm" loading={loadingLocal} onClick={() => void loadLocal()}>Retry</Button>}</div>}
        <div id="settings-account" hidden={section !== 'account'}>
        <Section title="Account">
          <AccountCard account={account} connecting={connecting} onConnect={onConnect} onCancelConnect={onCancelConnect} onDisconnect={onDisconnect} onOpenWeb={onOpenWeb} />
        </Section>

        </div>
        <div id="settings-dictation" hidden={section !== 'dictation'}>
          {account ? <DictationCard account={accountPrefs} /> : <p className="ev-set-hint">Sign in from Account to choose your dictation tone.</p>}
        </div>
        <div id="settings-transcription" hidden={section !== 'transcription'}>
          {account ? <TranscriptionCard /> : <p className="ev-set-hint">Sign in from Account to manage your languages and custom words.</p>}
        </div>
        <div id="settings-dictionary" hidden={section !== 'dictionary'}>
          {account ? <DictionarySettings /> : <p className="ev-set-hint">Sign in from Account to manage learned spellings.</p>}
        </div>
        <div id="settings-projects" hidden={section !== 'projects'}>
          {account ? <ProjectsSettings account={accountPrefs.prefs} onChanged={onProjectsChanged} /> : <p className="ev-set-hint">Sign in from Account to manage your projects.</p>}
        </div>

        <div id="settings-shortcuts" hidden={section !== 'shortcuts'}>
        <Card title="Shortcuts">
          <ShortcutRow shortcuts={shortcuts} action="dictation" hint={talkHint(shortcuts.bindings?.dictation ?? '')} />
          <ShortcutRow shortcuts={shortcuts} action="toggle" hint="Show or hide this panel." />
          {shortcuts.bindings ? <RestoreDefaultShortcuts shortcuts={shortcuts} /> : null}
        </Card>

        </div>
        <div id="settings-capture" hidden={section !== 'capture'}>
        {isDesktop() && (
          <Section title="Sounds">
            <Switch
              checked={soundsOn}
              onCheckedChange={toggleSounds}
              disabled={!settings || soundsBusy}
              label="Play a sound when recording starts and stops"
              hint="A quiet tick as the mic goes live, and a pop when it stops."
            />
          </Section>
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

        <Section title="Recording appearance">
          <Row label="Live words" hint="What you say, under the timer, as you say it.">
            <Select label="Lines of live words while recording" value={String(previewLines)} options={PREVIEW_OPTIONS} disabled={!settings || !captionsOn} onChange={next => changeLook(Number(next) as HudPreviewLines, translucent)} />
          </Row>
          <Switch checked={translucent} disabled={!settings} onCheckedChange={next => changeLook(previewLines, next)} label="See-through" hint="Lets the screen show through while you talk." />
          {lookError && <p role="alert" className="ev-set-hint">{lookError}</p>}
        </Section>

        <Section title="Position">
          <PositionPicker
            value={settings?.launcher_position ?? 'top_center'}
            custom={!!settings?.hud_frame}
            disabled={!settings || positionBusy || !isDesktop()}
            onPick={pickPosition}
          />
          {positionError ? <p role="alert" className="ev-set-hint mt-2 text-center text-[var(--ev-warn-ink)]">{positionError}</p> : null}
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

        </div>
        <div id="settings-permissions" hidden={section !== 'permissions'}>
        {isDesktop() && (
          <Card title="Permissions">
            {allGranted && !showPermissions ? (
              <div className="ev-set-row">
                <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--ev-leaf)]" aria-hidden />
                <p className="ev-set-label min-w-0 flex-1">Everything Eavesy needs is turned on</p>
                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setShowPermissions(true)}>Review</Button>
              </div>
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
            <div className="ev-set-row">
              <p className="ev-set-hint min-w-0">Walk through sign-in, permissions and shortcuts again.</p>
              <Button variant="outline" size="sm" icon={RotateCcw} className="shrink-0" onClick={onRunSetup}>Run setup again</Button>
            </div>
          </Card>
        )}

        </div>
        <div hidden={section !== 'account'}>
        {isDesktop() && (
          <Section title="Updates">
            <UpdatesCard />
          </Section>
        )}
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}
