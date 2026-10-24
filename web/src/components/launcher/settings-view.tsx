'use client';

import './preferences.css';

import { ArrowLeft, ArrowUpRight, AudioLines, BookOpen, Check, FolderOpen, Keyboard, Languages, Loader2, LogOut, MessageSquareText, RotateCcw, ShieldCheck, SlidersHorizontal, UserRound } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Card, IconButton, Mascot, Row, Segmented, Select, StatusDisc, Switch } from '@/components/launcher/ui';
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
  setAgentHold,
  setAgentVoice,
  setAgentMessages,
  copyText,
  setHudLook,
  checkPermissions,
  checkForUpdates,
  getAppInfo,
  getScreenshotFolder,
  installUpdate,
  setAutoImportScreenshots,
  type AccountInfo,
  type SettingsSection,
  type HudPreviewLines,
  type LauncherPosition,
  type Permissions,
  type PrivacyPane,
  type Settings,
  type UpdateStatus,
} from '@/lib/desktop/bridge';
import { cn } from '@/lib/utils';
import { AGENT_INSTRUCTIONS } from '@/lib/agent-instructions';
import type { SetupPermissionKind } from './use-setup-permissions';
import { DictionarySettings } from '@/components/dictionary/dictionary-settings';
import { DictationCard, LanguagesCard, ProjectsSettings, useAccountPrefs, useProjects, WordsCard } from './account-settings';
import { PromptsSettings } from './prompts-settings';
import { useSavedPrompts } from './use-saved-prompts';

export type AccountState = AccountInfo | null | undefined;

const PREVIEW_OPTIONS: { value: string; label: string }[] = [
  { value: '0', label: 'Off' },
  { value: '1', label: '1 line' },
  { value: '2', label: '2 lines' },
  { value: '4', label: '4 lines' },
];

type AgentHold = '0' | '120' | '300' | '900';
const AGENT_HOLDS: { value: AgentHold; label: string }[] = [
  { value: '0', label: 'Don’t wait' },
  { value: '120', label: '2 min' },
  { value: '300', label: '5 min' },
  { value: '900', label: '15 min' },
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
      .catch((e: unknown) => setError(errMsg(e, kind === 'check' ? 'Couldn’t check for updates.' : 'Couldn’t install the update.')))
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
          <p className="ev-set-label">Waiting for you in the browser…</p>
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
        <Button variant="primary" size="sm" className="self-start" onClick={onConnect}>Sign in at eavesy.com</Button>
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

/** Every permission with its state, then what Eavesy is connected to. Nothing hides behind a summary. */
function PermissionsPage({ permissions, checkingPermission, fnInUse, account, connecting, onRequestPermission, onOpenPrivacy, onRelaunch, onRunSetup, onConnect, onOpenAccount }: {
  permissions: Permissions | null;
  checkingPermission: SetupPermissionKind | null;
  fnInUse: boolean;
  account: AccountState;
  connecting: boolean;
  onRequestPermission: (kind: SetupPermissionKind) => Promise<boolean>;
  onOpenPrivacy: (pane: PrivacyPane) => void;
  onRelaunch: () => void;
  onRunSetup: () => void;
  onConnect: () => void;
  onOpenAccount: () => void;
}) {
  const used = permissionSpecs(fnInUse).filter((spec) => spec.need !== 'not-needed');
  const off = used.filter((spec) => isGranted(permissions, spec.kind) === false);
  const missingRequired = off.some((spec) => spec.need === 'required');
  const summary = !permissions
    ? 'Checking what’s turned on…'
    : !off.length
      ? `All ${used.length} permissions Eavesy uses are on.`
      : `${used.length - off.length} of ${used.length} on. ${missingRequired ? 'Eavesy can’t record until the microphone is on.' : `Off: ${off.map((spec) => spec.label).join(', ')}. Eavesy still works without ${off.length === 1 ? 'it' : 'them'}.`}`;
  return (
    <>
      <div className="ev-perm-summary" data-state={!permissions ? 'checking' : missingRequired ? 'warn' : off.length ? 'partial' : 'ok'} role="status">
        <StatusDisc status={!permissions ? 'checking' : missingRequired ? 'denied' : off.length ? 'pending' : 'granted'} />
        <p>{summary}</p>
      </div>
      <Card title="On this Mac">
        <PermissionChecklist
          permissions={permissions}
          checking={checkingPermission}
          fnInUse={fnInUse}
          onRequest={onRequestPermission}
          onOpenSettings={onOpenPrivacy}
          onRelaunch={onRelaunch}
        />
      </Card>
      <Card title="Connected">
        <div className="ev-perm">
          <StatusDisc status={account === undefined || connecting ? 'checking' : account ? 'granted' : 'pending'} />
          <div className="min-w-0">
            <div className="ev-perm-title">Eavesy account<span className="ev-perm-tag">optional</span></div>
            <p className="ev-perm-hint">
              {account
                ? `Signed in${account.email ? ` as ${account.email}` : ''}. Transcripts, summaries and sync across your devices are on.`
                : connecting
                  ? 'Waiting for you in the browser…'
                  : 'Not signed in. Recordings stay on this Mac, without cloud transcripts or sync.'}
            </p>
          </div>
          <div className="ev-perm-action">
            {account ? (
              <Button variant="ghost" size="sm" onClick={onOpenAccount}>Manage</Button>
            ) : account === null && !connecting ? (
              <Button variant="outline" size="sm" onClick={onConnect}>Sign in</Button>
            ) : null}
          </div>
        </div>
      </Card>
      <Card>
        <div className="ev-set-row">
          <p className="ev-set-hint min-w-0">Walk through sign-in, permissions and shortcuts again.</p>
          <Button variant="outline" size="sm" icon={RotateCcw} className="shrink-0" onClick={onRunSetup}>Run setup again</Button>
        </div>
      </Card>
    </>
  );
}

export function SettingsView({ standalone = false, section: shownSection, onSection, permissions, checkingPermission, onRequestPermission, onOpenPrivacy, onRelaunch, onRunSetup, fnInUse, account, connecting, onConnect, onCancelConnect, onDisconnect, onOpenWeb, onShortcutsChanged, onProjectsChanged, onBack }: {
  standalone?: boolean;
  /** The section on screen, when the window decides it (another window can ask for one). */
  section?: SettingsSection;
  onSection?: (section: SettingsSection) => void;
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
  /** Leaves settings: closes the window, or goes back in the panel. */
  onBack: () => void;
}) {
  const [settings, setSettings] = useState<(Settings & { hud_frame?: unknown }) | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [loadingLocal, setLoadingLocal] = useState(true);
  const [ownSection, setOwnSection] = useState<SettingsSection>('capture');
  const section = shownSection ?? ownSection;
  const setSection = (id: SettingsSection) => { setOwnSection(id); onSection?.(id); };
  const [openProject, setOpenProject] = useState<string | null>(null);
  // Loaded per account: after signing in here, and cleared on sign-out.
  const accountPrefs = useAccountPrefs(account ? account.email ?? account.name ?? 'signed-in' : null);
  const projects = useProjects(!!account, onProjectsChanged);
  const prompts = useSavedPrompts(!!account);
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);
  const sections: { id: SettingsSection; label: string; icon: typeof SlidersHorizontal; hint: string }[] = [
    { id: 'capture', label: 'Capture', icon: SlidersHorizontal, hint: 'Recording, screenshots, and where things are saved.' },
    { id: 'dictation', label: 'Dictation', icon: AudioLines, hint: 'How your words are written when Eavesy types them for you.' },
    { id: 'transcription', label: 'Transcription', icon: Languages, hint: 'The languages Eavesy listens for.' },
    { id: 'dictionary', label: 'Dictionary', icon: BookOpen, hint: 'Words to spell your way, and words to swap for others.' },
    { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, hint: 'Make Eavesy work the way you do.' },
    { id: 'prompts', label: 'Prompts', icon: MessageSquareText, hint: 'Text you send often, ready to paste or to run as a slash command.' },
    { id: 'projects', label: 'Projects', icon: FolderOpen, hint: 'Group recordings, words and dictation style by codebase, client or topic.' },
    { id: 'permissions', label: 'Permissions', icon: ShieldCheck, hint: 'What Eavesy can use on this Mac, and what it’s connected to.' },
    { id: 'account', label: 'Account', icon: UserRound, hint: 'Your account, connection, and app updates.' },
  ];
  const activeSection = sections.find((item) => item.id === section)!;
  const go = (id: SettingsSection) => { setSection(id); if (id !== 'projects') setOpenProject(null); if (id !== 'prompts') setOpenPrompt(null); };
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
      .catch(() => setLocalError('The recording sound preference couldn’t be saved. Try the switch again.'))
      .finally(() => setSoundsBusy(false));
  };
  const agentsOn = settings?.agent_voice ?? false;
  const agentHold = String(settings?.agent_hold_secs ?? 300) as AgentHold;
  const [agentsBusy, setAgentsBusy] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const toggleAgents = (next: boolean) => {
    setAgentsBusy(true);
    setAgentsError(null);
    void setAgentVoice(next)
      .then(() => setSettings((current) => current ? { ...current, agent_voice: next } : current))
      .catch((error: unknown) => setAgentsError(errMsg(error, 'Couldn’t change that setting.')))
      .finally(() => setAgentsBusy(false));
  };
  const pickHold = (next: AgentHold) => {
    setAgentsError(null);
    void setAgentHold(Number(next))
      .then(() => setSettings((current) => current ? { ...current, agent_hold_secs: Number(next) } : current))
      .catch((error: unknown) => setAgentsError(errMsg(error, 'Couldn’t change how long sessions wait.')));
  };
  const messagesOn = settings?.agent_messages ?? false;
  const [messagesBusy, setMessagesBusy] = useState(false);
  const [messagesNote, setMessagesNote] = useState<string | null>(null);
  const toggleMessages = (next: boolean) => {
    setMessagesBusy(true);
    setMessagesNote(null);
    void setAgentMessages(next)
      .then(() => setSettings((current) => current ? { ...current, agent_messages: next } : current))
      .catch((error: unknown) => setMessagesNote(errMsg(error, 'Couldn’t change that setting.')))
      .finally(() => setMessagesBusy(false));
  };
  const copyInstructions = () => {
    void copyText(AGENT_INSTRUCTIONS)
      .then(() => setMessagesNote('Copied. Paste it into a Claude project’s instructions or ChatGPT’s custom instructions.'))
      .catch(() => setMessagesNote('Couldn’t copy the instructions.'));
  };
  const savedLines = settings?.hud_preview_lines;
  const previewLines: HudPreviewLines = savedLines === 1 || savedLines === 2 || savedLines === 4 ? savedLines : 0;
  const translucent = settings?.hud_translucent ?? true;
  const fastWords = settings?.fast_live_words ?? true;
  const resultPreview = settings?.hud_result_preview ?? true;
  const [lookError, setLookError] = useState<string | null>(null);
  const changeLook = (lines: HudPreviewLines, see: boolean, fast?: boolean, preview?: boolean) => {
    setLookError(null);
    setSettings((current) => current ? { ...current, hud_preview_lines: lines, hud_translucent: see, fast_live_words: fast ?? current.fast_live_words, hud_result_preview: preview ?? current.hud_result_preview } : current);
    void setHudLook(lines, see, fast, preview).catch((error: unknown) => {
      setLookError(errMsg(error, 'Couldn’t change how the recording looks.'));
      // Show what is actually saved, whichever change failed.
      void getSettings().then((saved) => setSettings((current) => current && saved
        ? { ...current, hud_preview_lines: saved.hud_preview_lines, hud_translucent: saved.hud_translucent, fast_live_words: saved.fast_live_words, hud_result_preview: saved.hud_result_preview }
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
      .catch((error: unknown) => setShotsError(errMsg(error, 'Couldn’t change that setting.')))
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
      .catch(() => setLocalError('The live captions preference couldn’t be saved. Try the switch again.'))
      .finally(() => setCaptionsBusy(false));
  };

  const loadLocal = useCallback(async () => {
    setLoadingLocal(true);
    setLocalError(null);
    const current = await getSettings();
    if (current) setSettings(current);
    else setLocalError('Preferences on this Mac couldn’t be loaded. Try again.');
    setLoadingLocal(false);
  }, []);
  useEffect(() => { void loadLocal(); }, [loadLocal]);

  const pickPosition = (position: LauncherPosition) => {
    setPositionBusy(true);
    setPositionError(null);
    void setLauncherPosition(position)
      .then(() => setSettings((current) => current ? { ...current, launcher_position: position, hud_frame: null } : current))
      .catch((error: unknown) => setPositionError(errMsg(error, 'Couldn’t change position.')))
      .finally(() => setPositionBusy(false));
  };

  const folder = settings?.recordings_root ?? '~/Eavesy/Recordings';
  const signInFirst = (what: string) => (
    <div className="ev-signin-note">
      <p className="ev-set-hint">Sign in to {what}. These settings live in your Eavesy account and follow you to every device.</p>
      <Button variant="outline" size="sm" onClick={() => go('account')}>Go to Account</Button>
    </div>
  );

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
          <div className="ev-settings-nav-title"><Mascot state="idle" size={22} />Settings</div>
          {sections.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" aria-current={section === id ? 'page' : undefined} aria-controls={`settings-${id}`} onClick={() => go(id)}>
              <Icon size={17} strokeWidth={1.75} aria-hidden />{label}
            </button>
          ))}
          <p className="ev-settings-nav-foot">Changes save as you make them.</p>
        </nav>
        <div className="ev-settings-pane">
          <header className="ev-settings-heading">
            <div className="min-w-0 flex-1">
              <h1>{activeSection.label}</h1>
              <p>{activeSection.hint}</p>
            </div>
            {standalone && <Button variant="primary" className="shrink-0" kbd="esc" onClick={onBack}>Done</Button>}
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
          {account
            ? <DictationCard account={accountPrefs} projects={projects.projects} onOpenProject={(id) => { setOpenProject(id); setSection('projects'); }} />
            : signInFirst('choose how dictation is written')}
          {isDesktop() && (
            <Section title="Claude Code sessions">
              <Switch
                checked={agentsOn}
                onCheckedChange={toggleAgents}
                disabled={!settings || agentsBusy}
                label="Say when a session finishes or needs you"
                hint="Eavesy adds hooks to Claude Code on this Mac, says what each session needs and suggests a reply. Your reply goes in only when you press Send. When you’re signed in, each session’s last message and your prompt go to Eavesy’s cloud, where Anthropic’s Claude writes the summary and suggestion."
              />
              {agentsOn && (
                <div className="mt-3">
                  <Segmented label="How long a finished session waits for your reply" value={agentHold} onChange={pickHold} options={AGENT_HOLDS} size="sm" />
                  <p className="ev-set-hint mt-2">While it waits, the session looks busy in Claude. Press Esc there to take it back.</p>
                </div>
              )}
              {agentsError && <p className="ev-set-hint mt-2">{agentsError}</p>}
            </Section>
          )}
          {isDesktop() && (
            <Section title="Claude chat and ChatGPT">
              <Switch
                checked={messagesOn}
                onCheckedChange={toggleMessages}
                disabled={!settings || !account || messagesBusy}
                label="Show and say what your agents send you"
                hint="Agents connected to Eavesy’s MCP can tell you when they finish (send_to_human) or ask you something (ask_human). This Mac checks your Eavesy account every few seconds, shows each message at the top right and reads it aloud. Your typed answer goes back only to the agent that asked, as text: it never approves anything."
              />
              {!account && <p className="ev-set-hint mt-2">Sign in first: messages come through your Eavesy account.</p>}
              {messagesOn && (
                <div className="mt-3">
                  <p className="ev-set-hint">Add Eavesy as a connector in Claude or ChatGPT, then paste these instructions so the model uses it.</p>
                  <Button variant="outline" size="sm" className="mt-2" onClick={copyInstructions}>Copy instructions</Button>
                </div>
              )}
              {messagesNote && <p className="ev-set-hint mt-2">{messagesNote}</p>}
            </Section>
          )}
        </div>
        <div id="settings-transcription" hidden={section !== 'transcription'}>
          {account ? <LanguagesCard account={accountPrefs} /> : signInFirst('choose the languages Eavesy listens for')}
        </div>
        <div id="settings-dictionary" hidden={section !== 'dictionary'}>
          {account ? <><WordsCard account={accountPrefs} /><DictionarySettings /></> : signInFirst('keep a dictionary')}
        </div>
        <div id="settings-prompts" hidden={section !== 'prompts'}>
          {account
            ? <PromptsSettings state={prompts} open={openPrompt} onOpen={setOpenPrompt} />
            : signInFirst('save prompts')}
        </div>
        <div id="settings-projects" hidden={section !== 'projects'}>
          {account
            ? <ProjectsSettings account={accountPrefs.prefs} state={projects} open={openProject} onOpen={setOpenProject} onOpenDictation={() => go('dictation')} />
            : signInFirst('make projects')}
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
          <Switch checked={resultPreview} disabled={!settings} onCheckedChange={next => changeLook(previewLines, translucent, undefined, next)} label="Show the words when it's done" hint="After a dictation, the words open under the pill so you can fix them or change the tone. Off: just a Pasted stamp." />
          <Switch checked={translucent} disabled={!settings} onCheckedChange={next => changeLook(previewLines, next)} label="See-through" hint="Lets the screen show through while you talk." />
          <Switch checked={fastWords} disabled={!settings} onCheckedChange={next => changeLook(previewLines, translucent, next)} label="Faster live words" hint="Shows words about a second sooner. Turn off if live words look jumpy or your Mac runs hot." />
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
                  .catch((error: unknown) => setFolderStatus(errMsg(error, 'Couldn’t change the recordings folder.')))
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
          <PermissionsPage
            permissions={permissions}
            checkingPermission={checkingPermission}
            fnInUse={fnInUse}
            account={account}
            connecting={connecting}
            onRequestPermission={onRequestPermission}
            onOpenPrivacy={onOpenPrivacy}
            onRelaunch={onRelaunch}
            onRunSetup={onRunSetup}
            onConnect={onConnect}
            onOpenAccount={() => go('account')}
          />
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
