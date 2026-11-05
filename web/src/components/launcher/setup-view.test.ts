import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Permissions } from '@/lib/desktop/bridge';
import { PermissionChecklist } from './permission-checklist';
import { STEPS } from './setup-view';

const none: Permissions = { mic: true, screen: false, accessibility: false, speech: false, inputMonitoring: false, notifications: false };
const speechRow = (speechRequired: boolean) => {
  const html = renderToStaticMarkup(
    createElement(PermissionChecklist, {
      permissions: none, checking: null, fnInUse: false, speechRequired, only: ['speech'],
      onRequest: async () => true, onOpenSettings: () => {}, onRelaunch: () => {},
    }),
  );
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
};

describe('PermissionChecklist in setup', () => {
  test('signed out, Speech Recognition shows as required with the no-account hint', () => {
    expect(speechRow(true)).toContain('required');
    expect(speechRow(true)).toContain('without an account');
  });
  test('signed in, Speech Recognition is untagged with the captions hint', () => {
    expect(speechRow(false)).not.toContain('required');
    expect(speechRow(false)).toContain('live captions');
  });
});

describe('setup steps', () => {
  test('match the analytics names in SETUP_STEPS (desktop/src-tauri/src/commands.rs), in order', () => {
    const rust = readFileSync(new URL('../../../../desktop/src-tauri/src/commands.rs', import.meta.url), 'utf8');
    const list = /const SETUP_STEPS: \[&str; \d+\] = \[([^\]]*)\]/.exec(rust)?.[1];
    expect(list).toBeDefined();
    const names = [...(list ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(STEPS.map((label) => label.toLowerCase().replace(/ /g, '_')));
  });
});
