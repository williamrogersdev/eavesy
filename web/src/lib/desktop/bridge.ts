import type { LiveCaption, LiveLine } from './live-captions';
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

export async function pasteToFrontmost(text: string): Promise<void> {
  if (isDesktop()) {
    await invoke('paste_to_frontmost', { text });
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
): Promise<CaptureSession | null> {
  if (!isDesktop()) {
    window.location.href = '/app/record';
    return null;
  }
  return invoke<CaptureSession>('start_capture', { source, contextBlurb, dictation });
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

export interface Settings {
  toggle_hotkey: string;
  dictation_hotkey: string;
  device_id: string;
  setup_completed: boolean;
  recordings_root?: string | null;
  launcher_position?: LauncherPosition;
  /** Absent means on. */
  live_captions?: boolean;
  /** Copy new macOS screenshots into the history. Absent means on. */
  add_screenshots?: boolean;
}

export type LauncherPosition = 'top_left' | 'top_center' | 'top_right';

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
export async function openWebApp(): Promise<void> {
  await invoke('open_web_app');
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

export type HotkeyAction = 'toggle' | 'dictation';
/** Both shortcuts; "" means unbound, "Fn" the fn / 🌐 key on its own. */
export type HotkeyBindings = Record<HotkeyAction, string>;
/** Why the Mac app refused a shortcut (Rust `HotkeyError`). */
export type HotkeyError =
  | { kind: 'needsModifier' }
  | { kind: 'taken'; by: HotkeyAction | 'other' }
  | { kind: 'inputMonitoring' }
  | { kind: 'invalid'; message: string };
/** A shortcut that works but that macOS or most apps already use. */
export type HotkeyConflict = { kind: 'system'; name: string } | { kind: 'common'; name: string };
export type GlobeAction = 'do_nothing' | 'input_source' | 'emoji' | 'dictation' | 'unknown';
export interface FnStatus {
  input_monitoring: boolean;
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

export async function getHotkeyDefaults(): Promise<HotkeyBindings> {
  const fallback = { toggle: 'Cmd+Shift+Space', dictation: 'Cmd+Shift+D' };
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
export async function onLauncherSettings(cb: () => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<unknown>('launcher:settings', () => cb());
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
