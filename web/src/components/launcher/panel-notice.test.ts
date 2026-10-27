import { describe, expect, test } from 'bun:test';
import type { Permissions } from '@/lib/desktop/bridge';
import { captureNeeds, deniedNotice, MIC_OFF, noticeResolved, SCREEN_OFF, screenshotNotice, startFailureNotice } from './panel-notice';

const perms = (over: Partial<Permissions> = {}): Permissions => ({ mic: true, screen: true, ...over });

describe('what a capture needs', () => {
  test('Talk is mic only, Meeting is mic and screen, Video adds the mic when asked', () => {
    expect(captureNeeds('audio', 'mic', false)).toEqual({ mic: true, screen: false });
    expect(captureNeeds('audio', 'mixed', false)).toEqual({ mic: true, screen: true });
    expect(captureNeeds('audio', 'system', false)).toEqual({ mic: false, screen: true });
    expect(captureNeeds('screen', 'mixed', true)).toEqual({ mic: true, screen: true });
    expect(captureNeeds('screen', 'mixed', false)).toEqual({ mic: false, screen: true });
  });
});

describe('permission notices', () => {
  test('use the DESIGN copy and open the right pane', () => {
    expect(MIC_OFF).toEqual({ text: 'Couldn’t start recording: microphone access is off.', action: 'Open Microphone settings', pane: 'microphone', until: 'mic' });
    expect(SCREEN_OFF.text).toBe('Couldn’t start recording: Screen Recording access is off.');
    expect(SCREEN_OFF.action).toBe('Open settings');
    expect(SCREEN_OFF.pane).toBe('screen');
  });
  test('the mic is named first, and nothing shows when all is on or unknown', () => {
    const meeting = captureNeeds('audio', 'mixed', false);
    expect(deniedNotice(meeting, perms({ mic: false, screen: false }))).toBe(MIC_OFF);
    expect(deniedNotice(meeting, perms({ screen: false }))).toBe(SCREEN_OFF);
    expect(deniedNotice(captureNeeds('audio', 'mic', false), perms({ screen: false }))).toBeNull();
    expect(deniedNotice(meeting, perms())).toBeNull();
    expect(deniedNotice(meeting, null)).toBeNull();
  });
  test('clear themselves once the permission reads granted', () => {
    expect(noticeResolved(SCREEN_OFF, perms({ screen: false }))).toBe(false);
    expect(noticeResolved(SCREEN_OFF, perms())).toBe(true);
    expect(noticeResolved(startFailureNotice('busy'), perms())).toBe(false);
    expect(noticeResolved(null, perms())).toBe(false);
  });
});

describe('failure notices', () => {
  test('say why and offer to try again', () => {
    expect(startFailureNotice('The microphone is in use by another app.')).toEqual({ text: 'Couldn’t start recording: The microphone is in use by another app.', action: 'Try again' });
    expect(startFailureNotice('')).toEqual({ text: 'Couldn’t start recording.', action: 'Try again' });
  });
  test('a screenshot names Screen Recording when that is what is off', () => {
    expect(screenshotNotice('failed', perms({ screen: false }))).toMatchObject({ text: 'Screenshot didn’t work: Screen Recording access is off.', action: 'Open settings', pane: 'screen' });
    expect(screenshotNotice('No display', perms())).toEqual({ text: 'Screenshot didn’t work: No display.', action: 'Try again' });
  });
  test('a cancelled screenshot is not an error', () => {
    expect(screenshotNotice('Screenshot cancelled', perms())).toBeNull();
  });
});
