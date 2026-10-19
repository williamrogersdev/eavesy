// Dev-only stand-in for the Tauri bridge, so the capture panel can be looked
// at in a plain browser: `vite dev` → /?mock (add &empty for the empty state,
// &live for a recording in progress, &setup for first-run onboarding with
// nothing allowed yet, &settings to open Settings, &fn=ready for a Mac where
// fn is fully set up). Never active in a production build.

type Handler = (e: { payload: unknown }) => void;

const HOUR = 3_600_000;

function sampleRecordings(now: number) {
  const day = 24 * HOUR;
  return [
    { id: 'r1', title: 'Dictation', started_at_ms: now - 0.2 * HOUR, duration_sec: 14, source: 'dictation', status: 'complete', has_audio: true, transcript: 'Remind me to send Priya the revised onboarding deck before Thursday, and ask whether the pricing page copy is final.' },
    { id: 'r2', title: 'Screenshot', started_at_ms: now - 0.9 * HOUR, duration_sec: 0, source: 'screenshot', status: 'complete', has_audio: false },
    { id: 'r3', title: 'Weekly design sync', started_at_ms: now - 2.5 * HOUR, duration_sec: 1840, source: 'both', status: 'complete', has_audio: true, transcript: 'We agreed the capture panel ships first and the HUD restyle follows. Sam will check the drag and drop on a real Mac. The empty state keeps the mascot but loses the second paragraph. Open question: whether imported audio should be transcribed automatically or only on request. We also talked through the tray icon, which now swaps to the recording glyph while the mic is live, and the screenshot folder watcher, which is now on by default.' },
    { id: 'r4', title: 'Note', started_at_ms: now - day - 3 * HOUR, duration_sec: 0, source: 'note', status: 'complete', has_audio: false, transcript: 'Ideas for the onboarding email:\n- lead with the mascot\n- one screenshot, not three' },
    { id: 'r5', title: 'Talk', started_at_ms: now - day - 5 * HOUR, duration_sec: 42, source: 'mic', status: 'processing', has_audio: true },
  ];
}

const SHOT = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#cfd8e8"/><stop offset="1" stop-color="#8fa3c4"/></linearGradient></defs><rect width="480" height="300" fill="url(#g)"/><rect x="30" y="30" width="250" height="16" rx="8" fill="#fff" opacity=".8"/><rect x="30" y="62" width="400" height="10" rx="5" fill="#fff" opacity=".55"/><rect x="30" y="82" width="360" height="10" rx="5" fill="#fff" opacity=".55"/><rect x="30" y="130" width="420" height="140" rx="12" fill="#fff" opacity=".4"/></svg>',
);

export function installDevMock(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('mock')) return;
  const now = Date.now();
  const recordings = params.has('empty') ? [] : sampleRecordings(now);
  const live = params.has('live');
  const settings = {
    toggle_hotkey: 'Cmd+Shift+Space', dictation_hotkey: 'Fn', device_id: 'dev', setup_completed: true,
    recordings_root: '~/Eavesy/Recordings', launcher_position: 'top_center', live_captions: true, add_screenshots: true,
  };
  const results: Record<string, unknown> = {
    get_setup_status: { paired: true, completed: true },
    account_info: { name: 'Robin Avery', email: 'robin@example.com' },
    get_settings: settings,
    list_recordings: recordings,
    sync_status: { signedOut: false },
    check_permissions: { mic: true, micAsked: true, screen: true, accessibility: true, speech: true, inputMonitoring: true, notifications: true },
    get_hud_state: live
      ? { phase: 'recording', sessionId: 's-live', mode: 'audio', startedAtMs: now - 23_000 }
      : { phase: 'idle', sessionId: null },
    get_screenshot_folder: '~/Desktop',
    get_app_info: { name: 'Eavesy', version: '0.2.0', update: { state: 'upToDate', currentVersion: '0.2.0' } },
    capture_media: '/mock/shot.png',
    list_projects: params.has('noprojects') ? [] : [
      { id: 'p-eavesy', name: 'eavesy', about: 'Mac meeting recorder', vocabulary: ['Tauri', 'D1'], people: null, match: [], recordingCount: 12 },
      { id: 'p-acme', name: 'Acme redesign', about: null, vocabulary: [], people: 'Maya, Alex', match: ['acme'], recordingCount: 3 },
    ],
    front_window: { app: 'Cursor', title: 'summarize.ts — eavesy' },
    agent_transcript: 'Rename `summarize.ts` to `summary.ts` and update the imports.',
    live_transcript: live ? [{ startMs: 0, endMs: 4000, track: 'mic', text: 'so the plan for this week is to finish the panel and then', provisional: true }] : [],
  };
  if (params.has('setup')) installSetupMock(results);
  const listeners = new Map<string, Handler[]>();
  const emit = (event: string, payload: unknown = null) => listeners.get(event)?.forEach((handler) => handler({ payload }));
  const hotkeys = mockHotkeys(settings, params.get('fn') === 'ready');
  (window as unknown as { __evMock: unknown }).__evMock = { fnTap: () => emit('hotkeys:fn-tap') };
  if (params.has('settings')) setTimeout(() => emit('launcher:settings'), 400);
  window.__TAURI__ = {
    core: {
      convertFileSrc: () => SHOT,
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => {
        console.debug('[mock invoke]', cmd, args);
        if (cmd in hotkeys) return hotkeys[cmd](args ?? {}) as Promise<T>;
        const value = cmd in results ? results[cmd] : null;
        return Promise.resolve((typeof value === 'function' ? (value as () => unknown)() : value) as T);
      },
    },
    event: {
      listen: (event: string, handler: Handler) => {
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        return Promise.resolve(() => {
          listeners.set(event, (listeners.get(event) ?? []).filter((h) => h !== handler));
        });
      },
    },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }) },
  } as unknown as NonNullable<Window['__TAURI__']>;
}

/** First run: signed out, nothing allowed. Each request grants its permission, like clicking Allow. */
function installSetupMock(results: Record<string, unknown>): void {
  const kinds = ['mic', 'speech', 'screen', 'accessibility', 'inputMonitoring', 'notifications'] as const;
  const granted = new Set<string>();
  let paired = false;
  const permissions = () => ({
    ...Object.fromEntries(kinds.map((kind) => [kind, granted.has(kind)])),
    micAsked: granted.has('mic'),
    status: Object.fromEntries(kinds.map((kind) => [kind, granted.has(kind) ? 'granted' : kind === 'screen' || kind === 'accessibility' ? 'notGranted' : 'notDetermined'])),
  });
  const grant = (kind: (typeof kinds)[number], value: unknown = permissions) => () => {
    granted.add(kind);
    return typeof value === 'function' ? (value as () => unknown)() : value;
  };
  Object.assign(results, {
    get_setup_status: () => ({ paired, completed: false }),
    account_info: () => (paired ? { name: 'Robin Avery', email: 'robin@example.com' } : null),
    pair_device: () => { paired = true; return null; },
    check_permissions: permissions,
    request_microphone: grant('mic'),
    request_speech: grant('speech'),
    request_screen: grant('screen'),
    request_accessibility: grant('accessibility', true),
    request_input_monitoring: grant('inputMonitoring', 'granted'),
    request_notifications: grant('notifications', 'granted'),
  });
}

type Bindings = { toggle_hotkey: string; dictation_hotkey: string };
const DEFAULTS = { toggle: 'Cmd+Shift+Space', dictation: 'Cmd+Shift+D' };
const COMMON: Record<string, string> = { C: 'Copy', V: 'Paste', X: 'Cut', A: 'Select All', Z: 'Undo', S: 'Save', Q: 'Quit', W: 'Close' };

/** A rough stand-in for hotkeys.rs + shortcut_conflicts.rs, enough to see every Settings state. */
function mockHotkeys(settings: Bindings, fnReady: boolean): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const key = (action: unknown) => (action === 'toggle' ? 'toggle_hotkey' : 'dictation_hotkey');
  const other = (action: unknown) => (action === 'toggle' ? 'dictation' : 'toggle');
  const validate = (accel: string) => {
    if (!accel || accel === 'Fn' || /^F([1-9]|1[0-2])$/.test(accel) || /(^|\+)(Cmd|Ctrl|Alt)\+/.test(accel)) return null;
    return { kind: 'needsModifier' };
  };
  const plan = (action: unknown, accel: string, swap: boolean) => {
    const refused = validate(accel);
    if (refused) return refused;
    const otherKey = key(other(action));
    if (accel && settings[otherKey] === accel) {
      if (!swap) return { kind: 'taken', by: other(action) };
      settings[otherKey] = settings[key(action)];
    }
    settings[key(action)] = accel;
    return null;
  };
  return {
    check_hotkey: ({ action, accelerator }) => {
      const accel = String(accelerator);
      const refused = validate(accel) ?? (accel && settings[key(other(action))] === accel ? { kind: 'taken', by: other(action) } : null);
      if (refused) return Promise.reject(refused);
      if (accel === 'Cmd+Space') return Promise.resolve({ kind: 'system', name: 'Spotlight' });
      const common = /^Cmd\+([A-Z])$/.exec(accel)?.[1];
      return Promise.resolve(common && COMMON[common] ? { kind: 'common', name: COMMON[common] } : null);
    },
    set_hotkey: ({ action, accelerator, swap }) => {
      const refused = plan(action, String(accelerator), swap === true);
      return refused ? Promise.reject(refused) : Promise.resolve(null);
    },
    reset_all_hotkeys: () => {
      settings.toggle_hotkey = DEFAULTS.toggle;
      settings.dictation_hotkey = DEFAULTS.dictation;
      return Promise.resolve(null);
    },
    get_hotkey_defaults: () => Promise.resolve(DEFAULTS),
    get_settings: () => Promise.resolve({ ...settings }),
    fn_status: () => Promise.resolve(fnReady ? { input_monitoring: true, globe_action: 'do_nothing' } : { input_monitoring: false, globe_action: 'emoji' }),
    suspend_hotkeys: ({ suspended }) => Promise.resolve(suspended === true && fnReady),
  };
}
