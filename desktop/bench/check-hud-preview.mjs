// Install web/ and desktop/launcher-ui dependencies and Playwright Chromium.
// Start the launcher dev server (default 127.0.0.1:1420), then run this script.
// Set EAVESY_HUD_URL to test a different preview server.
import { createRequire } from 'node:module';
const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium } = requireWeb('@playwright/test');
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:400,height:176}});
  page.setDefaultTimeout(5000);
  await page.clock.install();
  await page.addInitScript(() => {
    const listeners = new Map();
    let state = {phase:'done',sessionId:'qa-1',mode:'audio',message:localStorage.getItem('qa-transcript') ?? 'Original first sentence. Original last sentence.',notice:null,startedAtMs:null};
    window.__qaCaption = (caption) => (listeners.get('recording:caption')??[]).forEach(fn=>fn({payload:caption}));
    window.__qaCopies=[];
    window.__qaSaves=[];
    window.__qaFocusRequests=[];
    window.__qaLiveEdits=[];
    window.__qaFailSave=false;
    // As hud::shown sends it: Rust's receipt, and whether it opens by itself.
    const shown = (s) => { const words=s.phase==='done'&&s.mode==='audio'&&!!s.message?.trim(); const receipt=!words?null:s.notice?.includes('Accessibility')?'blocked':s.notice?'copied':'pasted'; return {...s,receipt,opensItself:localStorage.getItem('qa-preview')==='on'&&!!s.sessionId&&(receipt==='pasted'||receipt==='copied')}; };
    window.__qaEmit = (next) => { state=next; (listeners.get('hud:state')??[]).forEach(fn=>fn({payload:shown(state)})); };
    window.__TAURI__ = {
      core:{invoke:async (cmd,args) => {
        if(cmd==='save_preview_transcript') {
          if(window.__qaBlockNextSave) { window.__qaBlockNextSave=false; await new Promise(resolve=>{window.__qaResolveSave=resolve;}); }
          if(window.__qaFailSave) throw new Error('Test disk write failed');
          window.__qaSaves.push(args);
          localStorage.setItem('qa-transcript',args.text);
          state={...state,message:args.text};
        }
        if(cmd==='restyle_dictation') {
          (window.__qaRestyles ??= []).push(args);
          if(window.__qaBlockRestyle) { window.__qaBlockRestyle=false; await new Promise(resolve=>{window.__qaResolveRestyle=resolve;}); }
          if(window.__qaFailRestyle) throw "Couldn't rewrite it in that tone";
          return `${args.forAgents ? 'Prompt' : args.style}: ${args.text}`;
        }
        if(cmd==='replace_dictation') { (window.__qaReplaced ??= []).push(args); return window.__qaReplaceAs ?? 'replaced'; }
        if(cmd==='release_preview_editor') (window.__qaReleases ??= []).push(args.sessionId);
        if(cmd==='update_live_preview_edit') { window.__qaLiveEdits.push(args); if(window.__qaFailLiveEdit) throw new Error('Test live edit failed'); }
        // Rust's raw text when something else already stopped the capture.
        if(cmd==='stop_capture') { if(window.__qaFailStop) throw window.__qaFailStop; window.__qaEmit({...state,phase:'transcribing'}); }
        if(cmd==='focus_preview_editor') { window.__qaFocusRequests.push(args.sessionId); if(window.__qaFailFocusCount>0) { window.__qaFailFocusCount--; throw new Error('Test focus unavailable'); } if(window.__qaBlockFocus) { window.__qaBlockFocus=false; await new Promise(resolve=>{window.__qaResolveFocus=resolve;}); } return window.__qaFocusRevision ?? 0; }
        if(cmd==='get_hud_state') return shown(state);
        // Four lines (not the shipped Off) so the live-word checks have a transcript box to drive.
        if(cmd==='get_settings') { window.__qaSettingsReads=(window.__qaSettingsReads??0)+1; return {dictation_hotkey:'Fn',hud_preview_lines:4}; }
        if(cmd==='live_transcript') return [];
        if(cmd==='copy_text') window.__qaCopies.push(args.text);
        if(cmd==='dismiss_hud') window.__qaEmit({...state,phase:'idle',message:null});
      }},
      event:{listen:async (event,fn) => { const list=listeners.get(event)??[];list.push(fn);listeners.set(event,list);return ()=>listeners.set(event,list.filter(f=>f!==fn)); }}
    };
  });
  await page.goto(process.env.EAVESY_HUD_URL ?? 'http://127.0.0.1:1420/hud.html');
  const editor=page.getByRole('textbox',{name:'Edit transcript preview'});
  // Resting the pointer on a finished dictation's receipt opens its drawer.
  const openDrawer = async () => {
    await page.locator('[data-size="receipt"]').waitFor();
    await page.mouse.move(1, 1);
    await page.locator('.eavesy-control').hover();
    await page.clock.runFor(300);
    await editor.waitFor();
  };
  // By default a finished dictation opens straight into its drawer, words and tones showing.
  await page.evaluate(() => localStorage.setItem('qa-preview','on'));
  await page.reload();
  await page.locator('[data-size="result"]').waitFor();
  await editor.waitFor();
  await page.locator('.ctl-tone', { hasText: 'Friendly' }).waitFor();
  await page.getByText('Pasted').waitFor();
  console.log('PASS: with the words shown after dictation, the drawer opens by itself');
  // Collapsing it ends the result: the phase leaves done, so it can't reopen by itself.
  await page.getByRole('button',{name:'Collapse to the pill'}).click();
  await page.locator('[data-phase="idle"]').waitFor();
  await page.clock.runFor(1_000);
  assert.equal(await page.locator('[data-size="result"]').count(),0);
  console.log('PASS: collapsing a drawer that opened by itself leaves it closed');
  await page.evaluate(() => localStorage.removeItem('qa-preview'));
  await page.reload();
  await page.getByText('Pasted').waitFor();
  assert.equal(await editor.count(),0);
  await page.clock.runFor(1_601);
  await page.locator('[data-phase="idle"]').waitFor();
  console.log('PASS: a pasted dictation shows its receipt, then returns to the pill');
  await page.reload();
  await openDrawer();
  const original = 'Original first sentence. Original last sentence.';
  const tone = (name) => page.locator('.ctl-tone', { hasText: name });
  await tone('Friendly').click();
  await page.waitForFunction(() => document.querySelector('textarea')?.value === 'friendly: Original first sentence. Original last sentence.');
  assert.deepEqual(await page.evaluate(() => window.__qaRestyles.at(-1)), { sessionId: 'qa-1', text: original, style: 'friendly', forAgents: false });
  assert.equal(await page.evaluate(() => window.__qaReplaced.at(-1).text), 'friendly: ' + original);
  assert.equal(await page.evaluate(() => window.__qaSaves.at(-1).learn), false);
  await page.getByText('Updated').waitFor();
  await page.locator('.ctl-tone', { hasText: 'For AI' }).click();
  await page.waitForFunction(() => window.__qaRestyles.length === 2);
  // Tones start from the words as pasted: they don't compound.
  assert.deepEqual(await page.evaluate(() => window.__qaRestyles.at(-1)), { sessionId: 'qa-1', text: original, style: 'friendly', forAgents: true });
  await page.evaluate(() => { window.__qaReplaceAs = 'copied'; });
  await tone('Concise').click();
  await page.getByText('⌘V to paste').waitFor();
  await page.evaluate(() => { window.__qaReplaceAs = 'replaced'; });
  await page.locator('.ctl-tone', { hasText: 'For AI' }).click();
  await page.waitForFunction(() => window.__qaRestyles.length === 4);
  await tone('Original').click();
  await page.waitForFunction(text => document.querySelector('textarea')?.value === text, original);
  assert.equal(await page.evaluate(() => window.__qaRestyles.length), 4);
  assert.equal(await page.evaluate(() => window.__qaSaves.at(-1).text), original);
  console.log('PASS: tone buttons rewrite from the pasted words, put the rewrite in place or copy it, and never teach the dictionary');
  assert.ok((await page.evaluate(() => window.__qaReleases ?? [])).includes('qa-1'));
  console.log('PASS: a tone click hands the keyboard back to the app before the rewrite goes in');
  await page.reload();
  await openDrawer();
  // Hovering doesn't read the settings file: it's read once at start (twice
  // here, as StrictMode mounts effects twice in the dev server).
  assert.ok(await page.evaluate(() => window.__qaSettingsReads) <= 2);
  console.log('PASS: hovering the control does not read settings');
  await page.evaluate(() => { window.__qaFailRestyle = true; });
  await tone('Professional').click();
  await page.getByRole('alert').filter({ hasText: "Couldn't rewrite it in that tone" }).waitFor();
  // The error sits in the stamp slot: the words, Copy, – and the tones all stay.
  await page.getByRole('button', { name: 'Copy', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Collapse to the pill' }).waitFor();
  assert.equal(await page.locator('.ctl-tone').count(), 5);
  assert.equal(await tone('Original').getAttribute('aria-pressed'), 'true');
  assert.equal(await editor.inputValue(), original);
  await page.evaluate(() => { window.__qaFailRestyle = false; });
  await tone('Concise').click();
  await page.getByText('Updated').waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  console.log('PASS: a failed rewrite keeps the drawer and its controls, and the next tone click clears the error');
  await page.evaluate(() => { window.__qaBlockRestyle = true; window.__qaReplaced = []; });
  await tone('Friendly').click();
  await page.waitForFunction(() => !!window.__qaResolveRestyle);
  await page.getByText('Rewriting').waitFor();
  await page.getByRole('button', { name: 'Collapse to the pill' }).click();
  await page.locator('[data-phase="idle"]').waitFor();
  await page.evaluate(() => window.__qaResolveRestyle());
  await page.clock.runFor(1_000);
  assert.equal(await page.evaluate(() => window.__qaReplaced.length), 0);
  console.log('PASS: collapsing while it rewrites drops the rewrite: nothing is replaced in the app');
  await page.reload();
  await openDrawer();
  await editor.click();
  await page.evaluate(() => { window.__qaReleases = []; });
  await editor.press('Escape');
  await page.clock.runFor(50);
  assert.deepEqual(await page.evaluate(() => window.__qaReleases), ['qa-1']);
  await editor.waitFor();
  console.log('PASS: Esc in the drawer leaves the editor and hands the keyboard back');
  // The rewrites above were saved as the transcript: start the next checks from the original.
  await page.evaluate(() => localStorage.removeItem('qa-transcript'));
  await page.reload();
  await openDrawer();
  const unfocusedBox = await editor.boundingBox();
  const unfocusedPadding = await editor.evaluate(el => getComputedStyle(el).paddingLeft);
  await editor.click();
  assert.deepEqual(await editor.boundingBox(), unfocusedBox);
  assert.equal(await editor.evaluate(el => getComputedStyle(el).paddingLeft), unfocusedPadding);
  assert.ok((await page.evaluate(()=>window.__qaFocusRequests)).includes('qa-1'));
  await editor.press('Home');
  await editor.press('Shift+End');
  await page.keyboard.insertText('Replacement sentence.');
  assert.equal(await editor.inputValue(),'Replacement sentence.');
  await editor.press('ControlOrMeta+z');
  assert.equal(await editor.inputValue(),'Original first sentence. Original last sentence.');
  await editor.press('ControlOrMeta+a');
  await page.keyboard.type('A new first line.');
  await editor.press('Enter');
  await page.keyboard.type('A new second line.');
  assert.equal(await editor.inputValue(),'A new first line.\nA new second line.');
  console.log('PASS: focus preserves geometry, opts into native editing, and supports selection, undo and multiline typing');
  await editor.fill('');
  assert.equal(await editor.count(),1);
  await editor.fill('Corrected first sentence.\nCorrected final sentence.');
  await editor.press('Home');
  await editor.press('ArrowRight');
  await editor.press('Shift+ArrowRight');
  const selection = await editor.evaluate(el => [el.selectionStart, el.selectionEnd]);
  await page.clock.runFor(60_000);
  assert.equal(await editor.inputValue(),'Corrected first sentence.\nCorrected final sentence.');
  assert.deepEqual(await editor.evaluate(el => [el.selectionStart, el.selectionEnd]), selection);
  console.log('PASS: editing keeps the preview open; deleting all text keeps the editor');
  await page.evaluate(() => window.__qaEmit({phase:'done',sessionId:'qa-1',mode:'audio',message:'Late cloud transcript',notice:null,startedAtMs:null}));
  assert.equal(await editor.inputValue(),'Corrected first sentence.\nCorrected final sentence.');
  assert.deepEqual(await editor.evaluate(el => [el.selectionStart, el.selectionEnd]), selection);
  await page.getByRole('button',{name:'Copy',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.__qaCopies),['Corrected first sentence.\nCorrected final sentence.']);
  console.log('PASS: late transcript updates preserve edits; Copy uses corrected text');
  await page.screenshot({path:join(tmpdir(),'eavesy-editable-preview-verified.png')});
  await page.clock.runFor(14_000);
  assert.equal(await editor.count(),1);
  await page.clock.runFor(1_101);
  assert.equal(await editor.count(),1);
  await page.getByRole('button',{name:'Collapse to the pill'}).click();
  await page.locator('[data-phase="idle"]').waitFor();
  console.log('PASS: an edited preview stays open after blur until explicitly dismissed');
  assert.equal(await page.evaluate(()=>localStorage.getItem('qa-transcript')),'Corrected first sentence.\nCorrected final sentence.');
  await page.reload();
  await openDrawer();
  assert.equal(await editor.inputValue(),'Corrected first sentence.\nCorrected final sentence.');
  console.log('PASS: corrected transcript survives collapse and reload');
  await page.evaluate(()=>{window.__qaFailSave=true;});
  await editor.fill('Correction that must survive a failed save');
  await editor.blur();
  await page.getByRole('button',{name:'Retry save'}).waitFor();
  await page.clock.runFor(60_000);
  assert.equal(await editor.inputValue(),'Correction that must survive a failed save');
  await page.evaluate(()=>{window.__qaFailSave=false;});
  await page.getByRole('button',{name:'Retry save'}).click();
  await page.getByRole('status').waitFor();
  await page.clock.runFor(15_001);
  assert.equal(await editor.count(),1);
  await page.getByRole('button',{name:'Collapse to the pill'}).click();
  await page.locator('[data-phase="idle"]').waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('qa-transcript')),'Correction that must survive a failed save');
  console.log('PASS: save failures keep edits visible and block collapse until retry succeeds');
  await page.reload();
  await openDrawer();
  await editor.fill('Edit before the next recording');
  await page.evaluate(() => window.__qaEmit({phase:'recording',sessionId:'qa-2',mode:'audio',message:null,notice:null,startedAtMs:Date.now()}));
  await page.locator('[data-phase="recording"]').waitFor();
  await page.evaluate(() => window.__qaEmit({phase:'done',sessionId:'qa-2',mode:'audio',message:'New recording text',notice:null,startedAtMs:null}));
  await openDrawer();
  assert.equal(await editor.inputValue(),'New recording text');
  await page.clock.runFor(400);
  await page.waitForFunction(()=>window.__qaSaves.some(edit=>edit.text==='Edit before the next recording'));
  await page.waitForFunction(()=>!document.body.textContent.includes('Saving…'));
  // The pointer that opened the drawer is still on it: the hover hold applies.
  await page.clock.runFor(30_100);
  await page.locator('[data-phase="idle"]').waitFor();
  console.log('PASS: a new recording resets the previous editing state');
  await page.reload();
  await openDrawer();
  await page.evaluate(()=>{window.__qaBlockNextSave=true;});
  await editor.fill('Save must finish before collapse');
  await editor.blur();
  await page.waitForFunction(()=>!!window.__qaResolveSave);
  await page.clock.runFor(60_000);
  assert.equal(await editor.inputValue(),'Save must finish before collapse');
  await page.evaluate(()=>window.__qaResolveSave());
  await page.getByRole('status').waitFor();
  await page.clock.runFor(15_100);
  assert.equal(await editor.count(),1);
  await page.getByRole('button',{name:'Collapse to the pill'}).click();
  await page.locator('[data-phase="idle"]').waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('qa-transcript')),'Save must finish before collapse');
  console.log('PASS: in-flight saves preserve the editor, and explicit dismissal keeps the saved text');
  await page.evaluate(() => window.__qaEmit({phase:'recording',sessionId:'live-edit',mode:'audio',message:null,notice:null,startedAtMs:Date.now()}));
  await editor.waitFor();
  const caption = async (text, startMs = 0, isFinal = false, sessionId = 'live-edit') => page.evaluate(({ text, startMs, isFinal, sessionId }) => window.__qaCaption({sessionId,track:'mic',text,startMs,endMs:startMs+1000,isFinal}), {text,startMs,isFinal,sessionId});
  await caption('Check the tickets');
  await page.waitForFunction(()=>document.querySelector('textarea')?.value==='Check the tickets');
  await editor.press('ControlOrMeta+a');
  await page.keyboard.insertText('Review the tickets');
  await editor.press('Home');
  await editor.press('ArrowRight');
  await editor.press('Shift+ArrowRight');
  const liveSelection = await editor.evaluate(el=>[el.selectionStart,el.selectionEnd]);
  await caption('Check the tickets that arrived overnight.');
  await page.waitForFunction(()=>document.querySelector('textarea')?.value==='Review the tickets that arrived overnight.');
  assert.deepEqual(await editor.evaluate(el=>[el.selectionStart,el.selectionEnd]),liveSelection);
  assert.equal(await editor.evaluate(el=>el===document.activeElement),true);
  await caption('Check the tickets that arrived overnight.',0,true);
  await caption('Then check PostHog.',1100,true);
  await page.waitForFunction(()=>document.querySelector('textarea')?.value==='Review the tickets that arrived overnight. Then check PostHog.');
  await editor.press('ControlOrMeta+z');
  assert.equal(await editor.inputValue(),'Check the tickets that arrived overnight. Then check PostHog.');
  await editor.press('ControlOrMeta+Shift+z');
  assert.equal(await editor.inputValue(),'Review the tickets that arrived overnight. Then check PostHog.');
  await page.getByRole('button',{name:/^Stop/}).click();
  await page.locator('[data-phase="transcribing"]').waitFor();
  await editor.fill('Review the tickets that arrived overnight.\nThen investigate PostHog.');
  await editor.press('Home');
  await editor.press('Shift+ArrowRight');
  const transcribingSelection=await editor.evaluate(el=>[el.selectionStart,el.selectionEnd]);
  await caption('Make a plan.',2200,true);
  const complete='Review the tickets that arrived overnight.\nThen investigate PostHog. Make a plan.';
  await page.waitForFunction(text=>document.querySelector('textarea')?.value===text,complete);
  assert.deepEqual(await editor.evaluate(el=>[el.selectionStart,el.selectionEnd]),transcribingSelection);
  assert.equal(await editor.evaluate(el=>el===document.activeElement),true);
  await page.evaluate(() => window.__qaEmit({phase:'done',sessionId:'live-edit',mode:'audio',message:'Check the tickets that arrived overnight. Then check PostHog. Make a plan.',notice:null,startedAtMs:null}));
  await page.waitForFunction(text=>document.querySelector('textarea')?.value===text,complete);
  assert.deepEqual(await editor.evaluate(el=>[el.selectionStart,el.selectionEnd]),transcribingSelection);
  await page.clock.runFor(400);
  await page.waitForFunction(text=>localStorage.getItem('qa-transcript')===text,complete);
  await page.getByRole('button',{name:'Copy',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__qaCopies.at(-1)),complete);
  assert.ok((await page.evaluate(()=>window.__qaLiveEdits)).some(edit=>edit.sessionId==='live-edit' && edit.text.includes('investigate')));
  console.log('PASS: edit while recording and transcribing, append speech, retain selection, and save/copy the merged completion');
  await page.evaluate(() => window.__qaEmit({phase:'recording',sessionId:'long-live',mode:'audio',message:null,notice:null,startedAtMs:Date.now()}));
  await page.locator('[data-phase="recording"]').waitFor();
  for (let i=0; i<16; i++) await caption(`Sentence ${i}.`,i*1100,true,'long-live');
  const longText=Array.from({length:16},(_,i)=>`Sentence ${i}.`).join(' ');
  await page.waitForFunction(text=>document.querySelector('textarea')?.value===text,longText);
  await editor.fill(longText.replace('Sentence 0.','Corrected opening.'));
  await editor.press('ControlOrMeta+Home');
  await editor.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
  await caption('A new final sentence.',18000,true,'long-live');
  await page.waitForFunction(()=>document.querySelector('textarea')?.value.endsWith('A new final sentence.'));
  assert.ok((await editor.inputValue()).startsWith('Corrected opening. Sentence 1.'));
  assert.equal(await editor.evaluate(el=>el.scrollTop),0);
  await editor.press('ControlOrMeta+End');
  await editor.dispatchEvent('compositionstart',{data:''});
  await page.keyboard.insertText('語');
  const composingText=await editor.inputValue();
  await caption('Speech during composition.',19500,true,'long-live');
  assert.equal(await editor.inputValue(),composingText);
  await editor.dispatchEvent('compositionend',{data:'語'});
  await page.waitForFunction(()=>document.querySelector('textarea')?.value.includes('語') && document.querySelector('textarea')?.value.endsWith('Speech during composition.'));
  console.log('PASS: long captures retain their opening, scrolling stays put while editing, and speech waits for composition to finish');
  await page.evaluate(() => window.__qaEmit({phase:'done',sessionId:null,mode:'audio',message:'Result without a recording identity',notice:null,startedAtMs:null}));
  await page.locator('[data-size="receipt"]').waitFor();
  assert.equal(await editor.count(),0);
  console.log('PASS: a result without a recording ID shows only its receipt, with nothing to edit');
  await page.evaluate(() => window.__qaEmit({phase:'failed',sessionId:'qa-failed',mode:'audio',message:"Didn't hear anything",notice:null,startedAtMs:null}));
  await page.locator('[data-phase="failed"][data-size="wide"]').waitFor();
  await page.clock.runFor(5_000);
  assert.equal(await page.locator('[data-phase="failed"]').count(), 1);
  // 6s away, or the hover hold if the pointer is still on it: either way it goes.
  await page.clock.runFor(26_000);
  await page.locator('[data-phase="idle"]').waitFor();
  console.log('PASS: a failure goes back to the pill by itself');
  await page.evaluate(() => window.__qaEmit({phase:'saved',sessionId:'qa-saved',mode:'audio',message:null,notice:'Saved. Sign in to have it typed for you',startedAtMs:null}));
  await page.locator('[data-phase="saved"][data-size="wide"]').waitFor();
  await page.getByText('Not typed').waitFor();
  await page.getByText('Saved. Sign in to have it typed for you').waitFor();
  console.log('PASS: a save that was not typed says so, and why, in the wide size');
  await page.evaluate(() => window.__qaEmit({phase:'recording',sessionId:'qa-stop',mode:'audio',message:null,notice:null,startedAtMs:Date.now()}));
  await page.locator('[data-phase="recording"]').waitFor();
  await page.evaluate(() => { window.__qaFailStop = 'no active capture with that id'; });
  await page.getByRole('button',{name:/^Stop/}).click();
  await page.getByRole('alert').filter({ hasText: 'That recording has already stopped' }).waitFor();
  assert.equal(await page.getByText('no active capture').count(), 0);
  assert.equal(await page.getByRole('button',{name:/^Stop/}).isEnabled(), true);
  assert.equal(await page.locator('.ctl-timer').count(), 1);
  await editor.waitFor();
  await page.evaluate(() => { window.__qaFailStop = null; });
  // Leave the recording, so the next check's "recording" wait sees its own session.
  await page.evaluate(() => window.__qaEmit({phase:'idle',sessionId:null,mode:null,message:null,notice:null,startedAtMs:null}));
  await page.locator('[data-phase="idle"]').waitFor();
  console.log('PASS: a failed stop says so in user words, and Stop, the timer and the words stay');
  await page.evaluate(() => {
    window.__qaEmit({phase:'recording',sessionId:'qa-live',mode:'audio',message:null,notice:null,startedAtMs:Date.now()});
  });
  await page.locator('[data-phase="recording"]').waitFor();
  await page.evaluate(() => {
    window.__qaCaption({sessionId:'qa-live',track:'mic',isFinal:false,startMs:0,endMs:10000,
      text:'First complete sentence with several words. Second complete sentence with several words. Third complete sentence with several words. Fourth complete sentence with several words. Fifth complete sentence with several words. Sixth complete sentence with several words.'});
  });
  await editor.waitFor();
  await editor.blur();
  await page.clock.runFor(100);
  const viewport = await editor.evaluate(el=>({height:el.clientHeight,top:el.scrollTop,total:el.scrollHeight}));
  assert.equal(viewport.height,80);
  assert.ok(viewport.total>viewport.height);
  assert.ok(viewport.top > 0);
  assert.equal(viewport.top,viewport.total - viewport.height);
  assert.equal(viewport.top % 20,0);
  await page.evaluate(()=>{window.__qaFailLiveEdit=true;});
  await editor.fill('Live correction that needs retry');
  await page.getByRole('button',{name:'Retry save'}).waitFor();
  const priorLiveEdits=await page.evaluate(()=>window.__qaLiveEdits.length);
  await page.evaluate(()=>window.__qaEmit({phase:'recording',sessionId:'new-live',mode:'audio',message:null,notice:null,startedAtMs:Date.now()}));
  await page.waitForFunction(()=>!document.body.textContent.includes('Retry save'));
  assert.equal(await page.evaluate(()=>window.__qaLiveEdits.length),priorLiveEdits);
  await page.evaluate(()=>{window.__qaFailLiveEdit=false;window.__qaFocusRevision=4_000_000_000_000_000;window.__qaBlockFocus=true;});
  await editor.focus();
  await editor.fill('A fresh correction after reloading the renderer');
  await page.waitForFunction(()=>!!window.__qaResolveFocus);
  assert.equal(await page.evaluate(()=>window.__qaLiveEdits.length),priorLiveEdits);
  await page.evaluate(()=>window.__qaResolveFocus());
  await page.waitForFunction(()=>window.__qaLiveEdits.at(-1)?.sessionId==='new-live');
  assert.ok((await page.evaluate(()=>window.__qaLiveEdits.at(-1).revision))>4_000_000_000_000_000);
  console.log('PASS: a new capture clears stale retries; native revision readback recovers a renderer with an older clock');
  await editor.blur();
  await page.evaluate(()=>{window.__qaFailFocusCount=2;});
  await editor.focus();
  await editor.fill('Correction after a transient focus failure');
  await page.getByRole('button',{name:'Retry save'}).waitFor();
  await page.getByRole('button',{name:'Retry save'}).click();
  await page.waitForFunction(()=>window.__qaLiveEdits.at(-1)?.text==='Correction after a transient focus failure');
  await page.waitForFunction(()=>!document.body.textContent.includes('Retry save'));
  console.log('PASS: transient focus initialization failure can be retried without refocusing or losing the draft');

  await page.screenshot({path:join(tmpdir(),'eavesy-live-lines-verified.png')});
  console.log('PASS: live captions scroll on whole line boundaries');
} finally { await browser.close(); }
