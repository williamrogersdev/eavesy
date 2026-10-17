// Dev-only stand-in for the Tauri bridge, so the capture panel can be looked
// at in a plain browser: `vite dev` → /?mock (add &empty for the empty state,
// &live for a recording in progress). Never active in a production build.

type Handler = (e: { payload: unknown }) => void;

const HOUR = 3_600_000;

function sampleRecordings(now: number) {
  const day = 24 * HOUR;
  return [
    { id: 'r1', title: 'Dictation', started_at_ms: now - 0.2 * HOUR, duration_sec: 14, source: 'dictation', status: 'complete', has_audio: true, transcript: 'Remind me to send Priya the revised onboarding deck before Thursday, and ask whether the pricing page copy is final.' },
    { id: 'r2', title: 'Screenshot', started_at_ms: now - 0.9 * HOUR, duration_sec: 0, source: 'screenshot', status: 'complete', has_audio: false },
    { id: 'r3', title: 'Weekly design sync', started_at_ms: now - 2.5 * HOUR, duration_sec: 1840, source: 'both', status: 'complete', has_audio: true, transcript: 'We agreed the capture panel ships first and the HUD restyle follows. Sam will check the drag and drop on a real Mac. The empty state keeps the mascot but loses the second paragraph. Open question: whether imported audio should be transcribed automatically or only on request. We also talked through the tray icon, which now swaps to the recording glyph while the mic is live, and the screenshot folder watcher, which stays opt-in.' },
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
    recordings_root: '~/Eavesy/Recordings', launcher_position: 'top_center', live_captions: true, auto_import_screenshots: false,
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
    live_transcript: live ? [{ startMs: 0, endMs: 4000, track: 'mic', text: 'so the plan for this week is to finish the panel and then', provisional: true }] : [],
  };
  const listeners = new Map<string, Handler[]>();
  window.__TAURI__ = {
    core: {
      convertFileSrc: () => SHOT,
      invoke: <T>(cmd: string) => {
        console.debug('[mock invoke]', cmd);
        return Promise.resolve((cmd in results ? results[cmd] : null) as T);
      },
    },
    event: {
      listen: (event: string, handler: Handler) => {
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        return Promise.resolve(() => {});
      },
    },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }) },
  } as unknown as NonNullable<Window['__TAURI__']>;
}
