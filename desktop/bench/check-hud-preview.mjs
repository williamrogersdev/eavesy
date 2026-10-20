import { chromium } from '../../web/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:400,height:142}});
  page.setDefaultTimeout(5000);
  await page.clock.install();
  await page.addInitScript(() => {
    const listeners = new Map();
    let state = {phase:'done',sessionId:'qa-1',mode:'audio',message:localStorage.getItem('qa-transcript') ?? 'Original first sentence. Original last sentence.',notice:null,startedAtMs:null};
    window.__qaCopies=[];
    window.__qaSaves=[];
    window.__qaFailSave=false;
    window.__qaEmit = (next) => { state=next; (listeners.get('hud:state')??[]).forEach(fn=>fn({payload:state})); };
    window.__TAURI__ = {
      core:{invoke:async (cmd,args) => {
        if(cmd==='save_preview_transcript') {
          if(window.__qaBlockNextSave) { window.__qaBlockNextSave=false; await new Promise(resolve=>{window.__qaResolveSave=resolve;}); }
          if(window.__qaFailSave) throw new Error('Test disk write failed');
          window.__qaSaves.push(args);
          localStorage.setItem('qa-transcript',args.text);
          state={...state,message:args.text};
        }
        if(cmd==='get_hud_state') return state;
        if(cmd==='get_settings') return {dictation_hotkey:'Fn'};
        if(cmd==='live_transcript') return [];
        if(cmd==='copy_text') window.__qaCopies.push(args.text);
        if(cmd==='dismiss_hud') window.__qaEmit({...state,phase:'idle',message:null});
      }},
      event:{listen:async (event,fn) => { const list=listeners.get(event)??[];list.push(fn);listeners.set(event,list);return ()=>listeners.set(event,list.filter(f=>f!==fn)); }}
    };
  });
  await page.goto('http://127.0.0.1:1420/hud.html');
  const editor=page.getByRole('textbox',{name:'Edit transcript preview'});
  await editor.waitFor();
  await page.clock.fastForward(14_900);
  assert.equal(await editor.count(),1);
  await page.clock.fastForward(101);
  await page.locator('[data-phase="idle"]').waitFor();
  console.log('PASS: returns to pill after 15 seconds');
  await page.reload();
  await editor.waitFor();
  await editor.fill('');
  assert.equal(await editor.count(),1);
  await editor.fill('Corrected first sentence.\nCorrected final sentence.');
  await page.clock.fastForward(60_000);
  assert.equal(await editor.inputValue(),'Corrected first sentence.\nCorrected final sentence.');
  console.log('PASS: editing keeps the preview open; deleting all text keeps the editor');
  await page.evaluate(() => window.__qaEmit({phase:'done',sessionId:'qa-1',mode:'audio',message:'Late cloud transcript',notice:null,startedAtMs:null}));
  assert.equal(await editor.inputValue(),'Corrected first sentence.\nCorrected final sentence.');
  await page.getByRole('button',{name:'Copy',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.__qaCopies),['Corrected first sentence.\nCorrected final sentence.']);
  console.log('PASS: late transcript updates preserve edits; Copy uses corrected text');
  await page.screenshot({path:'/private/tmp/eavesy-editable-preview-verified.png'});
  await page.clock.fastForward(14_900);
  assert.equal(await editor.count(),1);
  await page.clock.fastForward(101);
  await page.locator('[data-phase="idle"]').waitFor();
  console.log('PASS: 15-second timer restarts after editing ends');
  assert.equal(await page.evaluate(()=>localStorage.getItem('qa-transcript')),'Corrected first sentence.\nCorrected final sentence.');
  await page.reload();
  await editor.waitFor();
  assert.equal(await editor.inputValue(),'Corrected first sentence.\nCorrected final sentence.');
  console.log('PASS: corrected transcript survives collapse and reload');
  await page.evaluate(()=>{window.__qaFailSave=true;});
  await editor.fill('Correction that must survive a failed save');
  await editor.blur();
  await page.getByRole('button',{name:'Retry save'}).waitFor();
  await page.clock.fastForward(60_000);
  assert.equal(await editor.inputValue(),'Correction that must survive a failed save');
  await page.evaluate(()=>{window.__qaFailSave=false;});
  await page.getByRole('button',{name:'Retry save'}).click();
  await page.getByRole('status').waitFor();
  await page.clock.fastForward(15_001);
  await page.locator('[data-phase="idle"]').waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('qa-transcript')),'Correction that must survive a failed save');
  console.log('PASS: save failures keep edits visible and block collapse until retry succeeds');
  await page.reload();
  await editor.waitFor();
  await editor.fill('Edit before the next recording');
  await page.evaluate(() => window.__qaEmit({phase:'recording',sessionId:'qa-2',mode:'audio',message:null,notice:null,startedAtMs:Date.now()}));
  await page.locator('[data-phase="recording"]').waitFor();
  await page.evaluate(() => window.__qaEmit({phase:'done',sessionId:'qa-2',mode:'audio',message:'New recording text',notice:null,startedAtMs:null}));
  await editor.waitFor();
  assert.equal(await editor.inputValue(),'New recording text');
  await page.clock.fastForward(400);
  await page.waitForFunction(()=>window.__qaSaves.some(edit=>edit.text==='Edit before the next recording'));
  await page.waitForFunction(()=>!document.body.textContent.includes('Saving…'));
  await page.clock.runFor(15_100);
  await page.locator('[data-phase="idle"]').waitFor();
  console.log('PASS: a new recording resets the previous editing state');
  await page.reload();
  await editor.waitFor();
  await page.evaluate(()=>{window.__qaBlockNextSave=true;});
  await editor.fill('Save must finish before collapse');
  await editor.blur();
  await page.waitForFunction(()=>!!window.__qaResolveSave);
  await page.clock.fastForward(60_000);
  assert.equal(await editor.inputValue(),'Save must finish before collapse');
  await page.evaluate(()=>window.__qaResolveSave());
  await page.getByRole('status').waitFor();
  await page.clock.runFor(15_100);
  await page.locator('[data-phase="idle"]').waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('qa-transcript')),'Save must finish before collapse');
  console.log('PASS: in-flight saves finish before automatic collapse');
} finally { await browser.close(); }
