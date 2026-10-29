import type { LiveCaption, LiveLine } from './live-captions';
import type { LearningEvent } from './learning';
export { errMsg } from './errors';

type UnlistenFn = () => void;

interface TauriGlobal {
  core: { convertFileSrc?(path: string): string; invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
  event: {
    listen<T>(
      event: string,
      handler: (e: { payload: T }) => void,
    ): Promise<UnlistenFn>;
  };
  dialog?: {
    open(options: {
      directory: boolean;
      multiple: boolean;
      defaultPath?: string;
      title?: string;
    }): Promise<string | string[] | null>;
  };
  webview?: {
    getCurrentWebview(): {
      onDragDropEvent(handler: (event: { payload: DragDropPayload }) => void): Promise<UnlistenFn>;
    };
  };
}

/** Tauri's native drag-drop: real file paths, unlike HTML5 drag events. */
export type DragDropPayload =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
  | { type: 'leave' };

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

function tauri(): TauriGlobal | null {
  if (typeof window === 'undefined') return null;
  return window.__TAURI__ ?? null;
}

export function isDesktop(): boolean {
  return tauri() !== null;
}

/** Settings sections another window can ask the Settings window to show. */
export type SettingsSection = 'capture' | 'dictation' | 'transcription' | 'dictionary' | 'shortcuts' | 'prompts' | 'projects' | 'connections' | 'assistant' | 'machine' | 'permissions' | 'account';
const SETTINGS_SECTIONS: readonly SettingsSection[] = ['capture', 'dictation', 'transcription', 'dictionary', 'shortcuts', 'prompts', 'projects', 'connections', 'assistant', 'machine', 'permissions', 'account'];
/** Both webviews share an origin, so the panel leaves the section here for the Settings window. */
const SETTINGS_SECTION_KEY = 'eavesy.settings.section';
/** A request older than this was for a Settings window that has come and gone. */
const SETTINGS_SECTION_TTL_MS = 10_000;

/** Opens the Settings window, on `section` when given. */
export async function openSettingsWindow(section?: SettingsSection): Promise<void> {
  if (!isDesktop()) return;
  if (section) {
    try { window.localStorage.setItem(SETTINGS_SECTION_KEY, JSON.stringify({ section, at: Date.now() })); }
    catch { /* No storage: Settings opens where it was. */ }
  }
  await invoke('show_settings');
}

function readSettingsSection(raw: string | null, now: number): SettingsSection | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const { section, at } = value as { section?: unknown; at?: unknown };
    if (typeof at !== 'number' || now - at > SETTINGS_SECTION_TTL_MS) return null;
    return SETTINGS_SECTIONS.find((known) => known === section) ?? null;
  } catch {
    return null;
  }
}

/** The section the panel asked Settings to show, read once. */
export function takeSettingsSection(now = Date.now()): SettingsSection | null {
  try {
    const section = readSettingsSection(window.localStorage.getItem(SETTINGS_SECTION_KEY), now);
    window.localStorage.removeItem(SETTINGS_SECTION_KEY);
    return section;
  } catch {
    return null;
  }
}

/** Calls back when the panel asks an open Settings window for a section. */
export function onSettingsSection(cb: (section: SettingsSection) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SETTINGS_SECTION_KEY || !event.newValue) return;
    const section = takeSettingsSection();
    if (section) cb(section);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

export async function closeSettingsWindow(): Promise<void> {
  if (isDesktop()) await invoke('close_settings_window');
}

/** Opens the Eavesy panel (the main window), on its history. */
export async function showLauncher(): Promise<void> {
  if (isDesktop()) await invoke('show_launcher');
}

export async function openSetup(): Promise<void> {
  if (isDesktop()) await invoke('show_setup');
}

async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const t = tauri();
  if (!t) throw new Error(`invoke(${cmd}) called outside Tauri`);
  return t.core.invoke<T>(cmd, args);
}

export async function onLauncherOpened(cb: () => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<unknown>('launcher:opened', () => cb());
}

export async function onRecordingsUpdated(cb: () => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<unknown>('recordings:updated', () => cb());
}

/** On-device captions while recording; partials replace each other, finals settle. */
export async function onLiveCaption(cb: (caption: LiveCaption) => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<LiveCaption>('recording:caption', (event) => cb(event.payload));
}

/** Setup's practice box is showing: send the next dictation's words to the panel. */
export async function setDictationInPanel(wants: boolean): Promise<void> {
  await invoke('set_dictation_in_panel', { wants });
}

/** A dictation finished for the panel: its words belong in the panel (setup's practice box). */
export async function onDictationText(cb: (text: string, sessionId: string) => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<{ sessionId: string; text: string }>('dictation:text', (event) => cb(event.payload.text, event.payload.sessionId));
}

/** Tells the Mac the panel took a dictation's words, so it doesn't fall back to the clipboard. */
export async function ackDictationText(sessionId: string): Promise<void> {
  await invoke('ack_dictation_text', { sessionId });
}

/** The stored live transcript of a recording changed; read it with `liveTranscript`. */
export async function onLiveTranscript(cb: (sessionId: string) => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<string>('recording:live_transcript', (event) => cb(event.payload));
}

export async function liveTranscript(sessionId: string): Promise<LiveLine[]> {
  if (!isDesktop()) return [];
  return invoke<LiveLine[]>('live_transcript', { sessionId });
}

export type SyncStatus = { signedOut: boolean };

/** Whether uploads are paused because the server rejected this Mac's credential. */
export async function getSyncStatus(): Promise<SyncStatus | null> {
  if (!isDesktop()) return null;
  return invoke<SyncStatus>('sync_status').catch(() => null);
}

export async function onSyncStatus(cb: (status: SyncStatus) => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<SyncStatus>('sync:status', (event) => cb(event.payload));
}

export async function hidePanel(): Promise<void> {
  if (!isDesktop()) return;
  await invoke('hide_panel');
}

export async function relaunchApp(): Promise<void> {
  if (!isDesktop()) return;
  await invoke('relaunch_app');
}

export async function resizePanel(width: number, height: number): Promise<void> {
  if (!isDesktop()) return;
  await invoke('resize_panel', { width, height });
}

export async function copyText(text: string): Promise<void> {
  if (isDesktop()) {
    await invoke('copy_text', { text });
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error('Clipboard access is unavailable in this browser.');
}

export async function pasteToFrontmost(text: string, learn = true): Promise<void> {
  if (isDesktop()) {
    await invoke('paste_to_frontmost', { text, learn });
    return;
  }
  await copyText(text);
}

export async function revealInFinder(meetingId: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke('reveal_in_finder', { meetingId }).catch(() => {});
}

export interface CaptureSession {
  session_id: string;
  started_at_ms: number;
  mode: string;
  source: string;
}

/**
 * Where a macOS permission stands. `notDetermined` means never asked, so requesting it shows the
 * system prompt; `denied` means only System Settings can change it. Accessibility and Screen
 * Recording can't tell those apart and report `notGranted` until granted.
 */
export type PermissionStatus = 'granted' | 'denied' | 'notDetermined' | 'restricted' | 'notGranted';

export interface PermissionStatuses {
  mic: PermissionStatus;
  speech: PermissionStatus;
  screen: PermissionStatus;
  accessibility: PermissionStatus;
  inputMonitoring: PermissionStatus;
  notifications: PermissionStatus;
}

export interface Permissions {
  mic: boolean;
  micAsked?: boolean;
  screen: boolean;
  accessibility?: boolean;
  /** Speech Recognition, for live captions and the instant dictation paste. */
  speech?: boolean;
  /** Input Monitoring, for the Fn / Globe shortcut. */
  inputMonitoring?: boolean;
  notifications?: boolean;
  status?: PermissionStatuses;
}

export async function checkPermissions(opts?: {
  needScreen?: boolean;
  prompt?: boolean;
  /** Also ask for Speech Recognition if it has not been answered yet. */
  needSpeech?: boolean;
}): Promise<Permissions | null> {
  if (!isDesktop()) return null;
  return invoke<Permissions>('check_permissions', {
    needScreen: opts?.needScreen ?? true,
    prompt: opts?.prompt ?? true,
    needSpeech: opts?.needSpeech ?? false,
  });
}

export async function setLiveCaptions(enabled: boolean): Promise<void> {
  await invoke('set_live_captions', { enabled });
}

export async function setCaptureSounds(enabled: boolean): Promise<void> {
  await invoke('set_capture_sounds', { enabled });
}

/** Turns talking with Claude Code sessions on or off; this adds or removes Eavesy's hooks in `~/.claude/settings.json`. */
export async function setAgentVoice(enabled: boolean): Promise<void> {
  await invoke('set_agent_voice', { enabled });
}

/** Shows and says what agents send through your Eavesy connection (`send_to_human`, `ask_human`). */
export async function setAgentMessages(enabled: boolean): Promise<void> {
  await invoke('set_agent_messages', { enabled });
}

/** How long a finished session waits for your reply. 0 never waits. */
export async function setAgentHold(seconds: number): Promise<void> {
  await invoke('set_agent_hold', { seconds });
}

/** Why a worktree can or can't be removed (machine/worktrees.rs `Status`). */
export type WorktreeStatus = 'stale' | 'missing' | 'locked' | 'dirty' | 'in_use' | 'unmerged';

/** One worktree from the quick first pass (machine/mod.rs `WorktreeRow`). */
export interface MachineWorktree {
  path: string;
  repo: string;
  branch: string | null;
  status: WorktreeStatus;
  /**
   * False while the status is a first guess: a squash-merged branch looks
   * unmerged and a merged one hasn't been checked for changes until
   * `getWorktreeDetails` answers.
   */
  settled: boolean;
}

/** The closer look at one worktree (machine/mod.rs `WorktreeDetail`). */
export interface WorktreeDetail {
  path: string;
  /** The final status. */
  status: WorktreeStatus;
  merged_via: 'ancestor' | 'squash' | null;
  /** Staged, unstaged and untracked files, not ignored ones. */
  changes: number;
  last_commit_ms: number | null;
  /** The later of the last commit and the last Claude Code session there. */
  last_activity_ms: number | null;
  /** The default branch it's compared with. */
  base: string | null;
  ahead: number | null;
  behind: number | null;
}

/** A pull request for a branch (machine/prs.rs). */
export interface RepoPr {
  number: number;
  state: 'open' | 'merged' | 'closed';
  branch: string;
  url: string;
}

/** What agent sessions left on this Mac (machine/mod.rs `Inventory`). */
export interface MachineInventory {
  repos: string[];
  worktrees: MachineWorktree[];
  /** Processes whose Claude Code session ended, each with the leftovers it started. */
  leftovers: { pid: number; started_us: number; name: string; exe: string; cwd: string | null; session_id: string | null; helpers: number; ports: number[] }[];
  zombies: { pid: number; parent_pid: number; parent_name: string | null }[];
  ports: { port: number; address: string; pid: number; name: string; cwd: string | null; owner: 'leftover' | 'session' | 'other' }[];
}

export interface MachineOutcome {
  target: string;
  ok: boolean;
  message: string | null;
  /** The command that brings a removed worktree back. */
  restore: string | null;
}

/** Reads the inventory, quickly: see `MachineWorktree.settled`. It changes nothing. */
export async function getMachineInventory(): Promise<MachineInventory> {
  return invoke<MachineInventory>('machine_inventory');
}

/** The closer look at worktrees the last inventory listed. Read-only. */
export async function getWorktreeDetails(paths: string[]): Promise<WorktreeDetail[]> {
  return invoke<WorktreeDetail[]>('machine_worktree_details', { paths });
}

/** Bytes a listed worktree takes on disk, or null if unknown. Slow for big folders. */
export async function getWorktreeSize(path: string): Promise<number | null> {
  return invoke<number | null>('machine_worktree_size', { path });
}

/** Pull requests for a repo's branches. `available` is false without the GitHub CLI. */
export async function getRepoPrs(repo: string): Promise<{ available: boolean; prs: RepoPr[] }> {
  return invoke<{ available: boolean; prs: RepoPr[] }>('machine_repo_prs', { repo });
}

/** Opens a GitHub pull request's page in the browser. */
export async function openPr(url: string): Promise<void> {
  await invoke('machine_open_pr', { url });
}

/** Shows a listed worktree in Finder, or opens Terminal in it. */
export async function openWorktree(path: string, how: 'reveal' | 'terminal'): Promise<void> {
  await invoke('machine_open_worktree', { path, how });
}

/**
 * Removes the worktrees (never forced) and asks the processes to stop
 * (SIGTERM). The app checks each one again first and skips any that is no
 * longer stale or a leftover.
 */
export async function cleanMachine(worktrees: string[], processes: { pid: number; started_us: number }[]): Promise<MachineOutcome[]> {
  return invoke<MachineOutcome[]>('machine_clean', { worktrees, processes });
}

/** How much Eavesy may do without a card (assistant/policy.rs `Mode`). */
export type AssistantMode = 'ask' | 'auto' | 'bypass';

/** A pending card (assistant/cards.rs `CardView`). Accepting sends back only its id and the ticked row ids. */
export interface AssistantCard {
  id: string;
  requester: string;
  tool: string;
  title: string;
  rows: { id: string; label: string }[];
  warning: string | null;
  expires_ms: number;
}

export interface AssistantState {
  mode: AssistantMode;
  /** The mode in force: Ask once `until_ms` has passed. */
  effective: AssistantMode;
  until_ms: number | null;
  trusted_folders: string[];
  /** The policy file changed outside Eavesy, so it's on Ask until you set it again. */
  tampered: boolean;
  cards: AssistantCard[];
}

export interface AssistantActivity {
  at_ms: number;
  requester: string;
  tool: string;
  summary: string;
  decision: string;
  outcome?: string;
}

/** Whether Claude Code on this Mac has Eavesy, and where its `claude` command is. */
export interface ClaudeCodeStatus {
  cli: string | null;
  /** The Eavesy plugin is on in Claude Code. */
  plugin: boolean;
  /** The bare MCP server was added for every folder. */
  server: boolean;
  /** What `claude mcp get` says about signing in, once Eavesy is added (`null` before). */
  signIn?: 'connected' | 'needsSignIn' | 'unknown' | null;
}

export async function claudeCodeStatus(): Promise<ClaudeCodeStatus | null> {
  if (!isDesktop()) return null;
  return invoke<ClaudeCodeStatus>('claude_code_status');
}

/**
 * Runs `claude plugin marketplace add` and `claude plugin install` for Eavesy,
 * each tried twice. Can take a minute the first time: it clones the plugin.
 */
export async function connectClaudeCode(): Promise<ClaudeCodeStatus> {
  return invoke<ClaudeCodeStatus>('connect_claude_code');
}

/** Opens Terminal running `claude mcp login` for Eavesy, which opens the browser to approve it. */
export async function signInClaudeCode(): Promise<void> {
  await invoke('sign_in_claude_code');
}

export async function getAssistantState(): Promise<AssistantState> {
  return invoke<AssistantState>('assistant_state');
}

/** Bypass opens a native confirm first; cancelling rejects with "cancelled". `minutes` null means until you turn it off. */
export async function setAssistantMode(mode: AssistantMode, minutes: number | null): Promise<void> {
  await invoke('set_assistant_mode', { mode, minutes });
}

/** Adding a folder opens a native confirm first. Resolves with the folders as saved. */
export async function setTrustedAgentFolders(folders: string[]): Promise<string[]> {
  return invoke<string[]>('set_trusted_agent_folders', { folders });
}

/** The native folder picker, for a folder to trust. Null when cancelled. */
export async function pickFolder(title: string): Promise<string | null> {
  const dialog = tauri()?.dialog;
  if (!dialog) return null;
  const picked = await dialog.open({ directory: true, multiple: false, title });
  return typeof picked === 'string' ? picked : null;
}

/** Which file a note lives in: memory.md (setup) or about-you.md (you). */
export type AssistantBook = 'setup' | 'you';

/** Eavesy's notes (assistant/memory.rs `MemoryView`). */
export interface AssistantMemory {
  on: boolean;
  notes: string[];
  about: string[];
  path: string | null;
  about_path: string | null;
  /** The last time memory.md was merged to make room, while it can be undone. */
  merged: { at_ms: number; before: number; after: number } | null;
}

export async function getAssistantMemory(): Promise<AssistantMemory> {
  return invoke<AssistantMemory>('assistant_memory');
}

export async function forgetAssistantNote(note: string, book: AssistantBook = 'setup'): Promise<void> {
  await invoke('assistant_forget', { note, book });
}

export async function forgetAllAssistantNotes(book: AssistantBook = 'setup'): Promise<void> {
  await invoke('assistant_forget_all', { book });
}

/** Puts memory.md back as it was before the last merge, keeping notes added since. */
export async function undoAssistantMerge(): Promise<void> {
  await invoke('assistant_undo_merge');
}

/** Keeps the last merge and drops its backup. */
export async function keepAssistantMerge(): Promise<void> {
  await invoke('assistant_keep_merge');
}

/** Off the record: no notes are sent or kept until the conversation is cleared. Turning it off only works before you've said anything. */
export async function setAssistantOffRecord(on: boolean): Promise<void> {
  await invoke('set_assistant_off_record', { on });
}

export async function setAssistantMemory(on: boolean): Promise<void> {
  await invoke('set_assistant_memory', { on });
}

/** Opens memory.md (or about-you.md) in the default editor. */
export async function openAssistantMemory(book: AssistantBook = 'setup'): Promise<void> {
  await invoke('open_assistant_memory', { book });
}

/** What an always-allow rule lets Eavesy do (assistant/rules.rs `Kind`). */
export type AssistantRuleKind = 'remove_worktrees' | 'stop_leftovers';

export interface AssistantRule {
  kind: AssistantRuleKind;
  under: string;
}

/** One thing waiting in the review list (assistant/rules.rs `Change`). Sent back as it came to accept or discard it. */
export type AssistantRuleChange =
  | { kind: 'add'; rule: AssistantRule; text: string }
  | { kind: 'remove'; rule: AssistantRule; text: string }
  | { kind: 'add_instruction'; text: string }
  | { kind: 'remove_instruction'; text: string }
  | { kind: 'invalid'; line: number; text: string; reason: string }
  | { kind: 'unreadable'; reason: string };

export interface AssistantRules {
  rules: { rule: AssistantRule; text: string }[];
  /** Standing instructions in force, sent with every turn. */
  instructions: string[];
  pending: AssistantRuleChange[];
  path: string | null;
}

export async function getAssistantRules(): Promise<AssistantRules> {
  return invoke<AssistantRules>('assistant_rules');
}

/** Opens a native confirm first; cancelling rejects with "cancelled". */
export async function addAssistantRule(kind: AssistantRuleKind, folder: string): Promise<AssistantRules> {
  return invoke<AssistantRules>('add_assistant_rule', { kind, folder });
}

export async function removeAssistantRule(rule: AssistantRule): Promise<AssistantRules> {
  return invoke<AssistantRules>('remove_assistant_rule', { rule });
}

/** An instruction you wrote in Settings: one line, under 300 characters. */
export async function addAssistantInstruction(text: string): Promise<AssistantRules> {
  return invoke<AssistantRules>('add_assistant_instruction', { text });
}

export async function removeAssistantInstruction(text: string): Promise<AssistantRules> {
  return invoke<AssistantRules>('remove_assistant_instruction', { text });
}

/** Accepting an added rule opens a native confirm first; cancelling rejects with "cancelled". */
export async function acceptAssistantRuleChange(change: AssistantRuleChange): Promise<AssistantRules> {
  return invoke<AssistantRules>('accept_assistant_rule_change', { change });
}

export async function discardAssistantRuleChange(change: AssistantRuleChange): Promise<AssistantRules> {
  return invoke<AssistantRules>('discard_assistant_rule_change', { change });
}

/** Opens rules.md in the default editor. */
export async function openAssistantRules(): Promise<void> {
  await invoke('open_assistant_rules');
}

/** Rules or rules.md changed through Eavesy: look again. */
export async function onAssistantRules(cb: () => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<unknown>('assistant:rules', () => cb());
}

/** How Eavesy talks (assistant/style.rs `Style`). */
export interface AssistantStyle {
  preset: 'plain' | 'eavesy' | 'more';
  chattiness: 'less' | 'default' | 'more';
  warmth: 'less' | 'default' | 'more';
}

export const DEFAULT_ASSISTANT_STYLE: AssistantStyle = { preset: 'eavesy', chattiness: 'default', warmth: 'default' };

export async function setAssistantStyle(style: AssistantStyle): Promise<void> {
  await invoke('set_assistant_style', { style });
}

export interface AssistantVoice {
  name: string;
  /** Like `en_US`. */
  locale: string;
}

export async function getAssistantVoices(): Promise<AssistantVoice[]> {
  return invoke<AssistantVoice[]>('assistant_voices');
}

/** Null name is the System Settings voice, null rate its speed. Says a sample line once saved. */
export async function setAssistantVoice(name: string | null, rate: number | null): Promise<void> {
  await invoke('set_assistant_voice', { name, rate });
}

/** No rows accepted declines the card. Resolves with what ran, or null when declined. */
export async function decideAssistantCard(cardId: string, acceptedRowIds: string[]): Promise<{ summary: string; detail: unknown } | null> {
  return invoke('assistant_card_decide', { cardId, acceptedRowIds });
}

export async function getAssistantActivity(limit = 100): Promise<AssistantActivity[]> {
  return invoke<AssistantActivity[]>('assistant_activity', { limit });
}

export async function onAssistantCards(cb: (cards: AssistantCard[]) => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<AssistantCard[]>('assistant:cards', (event) => cb(event.payload));
}

/** Eavesy's conversation (assistant/thread.rs `View`). */
export interface AssistantThread {
  busy: boolean;
  /** Off the record: no notes are sent or kept until it's cleared. Missing from older builds. */
  off_record?: boolean;
  turns: {
    id: number;
    who: 'you' | 'eavesy';
    spoken: boolean;
    /** Your turn, marked "Don't remember this". Missing from older builds. */
    unremembered?: boolean;
    at_ms: number;
    text: string;
    /** Tools Eavesy used for this turn: `line` is the first line of the result, null while running. */
    /** `remembered`: the note a `remember` step kept, for Undo, and `book` the file it went to. */
    steps: { tool: string; line: string | null; ok: boolean; remembered?: string; book?: AssistantBook }[];
  }[];
}

export async function getAssistantThread(): Promise<AssistantThread> {
  return invoke<AssistantThread>('assistant_thread');
}

/** Resolves once Eavesy has answered; the thread updates as it goes through `onAssistantThread`. */
export async function sendToAssistant(text: string, spoken = false): Promise<void> {
  await invoke('assistant_send', { text, spoken });
}

/**
 * Clears the conversation; with `forget`, the notes it taught Eavesy go too, and `expected` is how many you were shown
 * (it rejects, clearing nothing, if that changed). Resolves to a line saying what was forgotten, or "".
 */
export async function clearAssistantThread(forget = false, expected?: number): Promise<string> {
  return invoke<string>('assistant_clear', { forget, expected: expected ?? null });
}

/** The notes this conversation taught Eavesy that are still kept: what Clear offers to forget. */
export async function getAssistantTaught(): Promise<{ note: string; book: AssistantBook }[]> {
  return invoke<{ note: string; book: AssistantBook }[]>('assistant_taught');
}

/** "Don't remember this" on one of your turns. Resolves to a line saying what was forgotten. */
export async function dontRememberTurn(id: number): Promise<string> {
  return invoke<string>('assistant_dont_remember', { id });
}

/** Starts a spoken message to Eavesy, or stops the one being recorded (the mic button). */
export async function talkToAssistant(): Promise<void> {
  await invoke('assistant_talk');
}

/** Says one of Eavesy's replies again. */
export async function repeatAssistantReply(id: number): Promise<void> {
  await invoke('assistant_repeat', { id });
}

/** Something asked for the Eavesy tab: a talk turn left a card, or Open on the pill. */
export async function onAssistantShow(cb: () => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen('assistant:show', () => cb());
}

export async function onAssistantThread(cb: (thread: AssistantThread) => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<AssistantThread>('assistant:thread', (event) => cb(event.payload));
}

/** Lines of live words the recording control shows: 0 hides them and leaves just the bar. */
export type HudPreviewLines = 0 | 1 | 2 | 4;

/** `fastLiveWords` applies from the next recording; it and `resultPreview` are sent only when that switch changes. */
export async function setHudLook(lines: HudPreviewLines, translucent: boolean, fastLiveWords?: boolean, resultPreview?: boolean): Promise<void> {
  await invoke('set_hud_look', { lines, translucent, fastLiveWords, resultPreview });
}

// Each request asks for one permission alone, while the launcher steps out of the way so the
// macOS prompt can be clicked. Call them one at a time.

/** Asks for the microphone. Resolves with every permission afterwards. */
export async function requestMicrophone(): Promise<Permissions | null> {
  if (!isDesktop()) return null;
  return invoke<Permissions>('request_microphone');
}

/** Asks for Speech Recognition (live captions, instant dictation paste). */
export async function requestSpeech(): Promise<Permissions | null> {
  if (!isDesktop()) return null;
  return invoke<Permissions>('request_speech');
}

/** Asks for Screen & System Audio Recording. */
export async function requestScreen(): Promise<Permissions | null> {
  if (!isDesktop()) return null;
  return invoke<Permissions>('request_screen');
}

/**
 * Shows the Accessibility prompt, which offers to open System Settings. Resolves with whether
 * Accessibility is already granted; poll `checkPermissions({ prompt: false })` after.
 */
export async function requestAccessibility(): Promise<boolean> {
  if (!isDesktop()) return true;
  return invoke<boolean>('request_accessibility');
}

/**
 * Shows the Input Monitoring prompt (Fn / Globe shortcut). macOS applies a new grant only after
 * Eavesy relaunches, so offer `relaunchApp()` once it is granted.
 */
export async function requestInputMonitoring(): Promise<PermissionStatus> {
  if (!isDesktop()) return 'granted';
  return invoke<PermissionStatus>('request_input_monitoring');
}

/** Asks to show notifications; resolves after the user answers. */
export async function requestNotifications(): Promise<PermissionStatus> {
  if (!isDesktop()) return 'granted';
  return invoke<PermissionStatus>('request_notifications');
}

export type PrivacyPane =
  | 'microphone'
  | 'screen'
  | 'accessibility'
  | 'speech'
  | 'input_monitoring'
  | 'automation'
  | 'notifications';
export async function openPrivacySettings(pane: PrivacyPane): Promise<void> {
  if (!isDesktop()) return;
  await invoke('open_privacy_settings', { pane });
}

export type UpdateStatus = {
  currentVersion: string;
  /** When the last check finished, or null if none has since Eavesy started. */
  checkedAtMs: number | null;
} & (
  | { state: 'unknown' }
  | { state: 'upToDate' }
  | { state: 'available'; version: string; notes: string | null }
  | { state: 'installed'; version: string }
  | { state: 'error'; message: string }
);

export interface AppInfo {
  name: string;
  version: string;
  update: UpdateStatus;
}

export async function getAppInfo(): Promise<AppInfo | null> {
  if (!isDesktop()) return null;
  return invoke<AppInfo>('get_app_info');
}

/** Checks for an update now. The app menu's Check for Updates… shows its own dialog instead. */
export async function checkForUpdates(): Promise<UpdateStatus | null> {
  if (!isDesktop()) return null;
  return invoke<UpdateStatus>('check_for_updates');
}

/**
 * Downloads and installs the available update, then relaunches. Rejects while
 * recording; if a recording starts mid-download it resolves without relaunching
 * and the status becomes `installed`.
 */
export async function installUpdate(): Promise<void> {
  if (!isDesktop()) return;
  await invoke('install_update');
}

/** Fires whenever an update check finishes, including the background check. */
export async function onUpdateStatus(cb: (status: UpdateStatus) => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<UpdateStatus>('launcher:update-status', (event) => cb(event.payload));
}

/**
 * `dictation` also transcribes the mic on this Mac and pastes that text as soon
 * as recording stops. It still uploads like any recording; the cloud transcript
 * is its record.
 */
export async function startAudioCapture(
  source: 'mixed' | 'system' | 'mic',
  contextBlurb?: string,
  dictation = false,
  projectId?: string,
): Promise<CaptureSession | null> {
  if (!isDesktop()) {
    window.location.href = '/app/record';
    return null;
  }
  return invoke<CaptureSession>('start_capture', { source, contextBlurb, dictation, projectId });
}

/** The account's projects, or null when this Mac is not paired or is offline. */
export async function listDesktopProjects(): Promise<unknown[] | null> {
  if (!isDesktop()) return null;
  return await invoke<unknown[] | null>('list_projects');
}

/** Reads or changes account settings and projects on eavesy.com as this Mac. */
export async function accountCall<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return await invoke<T>('account_call', { method, path, body: body ?? null });
}

/** Mirrors the launcher's project choice so the dictation hotkey files recordings the same way. */
export async function setProjectChoice(choice: {
  follow: boolean;
  pinned: string | null;
  projects: { id: string; terms: string[] }[];
}): Promise<void> {
  if (!isDesktop()) return;
  await invoke('set_project_choice', { choice });
}

export interface FrontWindow {
  app: string | null;
  title: string | null;
}

/** The app and window title that were in front when the launcher opened. */
export async function frontWindow(): Promise<FrontWindow | null> {
  if (!isDesktop()) return null;
  return await invoke<FrontWindow | null>('front_window');
}

/** A recording's transcript cleaned up for an AI agent, once the cloud has made it. */
export async function fetchAgentTranscript(recordingId: string): Promise<string | null> {
  if (!isDesktop()) return null;
  return await invoke<string | null>('agent_transcript', { recordingId });
}

export async function startScreenCapture(
  mic: boolean,
): Promise<CaptureSession | null> {
  if (!isDesktop()) {
    window.location.href = '/app/record?mode=screen';
    return null;
  }
  return invoke<CaptureSession>('start_screen_capture', { mic });
}

export async function stopCapture(sessionId: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke('stop_capture', { sessionId });
}

/** Ends a capture without saving it: nothing reaches History or the cloud. */
export async function cancelCapture(sessionId: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke('cancel_capture', { sessionId });
}

export interface Settings {
  toggle_hotkey: string;
  dictation_hotkey: string;
  assistant_hotkey: string;
  device_id: string;
  setup_completed: boolean;
  recordings_root?: string | null;
  launcher_position?: LauncherPosition;
  /** Absent means on. */
  live_captions?: boolean;
  /** Copy new macOS screenshots into the history. Absent means on. */
  add_screenshots?: boolean;
  /** Absent means on. */
  capture_sounds?: boolean;
  /** Absent means off. */
  hud_preview_lines?: HudPreviewLines;
  hud_translucent?: boolean;
  /** A finished dictation opens with its words to edit. Absent means on. */
  hud_result_preview?: boolean;
  /** Live words about a second sooner from a fast recognizer. Absent means on. */
  fast_live_words?: boolean;
  /** Talk with Claude Code sessions. Absent means off. */
  agent_voice?: boolean;
  /** Seconds a finished session waits for your reply. Absent means 300. */
  agent_hold_secs?: number;
  /** Messages from agents on your Eavesy connection. Absent means off. */
  agent_messages?: boolean;
  /** Absent means the default style. */
  assistant_style?: AssistantStyle;
  /** Absent means the System Settings voice. */
  assistant_voice?: string;
  /** Words per minute. Absent means the voice's own speed. */
  assistant_voice_rate?: number;
  /** Eavesy keeps notes and sends them with your messages. Absent means on. */
  assistant_memory?: boolean;
}

export type LauncherPosition = 'top_left' | 'top_center' | 'top_right' | 'bottom_center';

export interface SetupStatus {
  paired: boolean;
  completed: boolean;
}

export async function pairDevice(): Promise<void> {
  if (!isDesktop()) return;
  await invoke('pair_device');
}

export async function cancelPairing(): Promise<void> {
  if (!isDesktop()) return;
  await invoke('cancel_pairing');
}

export interface AccountInfo { email: string | null; name: string | null }
export async function getAccountInfo(): Promise<AccountInfo | null> {
  if (!isDesktop()) return null;
  return invoke<AccountInfo | null>('account_info').catch(() => null);
}
export async function disconnectAccount(): Promise<void> {
  await invoke('disconnect_account');
}
/** Opens eavesy.com/app, or a page under it such as `/settings#projects`. */
export async function openWebApp(path?: string): Promise<void> {
  await invoke('open_web_app', path ? { path } : undefined);
}

export async function getSettings(): Promise<Settings | null> {
  if (!isDesktop()) return null;
  return invoke<Settings>('get_settings').catch(() => null);
}

export async function setLauncherPosition(position: LauncherPosition): Promise<void> {
  if (!isDesktop()) throw new Error('Position is available in the Mac app.');
  await invoke('set_launcher_position', { position });
}

export async function chooseRecordingsFolder(
  current?: string | null,
): Promise<string | null> {
  const t = tauri();
  if (!t?.dialog) return null;
  const selected = await t.dialog.open({
    directory: true,
    multiple: false,
    defaultPath: current ?? undefined,
    title: 'Choose where Eavesy saves recordings',
  });
  if (typeof selected !== 'string') return null;
  return invoke<string>('set_root_folder', { path: selected });
}

export async function getSetupStatus(): Promise<SetupStatus | null> {
  if (!isDesktop()) return null;
  return invoke<SetupStatus>('get_setup_status').catch(() => null);
}

export async function completeSetup(): Promise<void> {
  if (!isDesktop()) return;
  await invoke('complete_setup');
}

export type HotkeyAction = 'toggle' | 'dictation' | 'assistant';
/** Every shortcut; "" means unbound, "Fn" the fn / 🌐 key on its own, "Fn+Space" fn held with a key. */
export type HotkeyBindings = Record<HotkeyAction, string>;
/** Why the Mac app refused a shortcut (Rust `HotkeyError`). */
export type HotkeyError =
  | { kind: 'needsModifier' }
  | { kind: 'taken'; by: HotkeyAction | 'other' }
  | { kind: 'inputMonitoring' }
  | { kind: 'accessibility' }
  | { kind: 'invalid'; message: string };
/** A shortcut that works but that macOS, another app or most apps already use. */
export type HotkeyConflict = { kind: 'system' | 'app' | 'globe' | 'common'; name: string };
export type GlobeAction = 'do_nothing' | 'input_source' | 'emoji' | 'dictation' | 'unknown';
export interface FnStatus {
  input_monitoring: boolean;
  /** fn held with a key needs Accessibility. Missing from older Mac apps. */
  accessibility?: boolean;
  globe_action: GlobeAction;
}

export function isHotkeyError(error: unknown): error is HotkeyError {
  return !!error && typeof error === 'object' && 'kind' in error && typeof error.kind === 'string';
}

/** Rejects with a `HotkeyError`. With `swap`, trades shortcuts with the other action. */
export async function setHotkey(action: HotkeyAction, accelerator: string, swap = false): Promise<void> {
  if (!isDesktop()) return;
  await invoke('set_hotkey', { action, accelerator, swap });
}

/** Rejects with a `HotkeyError` for the modifier rule or the other action's shortcut. */
export async function checkHotkey(action: HotkeyAction, accelerator: string): Promise<HotkeyConflict | null> {
  if (!isDesktop()) return null;
  return invoke<HotkeyConflict | null>('check_hotkey', { action, accelerator });
}

/** What else uses each saved shortcut (macOS, another app, a 🌐 shortcut). Empty from older Mac apps. */
export async function checkAllHotkeys(): Promise<Partial<Record<HotkeyAction, HotkeyConflict | null>>> {
  if (!isDesktop()) return {};
  return (await invoke<Partial<Record<HotkeyAction, HotkeyConflict | null>> | null>('check_all_hotkeys').catch(() => null)) ?? {};
}

export async function getHotkeyDefaults(): Promise<HotkeyBindings> {
  const fallback = { toggle: 'Cmd+Shift+Space', dictation: 'Cmd+Shift+D', assistant: 'Alt+Shift+Space' };
  if (!isDesktop()) return fallback;
  return (await invoke<HotkeyBindings | null>('get_hotkey_defaults').catch(() => null)) ?? fallback;
}

export async function resetHotkey(action: HotkeyAction, swap = false): Promise<void> {
  if (!isDesktop()) return;
  await invoke('reset_hotkey', { action, swap });
}

export async function resetAllHotkeys(): Promise<void> {
  if (!isDesktop()) return;
  await invoke('reset_all_hotkeys');
}

export async function fnStatus(): Promise<FnStatus | null> {
  if (!isDesktop()) return null;
  return invoke<FnStatus>('fn_status').catch(() => null);
}

/** A lone fn tap while shortcuts are suspended for recording one. */
export async function onFnTap(cb: () => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<unknown>('hotkeys:fn-tap', () => cb());
}

/** fn held with a key ("Fn+Space") while recording; WebKit never reports fn itself. */
export async function onFnChord(cb: (accelerator: string) => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<string>('hotkeys:fn-chord', (event) => { if (typeof event.payload === 'string') cb(event.payload); });
}

export async function openKeyboardSettings(inputMonitoring = false): Promise<void> {
  if (!isDesktop()) return;
  await invoke('open_keyboard_settings', { inputMonitoring });
}

/**
 * Turns every shortcut off (or back on). Resolves once the Mac app has done it,
 * with whether a lone fn tap will be reported (`onFnTap`) while they're off.
 */
export async function suspendHotkeys(suspended: boolean): Promise<boolean> {
  if (!isDesktop()) return false;
  return (await invoke<boolean | null>('suspend_hotkeys', { suspended })) === true;
}

export async function setPanelPinned(pinned: boolean): Promise<void> {
  if (!isDesktop()) return;
  await invoke('set_panel_pinned', { pinned });
}

export async function onLauncherRecordings(cb: () => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<unknown>('launcher:recordings', () => cb());
}
export async function onLauncherSetup(cb: () => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<unknown>('launcher:setup', () => cb());
}
export async function captureMediaUrl(id: string): Promise<string> {
  const path = await invoke<string>('capture_media', { id });
  const core = tauri()?.core;
  if (!core?.convertFileSrc) throw new Error('Capture preview is unavailable.');
  return core.convertFileSrc(path);
}
export async function pasteClip(): Promise<void> {
  await invoke('paste_clip');
}
export async function copyCaptureMedia(id: string): Promise<void> {
  await invoke('copy_capture_media', { id });
}

export interface CaptureStatus { phase: string; sessionId: string | null; mode?: string; startedAtMs?: number; }
export async function getCaptureStatus(): Promise<CaptureStatus | null> {
  if (!isDesktop()) return null;
  return invoke<CaptureStatus>('get_hud_state');
}
export async function onCaptureState(cb: (state: CaptureStatus) => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<CaptureStatus>('capture:state', (event) => cb(event.payload));
}

/** The shortcuts were changed (Settings → Shortcuts). */
export async function onHotkeysChanged(cb: () => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen('hotkeys:changed', () => cb());
}

export async function captureScreenshot(): Promise<void> {
  await invoke('capture_screenshot');
}

export interface ImportResult { ids: string[]; skipped: string[] }

/** Files dropped or picked: images, .txt/.md notes, audio and video. */
export async function importFiles(paths: string[]): Promise<ImportResult> {
  return invoke<ImportResult>('import_files', { paths });
}

/** Opens the native file picker and imports what was chosen. Null when cancelled. */
export async function pickAndImportFiles(): Promise<ImportResult | null> {
  const dialog = tauri()?.dialog;
  if (!dialog) return null;
  const picked = await dialog.open({ directory: false, multiple: true, title: 'Add to Eavesy' });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  return paths.length ? importFiles(paths) : null;
}

export type PasteOutcome =
  | { kind: 'saved'; count: number; skipped: string[] }
  | { kind: 'text'; text: string };

/** ⌘V in the panel: files and images are saved, text comes back as a draft. */
export async function pasteToComposer(): Promise<PasteOutcome> {
  return invoke<PasteOutcome>('paste_to_composer');
}

/** Moves the capture's folder to the Trash and drops it from the history. */
export async function deleteCapture(id: string): Promise<void> {
  await invoke('delete_capture', { id });
}

export async function openRecordingsFolder(): Promise<void> {
  if (!isDesktop()) return;
  await invoke('open_recordings_folder');
}

export async function getScreenshotFolder(): Promise<string | null> {
  if (!isDesktop()) return null;
  return invoke<string>('get_screenshot_folder').catch(() => null);
}

export async function setAutoImportScreenshots(enabled: boolean): Promise<void> {
  await invoke('set_auto_import_screenshots', { enabled });
}

export async function onDragDrop(cb: (payload: DragDropPayload) => void): Promise<UnlistenFn> {
  const webview = tauri()?.webview;
  if (!webview) return () => {};
  return webview.getCurrentWebview().onDragDropEvent((event) => cb(event.payload));
}

/** Saves a typed note from the composer as a Note capture. */
export async function saveNote(text: string): Promise<void> {
  await invoke('save_note', { text });
}

export async function dictionaryRequest<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: Record<string, unknown>): Promise<T> {
  if (isDesktop()) return invoke<T>('dictionary_request', { method, body });
  const response = await fetch('/api/dictionary', { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(response.status === 409 ? 'Transcript changed. Reopen it and try again.' : 'Could not save your dictionary. Please try again.');
  return response.json();
}

export async function correctTranscript(id: string, original: string, corrected: string): Promise<{ learned: number; warning?: string }> {
  if (isDesktop()) return invoke('correct_recording', { id, original, corrected });
  return dictionaryRequest('POST', { dictationId: id, original, corrected });
}

export async function onDictionaryLearning(cb: (event: LearningEvent) => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<LearningEvent>('dictionary:learning', e => cb(e.payload));
}


/** The ordinary Copy/Paste payload for a recording, including video evidence. */
export async function recordingContext(id: string, fallback: string): Promise<string> {
  return isDesktop() ? invoke<string>('recording_context', { id }) : fallback;
}
/** A click or tag in a screen recording, from moments.rs and walkthrough processing. */
export interface RecordingMoment {
  number: number;
  kind: 'click' | 'element' | 'area';
  mark: number | null;
  timestampMs: number;
  what: string | null;
  where: string | null;
  url: string | null;
  narration: string;
  /** A displayable URL for the close-up, once processing has cut it. */
  crop: string | null;
}
export async function recordingMoments(id: string): Promise<RecordingMoment[]> {
  if (!isDesktop()) return [];
  const moments = await invoke<RecordingMoment[]>('recording_moments', { id });
  const core = tauri()?.core;
  return moments.map((moment) => ({ ...moment, crop: moment.crop && core?.convertFileSrc ? core.convertFileSrc(moment.crop) : null }));
}
export async function retryWalkthrough(id: string): Promise<void> {
  await invoke('retry_walkthrough', { id });
}
