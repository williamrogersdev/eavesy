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
      multiple: false;
      defaultPath?: string;
      title?: string;
    }): Promise<string | string[] | null>;
  };
}

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

export async function onDictationHotkey(cb: () => void): Promise<UnlistenFn> {
  const t = tauri();
  if (!t) return () => {};
  return t.event.listen<unknown>('launcher:dictation', () => cb());
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

export interface Permissions {
  mic: boolean;
  micAsked?: boolean;
  screen: boolean;
  accessibility?: boolean;
  /** Speech Recognition, for live captions and the instant dictation paste. */
  speech?: boolean;
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

export interface CliStatus {
  /** The app bundles the CLI (false in dev builds without the sidecar). */
  available: boolean;
  /** ~/.local/bin/eavesy links to this app's CLI. */
  installed: boolean;
  /** Something else is at the link path; Eavesy leaves it alone. */
  conflict: boolean;
  link_path: string;
}

export async function getCliStatus(): Promise<CliStatus | null> {
  if (!isDesktop()) return null;
  return invoke<CliStatus>('cli_status');
}

export async function setCliInstalled(enabled: boolean): Promise<CliStatus> {
  return invoke<CliStatus>('set_cli_installed', { enabled });
}

export type PrivacyPane = 'microphone' | 'screen' | 'accessibility' | 'speech';
export async function openPrivacySettings(pane: PrivacyPane): Promise<void> {
  if (!isDesktop()) return;
  await invoke('open_privacy_settings', { pane });
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

export async function setHotkey(
  action: 'toggle' | 'dictation',
  accelerator: string,
): Promise<void> {
  if (!isDesktop()) return;
  await invoke('set_hotkey', { action, accelerator });
}

export async function hotkeyConflict(accelerator: string): Promise<{ title: string; detail: string } | null> {
  if (!isDesktop()) return null;
  return invoke('hotkey_conflict', { accelerator });
}
export async function openKeyboardSettings(inputMonitoring = false): Promise<void> {
  if (!isDesktop()) return;
  await invoke('open_keyboard_settings', { inputMonitoring });
}

export async function suspendHotkeys(suspended: boolean): Promise<void> {
  if (!isDesktop()) return;
  await invoke('suspend_hotkeys', { suspended });
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
