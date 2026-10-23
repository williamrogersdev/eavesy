import type { Permissions, PrivacyPane } from '@/lib/desktop/bridge';

/**
 * A warn line above the history with the one button that fixes it (DESIGN.md
 * §2: what happened, why, and one fix). It stays until the fix lands, the next
 * capture starts, or the panel opens again; toasts are for confirmations.
 */
export interface PanelNotice {
  text: string;
  action: string;
  /** Opens this System Settings pane; without one, the action tries again. */
  pane?: PrivacyPane;
  /** The notice goes away by itself once this permission reads granted. */
  until?: 'mic' | 'screen';
}

/** What a capture needs: Talk and Meeting use the mic, Meeting and Video the screen. */
export function captureNeeds(mode: 'audio' | 'screen', source: 'mixed' | 'system' | 'mic', withMic: boolean): { mic: boolean; screen: boolean } {
  return {
    mic: mode === 'screen' ? withMic : source !== 'system',
    screen: mode === 'screen' || source !== 'mic',
  };
}

export const MIC_OFF: PanelNotice = {
  text: 'Couldn’t start recording: microphone access is off.',
  action: 'Open Microphone settings',
  pane: 'microphone',
  until: 'mic',
};

export const SCREEN_OFF: PanelNotice = {
  text: 'Couldn’t start recording: Screen Recording access is off.',
  action: 'Open settings',
  pane: 'screen',
  until: 'screen',
};

/** The notice for a capture macOS won't allow yet, or null when everything it needs is on. */
export function deniedNotice(needs: { mic: boolean; screen: boolean }, permissions: Permissions | null): PanelNotice | null {
  if (!permissions) return null;
  if (needs.mic && !permissions.mic) return MIC_OFF;
  if (needs.screen && !permissions.screen) return SCREEN_OFF;
  return null;
}

/** Says why without ending on two full stops. */
function because(lead: string, reason: string): string {
  const why = reason.trim().replace(/[.。]+$/, '');
  return why ? `${lead}: ${why}.` : `${lead}.`;
}

export function startFailureNotice(reason: string): PanelNotice {
  return { text: because('Couldn’t start recording', reason), action: 'Try again' };
}

export function stopFailureNotice(reason: string): PanelNotice {
  return { text: because('Couldn’t save the recording', reason), action: 'Try again' };
}

/** A screenshot that failed. Null when it was cancelled, which isn't a failure. */
export function screenshotNotice(reason: string, permissions: Permissions | null): PanelNotice | null {
  if (/cancel/i.test(reason)) return null;
  if (permissions && permissions.screen === false) {
    return { text: 'Screenshot didn’t work: Screen Recording access is off.', action: 'Open settings', pane: 'screen', until: 'screen' };
  }
  return { text: because('Screenshot didn’t work', reason), action: 'Try again' };
}

/** Whether the permission a notice waits for has been turned on. */
export function noticeResolved(notice: PanelNotice | null, permissions: Permissions | null): boolean {
  if (!notice?.until || !permissions) return false;
  return permissions[notice.until] === true;
}
