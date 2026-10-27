// How long a finished dictation's drawer stays, and translating it from there.
// Install web/ and desktop/launcher-ui dependencies and Playwright Chromium.
// Start the launcher dev server (default 127.0.0.1:1420), then run this script.
// Set EAVESY_HUD_URL to test a different preview server.
import { createRequire } from 'node:module';
const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium } = requireWeb('@playwright/test');
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const original = 'Send the deck to Sam before Thursday.';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 176 } });
  page.setDefaultTimeout(5000);
  await page.clock.install();
  await page.addInitScript((original) => {
    const listeners = new Map();
    const state = { phase: 'done', sessionId: 'qa-1', mode: 'audio', message: original, notice: null, startedAtMs: null, receipt: 'pasted', opensItself: true };
    Object.assign(window, { __qaTranslations: [], __qaReplaced: [], __qaSaves: [], __qaFocus: [] });
    window.__TAURI__ = {
      core: { invoke: async (cmd, args) => {
        if (cmd === 'get_hud_state') return state;
        if (cmd === 'get_settings') return { dictation_hotkey: 'Fn' };
        if (cmd === 'live_transcript') return [];
        if (cmd === 'translation_request') {
          window.__qaTranslations.push(args.body);
          if (window.__qaFailTranslation) throw 'Sign in to translate.';
          return { text: args.body.text, translation: `[${args.body.target}] ${args.body.text}`, target: args.body.target };
        }
        if (cmd === 'replace_dictation') { window.__qaReplaced.push(args); return 'replaced'; }
        if (cmd === 'save_preview_transcript') window.__qaSaves.push(args);
        if (cmd === 'focus_preview_editor') { window.__qaFocus.push(args.sessionId); return 0; }
        if (cmd === 'dismiss_hud') (listeners.get('hud:state') ?? []).forEach((fn) => fn({ payload: { ...state, phase: 'idle', message: null } }));
      } },
      event: { listen: async (event, fn) => { const list = listeners.get(event) ?? []; list.push(fn); listeners.set(event, list); return () => listeners.set(event, list.filter((f) => f !== fn)); } },
    };
  }, original);
  const open = async () => {
    await page.goto(process.env.EAVESY_HUD_URL ?? 'http://127.0.0.1:1420/hud.html');
    await page.locator('[data-size="result"]').waitFor();
  };
  const editor = page.getByRole('textbox', { name: 'Edit transcript preview' });
  const translate = page.locator('.ctl-translate');
  const search = page.getByRole('combobox', { name: 'Search languages' });

  await open();
  assert.equal(await page.getByText('Sets your default').count(), 0);
  await translate.waitFor();
  console.log('PASS: the tone row ends in Translate, without the "Sets your default" note');

  await page.clock.runFor(25_000);
  assert.equal(await page.locator('[data-size="result"]').count(), 1);
  await page.clock.runFor(6_000);
  await page.locator('[data-phase="idle"]').waitFor();
  console.log('PASS: a finished dictation stays open long enough to read, then goes back to the pill');

  await open();
  await page.locator('.eavesy-control').hover();
  await page.mouse.move(399, 175);
  await page.mouse.move(-1, -1);
  await page.clock.runFor(8_000);
  assert.equal(await page.locator('[data-size="result"]').count(), 1);
  await page.clock.runFor(2_100);
  await page.locator('[data-phase="idle"]').waitFor();
  console.log('PASS: the drawer does not vanish the moment the pointer leaves it, and still goes after 10s');

  await open();
  await translate.click();
  await search.waitFor();
  assert.ok(await search.evaluate((el) => el === document.activeElement));
  assert.deepEqual(await page.evaluate(() => window.__qaFocus), ['qa-1']);
  await page.clock.runFor(60_000);
  assert.equal(await search.count(), 1);
  console.log('PASS: Translate opens a language search that has the keyboard and holds the drawer open');

  await search.press('Escape');
  await editor.waitFor();
  assert.equal(await page.locator('[data-size="result"]').count(), 1);
  console.log('PASS: Esc in the search closes it, not the drawer');

  await translate.click();
  await search.fill('spa');
  assert.equal(await page.getByRole('option').first().getAttribute('id'), await page.getByRole('option', { name: 'Spanish', exact: true }).getAttribute('id'));
  await search.press('Enter');
  await page.waitForFunction((text) => document.querySelector('textarea')?.value === text, `[es] ${original}`);
  assert.deepEqual(await page.evaluate(() => window.__qaTranslations.at(-1)), { text: original, source: 'auto', target: 'es' });
  assert.deepEqual(await page.evaluate(() => window.__qaReplaced.at(-1)), { sessionId: 'qa-1', text: `[es] ${original}` });
  await page.waitForFunction(() => window.__qaSaves.length > 0);
  assert.equal(await page.evaluate(() => window.__qaSaves.at(-1).learn), false);
  assert.equal(await translate.textContent(), 'Spanish');
  await page.locator('.ctl-stamp', { hasText: 'Spanish' }).waitFor();
  console.log('PASS: searching and pressing Enter translates the words, puts them in place, and never teaches the dictionary');

  await translate.click();
  const options = await page.getByRole('option').allTextContents();
  assert.deepEqual(options.slice(0, 2), ['Original', 'Spanish']);
  await page.getByRole('option', { name: 'English' }).click();
  await page.waitForFunction((text) => document.querySelector('textarea')?.value === text, `[en] ${original}`);
  // Each language starts from the words before any translation: they never compound.
  assert.equal(await page.evaluate(() => window.__qaTranslations.at(-1).text), original);
  await translate.click();
  assert.deepEqual((await page.getByRole('option').allTextContents()).slice(0, 3), ['Original', 'English', 'Spanish']);
  const asked = await page.evaluate(() => window.__qaTranslations.length);
  await page.getByRole('option', { name: 'Original' }).click();
  await page.waitForFunction((text) => document.querySelector('textarea')?.value === text, original);
  assert.equal(await page.evaluate(() => window.__qaTranslations.length), asked);
  console.log('PASS: recent languages lead the list, so going back and forth is one click, and Original needs no server');

  await page.evaluate(() => { window.__qaFailTranslation = true; });
  await translate.click();
  await search.fill('french');
  await search.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Sign in to translate.' }).waitFor();
  assert.equal(await editor.inputValue(), original);
  assert.equal(await translate.textContent(), 'Translate');
  console.log('PASS: a failed translation says why and leaves the words as they were');

  await page.screenshot({ path: join(tmpdir(), 'eavesy-hud-translate-verified.png') });
} finally { await browser.close(); }
