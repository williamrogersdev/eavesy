// Injected into every document before the meeting app's own scripts run.
// It captures the remote audio the call delivers over WebRTC and gives the
// platform adapters (meet.js, teams.js) helpers to read and drive the page.
//
// Audio leaves through the `__eavesyAudio` CDP binding as JSON
// {pcm: base64 16 kHz mono s16le, peak: 0..1}, one call per 4096 samples
// (256 ms). Rust owns segmenting, encoding and upload.
(() => {
  if (window.__eavesy) return;
  const SAMPLE_RATE = 16000;
  const BLOCK = 4096;

  // ---- audio ----------------------------------------------------------------

  let ctx = null;
  let mix = null;
  const tracks = new Map();
  let pending = new Int16Array(BLOCK);
  let filled = 0;
  let peak = 0;

  function emit() {
    const bytes = new Uint8Array(pending.buffer, 0, filled * 2);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    window.__eavesyAudio?.(JSON.stringify({ pcm: btoa(binary), peak }));
    pending = new Int16Array(BLOCK);
    filled = 0;
    peak = 0;
  }

  function take(samples) {
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
      pending[filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      if (filled === BLOCK) emit();
    }
  }

  // The worklet runs on the audio thread, so a busy meeting page can delay
  // its messages but never drop samples. It needs a module URL, which only
  // loads because the driver turns off the page's CSP (Page.setBypassCSP).
  const WORKLET = `registerProcessor('eavesy-tap', class extends AudioWorkletProcessor {
    process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
  });`;

  async function ensureGraph() {
    if (ctx) return;
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    mix = ctx.createGain();
    const sink = ctx.createGain();
    sink.gain.value = 0; // a node must reach the destination to be pulled
    sink.connect(ctx.destination);
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      const tap = new AudioWorkletNode(ctx, 'eavesy-tap');
      tap.port.onmessage = (event) => { if (tracks.size) take(event.data); };
      mix.connect(tap);
      tap.connect(sink);
      window.__eavesyTap = 'worklet';
    } catch {
      // Fallback: the deprecated main-thread processor, which can glitch
      // when the page is busy but needs no module.
      const tap = ctx.createScriptProcessor(BLOCK, 1, 1);
      tap.onaudioprocess = (event) => { if (tracks.size) take(event.inputBuffer.getChannelData(0)); };
      mix.connect(tap);
      tap.connect(sink);
      window.__eavesyTap = 'script-processor';
    }
    setInterval(() => ctx.state !== 'running' && ctx.resume().catch(() => {}), 1000);
  }

  async function addTrack(track) {
    if (track.kind !== 'audio' || tracks.has(track.id)) return;
    tracks.set(track.id, null);
    await ensureGraph();
    const stream = new MediaStream([track]);
    // Chromium hands Web Audio silence from a remote WebRTC stream that no
    // media element plays, so play it, muted, as well.
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    el.play().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    source.connect(mix);
    tracks.set(track.id, { source, el });
    track.addEventListener('ended', () => {
      const entry = tracks.get(track.id);
      if (!entry) return;
      entry.source.disconnect();
      entry.el.srcObject = null;
      tracks.delete(track.id);
    });
  }

  const Native = window.RTCPeerConnection;
  if (Native) {
    const Wrapped = function (...args) {
      const pc = new Native(...args);
      pc.addEventListener('track', (event) => {
        if (event.track.kind === 'audio') addTrack(event.track);
      });
      return pc;
    };
    Wrapped.prototype = Native.prototype;
    Object.setPrototypeOf(Wrapped, Native);
    window.RTCPeerConnection = Wrapped;
  }

  // Video is never needed. Hiding it stops Chromium compositing the tiles,
  // and both apps then ask their servers for smaller or no video streams.
  const style = document.createElement('style');
  style.textContent = 'video { display: none !important; }';
  const addStyle = () => (document.head || document.documentElement).appendChild(style);
  if (document.documentElement) addStyle();
  else document.addEventListener('DOMContentLoaded', addStyle);

  // ---- reading the page -------------------------------------------------------
  // Matching is on aria-labels, tooltips and visible English text, never on
  // class names: both apps ship obfuscated classes that change every few
  // weeks. Chromium runs with --lang=en-US so the strings are the English UI.

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  // Tested one at a time: icon buttons put a glyph name ("call_end") in
  // their text beside the label.
  const names = (el) => [el.getAttribute('aria-label'), el.getAttribute('data-tooltip'), el.getAttribute('title'), (el.innerText || '').trim()]
    .filter(Boolean);
  const buttons = () => [...document.querySelectorAll('button, [role="button"]')].filter(visible);
  const findButton = (re) => buttons().find((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true' && names(b).some((n) => re.test(n)));
  const click = (re) => {
    const b = findButton(re);
    if (!b) return false;
    b.click();
    return true;
  };
  const text = () => (document.body ? document.body.innerText : '');

  function setInput(input, value) {
    if (!input) return false;
    if (input.value === value) return true;
    input.focus();
    // React tracks the value through the prototype setter.
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  const countIn = (el) => {
    const m = el && names(el).join(' ').match(/(\d+)/);
    return m ? Number(m[1]) : null;
  };

  const clean = (list) => [...new Set(list.map((n) => (n || '').split('\n')[0].trim()).filter((n) => n && n.length <= 80))];

  /**
   * One look at the page for an adapter `a`. Returns what Rust needs to
   * decide the next move; clicking through dialogs and the join screen
   * happens here as a side effect.
   */
  function step(a, botName) {
    const body = text();
    if (findButton(a.leave)) {
      return {
        phase: 'in_call',
        alone: a.alone.test(body) || a.count() === 1,
        count: a.count(),
        speaking: clean(a.speaking()),
        participants: clean(a.participants()),
        tracks: tracks.size,
        tap: window.__eavesyTap || null,
      };
    }
    for (const [phase, re] of [['not_found', a.notFound], ['denied', a.denied], ['lobby', a.lobby], ['ended', a.ended], ['sign_in_required', a.signIn]]) {
      if (re.test(body)) return { phase };
    }
    click(a.dismiss);
    const input = a.nameInput();
    if (input) {
      setInput(input, botName);
      click(a.micOff);
      click(a.camOff);
      return { phase: 'prejoin', joined: click(a.join) };
    }
    if (click(a.join)) return { phase: 'prejoin', joined: true };
    return { phase: 'loading', page: pageShape(), title: titleShape() };
  }

  // The meeting link (and Meet's code in the title) lets anyone into the
  // call, so the logs only get the shape of where the page is: plain words
  // in the path stay, anything else is masked, and the query never leaves.
  const MEET_CODE = /[a-z]{3}-[a-z]{4}-[a-z]{3}/gi;
  const mask = (value) => value.replace(/[0-9]/g, '9').replace(/[A-Za-z]/g, 'x');
  const plainWord = (part) => part.length <= 24 && /^[a-z]+(?:[-._][a-z]+)*$/.test(part) && !/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(part);
  function pageShape() {
    return location.origin + location.pathname.split('/').map((part) => (plainWord(part) ? part : mask(part))).join('/');
  }
  function titleShape() {
    return document.title.replace(MEET_CODE, 'xxx-xxxx-xxx').replace(/\d{3,}/g, (d) => mask(d)).slice(0, 80);
  }

  window.__eavesy = { step, click, findButton, setInput, names, countIn, clean, visible, adapters: {} };
})();
