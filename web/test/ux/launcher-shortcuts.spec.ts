import { expect, test, type Page } from '@playwright/test';

async function nativeLauncher(page: Page, completed = true, visual = false, timeline = false) {
  await page.setViewportSize({ width: 420, height: 440 });
  await page.addInitScript(({ completed, visual, timeline }) => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
    Object.assign(window, { __shortcutTest: { calls, emit: (name: string, payload: unknown = null) => {
      listeners.get(name)?.forEach((handler) => handler({ payload }));
    } } });
    window.__TAURI__ = {
      core: { convertFileSrc: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf2kAAAAASUVORK5CYII=', invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push({ command, args });
        let result: unknown = null;
        if (command === 'list_recordings') result = [{ id: 'note-1', title: 'Quick note', started_at_ms: Date.now(), status: 'complete', transcript: '# Quick note\n\n## Transcript\n\n[00:00:00] Send the revised proposal tomorrow.' }];
        if (command === 'list_recordings' && visual) result = [{ id: 'image-1', title: 'Screenshot', started_at_ms: Date.now(), source: 'screenshot', status: 'complete' }, { id: 'video-1', title: 'Screen recording', started_at_ms: Date.now() - 1000, source: 'screen', status: 'complete', has_video: true }];
        if (command === 'list_recordings' && timeline) result = Array.from({ length: 20 }, (_, index) => ({ id: `note-${index}`, title: `Note ${index}`, started_at_ms: Date.now() - index * 60000, status: 'complete', transcript: `Saved note ${index}.\nA second line of text.` }));
        if (command === 'capture_media') result = '/saved/capture.png';
        if (command === 'get_settings') result = { toggle_hotkey: 'Cmd+Shift+Space', dictation_hotkey: 'Cmd+Shift+D' };
        if (command === 'get_setup_status') result = { paired: true, completed };
        if (command === 'check_permissions') result = { mic: true, screen: true };
        if (command === 'start_capture') result = { session_id: 'shortcut-test' };
        if (command === 'live_transcript') result = [{ startMs: 0, endMs: 2000, track: null, text: 'Cloud line.', provisional: false }];
        if (command === 'suspend_hotkeys') result = args?.suspended === true;
        if (command === 'fn_status') result = { input_monitoring: true, globe_action: 'emoji' };
        return result as T;
      } },
      event: { listen: async <T,>(name: string, handler: (event: { payload: T }) => void) => {
        const set = listeners.get(name) ?? new Set();
        set.add(handler as (event: { payload: unknown }) => void); listeners.set(name, set);
        return () => { set.delete(handler as (event: { payload: unknown }) => void); };
      } },
    };
  }, { completed, visual, timeline });
  await page.goto('/launcher', { waitUntil: 'networkidle' });
}

test('tapping fn while recording a shortcut saves fn and shows what macOS still needs', async ({ page }) => {
  await nativeLauncher(page, false);
  await page.evaluate(() => (window as unknown as { __shortcutTest: { emit: (name: string) => void } }).__shortcutTest.emit('launcher:settings'));
  await page.getByRole('button', { name: /Change the Talk shortcut/ }).click();
  await expect(page.getByText('Press a shortcut, or tap fn. Esc to cancel.')).toBeVisible();
  await page.evaluate(() => (window as unknown as { __shortcutTest: { emit: (name: string) => void } }).__shortcutTest.emit('hotkeys:fn-tap'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const calls = await page.evaluate(() => (window as unknown as { __shortcutTest: { calls: { command: string; args?: Record<string, unknown> }[] } }).__shortcutTest.calls);
  expect(calls.find((call) => call.command === 'check_hotkey')?.args).toEqual({ action: 'dictation', accelerator: 'Fn' });
  expect(calls.find((call) => call.command === 'set_hotkey')?.args).toEqual({ action: 'dictation', accelerator: 'Fn', swap: false });
});

test('native dictation event starts mic capture and second press saves', async ({ page }) => {
  await nativeLauncher(page);
  const emit = () => page.evaluate(() => (window as unknown as { __shortcutTest: { emit: (name: string) => void } }).__shortcutTest.emit('launcher:dictation'));
  await emit();
  await expect(page.getByRole('button', { name: 'Stop & save' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Capture history' })).toBeVisible();
  await emit();
  await expect(page.getByRole('heading', { name: 'Capture history' })).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { __shortcutTest: { calls: { command: string; args?: Record<string, unknown> }[] } }).__shortcutTest.calls);
  expect(calls.find((call) => call.command === 'start_capture')?.args?.source).toBe('mic');
  expect(calls.find((call) => call.command === 'start_capture')?.args?.dictation).toBe(true);
  expect(calls.some((call) => call.command === 'stop_capture')).toBe(true);
});

test('live captions can be turned off, and turning them on asks for Speech Recognition', async ({ page }) => {
  await nativeLauncher(page);
  await page.evaluate(() => (window as unknown as { __shortcutTest: { emit: (name: string) => void } }).__shortcutTest.emit('launcher:settings'));
  const toggle = page.getByRole('switch', { name: 'Live captions' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const calls = await page.evaluate(() => (window as unknown as { __shortcutTest: { calls: { command: string; args?: Record<string, unknown> }[] } }).__shortcutTest.calls);
  expect(calls.filter((call) => call.command === 'set_live_captions').map((call) => call.args?.enabled)).toEqual([false, true]);
  expect(calls.some((call) => call.command === 'check_permissions' && call.args?.needSpeech === true)).toBe(true);
});

test('a recording shows its live captions, cloud lines first', async ({ page }) => {
  await nativeLauncher(page);
  await page.evaluate(() => (window as unknown as { __shortcutTest: { emit: (name: string) => void } }).__shortcutTest.emit('launcher:dictation'));
  const captions = page.getByRole('region', { name: 'Live captions' });
  await expect(captions).toContainText('Cloud line.');
  await page.evaluate(() => (window as unknown as { __shortcutTest: { emit: (name: string, payload?: unknown) => void } }).__shortcutTest.emit('recording:caption', {
    sessionId: 'shortcut-test', track: 'mic', text: 'still talking', isFinal: false, startMs: 3000, endMs: 3500,
  }));
  await expect(captions).toContainText('still talking');
});

test('recording control can open Settings and stopping clears the launcher timer', async ({ page }) => {
  await nativeLauncher(page);
  await page.evaluate(() => (window as unknown as { __shortcutTest: { emit: (name: string) => void } }).__shortcutTest.emit('launcher:dictation'));
  await expect(page.getByRole('button', { name: 'Stop & save' })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __shortcutTest: { emit: (name: string) => void } }).__shortcutTest.emit('launcher:settings'));
  await expect(page.getByRole('button', { name: 'Start dictation ⌘ ⇧ D' })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __shortcutTest: { emit: (name: string, payload: unknown) => void } }).__shortcutTest.emit('capture:state', { phase: 'saved', sessionId: 'shortcut-test' }));
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Capture history' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop & save' })).toBeHidden();
});


test('overview shows transcript cards and copies spoken text without search clutter', async ({ page }) => {
  await nativeLauncher(page);
  await expect(page.getByRole('heading', { name: 'Capture history' })).toBeVisible();
  await expect(page.getByPlaceholder('Search recordings, transcripts, commands…')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start voice note' })).toBeVisible();
  await expect(page.getByText('Send the revised proposal tomorrow.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Copy voice note' }).click();
  const calls = await page.evaluate(() => (window as unknown as { __shortcutTest: { calls: { command: string; args?: Record<string, unknown> }[] } }).__shortcutTest.calls);
  expect(calls.find((call) => call.command === 'copy_text')?.args?.text).toBe('Send the revised proposal tomorrow.');
  await page.evaluate(() => (window as unknown as { __shortcutTest: { emit: (name: string) => void } }).__shortcutTest.emit('launcher:settings'));
  await expect(page.getByRole('button', { name: 'Start dictation ⌘ ⇧ D' })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __shortcutTest: { emit: (name: string) => void } }).__shortcutTest.emit('launcher:opened'));
  await expect(page.getByRole('heading', { name: 'Capture history' })).toBeVisible();
});


test('saved screenshots and videos remain in history with media copy actions', async ({ page }) => {
  await nativeLauncher(page, true, true);
  await expect(page.getByRole('heading', { name: 'Capture history' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Captured screenshot' })).toBeVisible();
  await expect(page.getByLabel('Captured video')).toBeVisible();
  await page.getByRole('button', { name: 'Copy screenshot' }).click();
  await page.getByRole('button', { name: 'Copy video' }).click();
  const calls = await page.evaluate(() => (window as unknown as { __shortcutTest: { calls: { command: string; args?: Record<string, unknown> }[] } }).__shortcutTest.calls);
  expect(calls.filter((call) => call.command === 'copy_capture_media').map((call) => call.args?.id)).toEqual(['image-1', 'video-1']);
});


test('opening history during capture restores the live timer and capture completion returns from settings', async ({ page }) => {
  await nativeLauncher(page);
  await page.evaluate(() => (window as unknown as { __shortcutTest: { emit: (name: string, payload?: unknown) => void } }).__shortcutTest.emit('capture:state', { phase: 'recording', sessionId: 'external-note', startedAtMs: Date.now() - 78000, mode: 'audio' }));
  await expect(page.getByText(/Eavesy 01:1[89]/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Capture history' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.evaluate(() => {
    const events = (window as unknown as { __shortcutTest: { emit: (name: string, payload?: unknown) => void } }).__shortcutTest;
    events.emit('capture:state', { phase: 'saved', sessionId: 'external-note' });
    events.emit('launcher:recordings');
  });
  await expect(page.getByRole('heading', { name: 'Capture history' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start voice note' })).toBeVisible();
});


test('a capture opens the newest card after browsing older history', async ({ page }) => {
  await nativeLauncher(page, true, false, true);
  const history = page.locator('[data-capture-history]');
  await expect(history).toBeVisible();
  await history.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as { __shortcutTest: { emit: (name: string) => void } }).__shortcutTest.emit('launcher:recordings'));
  await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(0);
});
