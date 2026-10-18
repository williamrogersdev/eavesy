import { describe, expect, test } from 'bun:test';
import type { PermissionStatus, Permissions } from '@/lib/desktop/bridge';
import { answered, permissionRowState, permissionSpecs, usesFnKey } from './permission-checklist';

function perms(over: Partial<Permissions> = {}, status: Partial<Record<keyof NonNullable<Permissions['status']>, PermissionStatus>> = {}): Permissions {
  return {
    mic: false,
    screen: false,
    accessibility: false,
    speech: false,
    inputMonitoring: false,
    notifications: false,
    ...over,
    status: {
      mic: 'notDetermined',
      speech: 'notDetermined',
      screen: 'notGranted',
      accessibility: 'notGranted',
      inputMonitoring: 'notDetermined',
      notifications: 'notDetermined',
      ...status,
    },
  };
}

const row = (args: Partial<Parameters<typeof permissionRowState>[0]> & { kind: Parameters<typeof permissionRowState>[0]['kind'] }) =>
  permissionRowState({ permissions: perms(), relaunch: false, checking: false, asked: false, grantedAtStart: false, ...args });

describe('usesFnKey', () => {
  test('matches fn in any case, among several shortcuts', () => {
    expect(usesFnKey('⌘⇧Space', 'Fn')).toBe(true);
    expect(usesFnKey('fn')).toBe(true);
    expect(usesFnKey('⌘⇧D', '⌘⇧Space')).toBe(false);
  });
});

describe('permissionSpecs', () => {
  test('Input Monitoring is not needed unless fn is a shortcut', () => {
    expect(permissionSpecs(false).find((s) => s.kind === 'inputMonitoring')?.need).toBe('not-needed');
    expect(permissionSpecs(true).find((s) => s.kind === 'inputMonitoring')?.need).toBe('recommended');
  });
});

describe('answered', () => {
  test('denied and restricted count as answered; notDetermined does not', () => {
    expect(answered(perms({}, { speech: 'denied' }), 'speech')).toBe(true);
    expect(answered(perms({}, { notifications: 'restricted' }), 'notifications')).toBe(true);
    expect(answered(perms(), 'speech')).toBe(false);
  });
  test('Screen Recording and Accessibility never look answered from status alone', () => {
    expect(answered(perms(), 'screen')).toBe(false);
    expect(answered(perms(), 'accessibility')).toBe(false);
  });
  test('falls back to micAsked when there is no status', () => {
    expect(answered({ mic: false, screen: false, micAsked: true }, 'mic')).toBe(true);
    expect(answered({ mic: false, screen: false }, 'mic')).toBe(false);
  });
});

describe('permissionRowState', () => {
  test('a fresh row offers Allow', () => {
    expect(row({ kind: 'accessibility' })).toMatchObject({ disc: 'pending', inSettings: false, showRelaunch: false });
  });
  test('a denial switches to Open Settings', () => {
    expect(row({ kind: 'mic', permissions: perms({}, { mic: 'denied' }) })).toMatchObject({ disc: 'denied', inSettings: true });
  });
  test('asking once moves rows that cannot report a denial to Open Settings', () => {
    expect(row({ kind: 'screen', asked: true })).toMatchObject({ disc: 'pending', inSettings: true });
  });
  test('checking wins over every other disc', () => {
    expect(row({ kind: 'mic', checking: true, permissions: perms({ mic: true }) }).disc).toBe('checking');
  });
  test('Reopen shows only for relaunch kinds turned on in this panel', () => {
    const on = perms({ inputMonitoring: true }, { inputMonitoring: 'granted' });
    expect(row({ kind: 'inputMonitoring', relaunch: true, permissions: on, grantedAtStart: false }).showRelaunch).toBe(true);
    expect(row({ kind: 'inputMonitoring', relaunch: true, permissions: on, grantedAtStart: true }).showRelaunch).toBe(false);
    expect(row({ kind: 'mic', relaunch: false, permissions: perms({ mic: true }), grantedAtStart: false }).showRelaunch).toBe(false);
  });
  test('Reopen also shows after asking for a relaunch kind that is still off', () => {
    expect(row({ kind: 'screen', relaunch: true, asked: true }).showRelaunch).toBe(true);
  });
  test('without permissions yet, nothing is granted or denied', () => {
    expect(row({ kind: 'mic', permissions: null, grantedAtStart: undefined })).toMatchObject({ granted: undefined, disc: 'pending', inSettings: false });
  });
});
