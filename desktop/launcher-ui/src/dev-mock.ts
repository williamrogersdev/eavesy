import { version } from '../../src-tauri/tauri.conf.json';
// Dev-only stand-in for the Tauri bridge, so the capture panel can be looked
// at in a plain browser: `vite dev` → /?mock (add &empty for the empty state,
// &live for a recording in progress, &setup for first-run onboarding with
// nothing allowed yet, &perms-missing for Screen Recording off, &fn=ready for
// a Mac where fn is fully set up). Settings is its own page: /settings.html?mock.
// Never active in a production build.

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
  // Browsers preview the native panel by default; ?web opens the web palette.
  // A real Tauri webview always keeps its native bridge.
  if (window.__TAURI__ || (params.has('web') && !params.has('mock'))) return;
  const now = Date.now();
  const recordings = params.has('empty') ? [] : sampleRecordings(now);
  if (params.has('history')) {
    recordings.splice(0, recordings.length, ...Array.from({ length: 56 }, (_, i) => ({
      id: `history-${i}`, title: `History fixture ${i}`, started_at_ms: now - i * HOUR,
      duration_sec: 3600, source: 'both', status: 'complete', has_audio: true,
      transcript: `Capture ${i}. ${'Synthetic meeting words. '.repeat(200)} ${i === 55 ? 'hidden-search-needle' : 'full-transcript-tail'}`,
    })));
  }
  let copiedText = '';
  const live = params.has('live');
  const settings = {
    toggle_hotkey: 'Cmd+Shift+Space', dictation_hotkey: 'Fn', assistant_hotkey: 'Alt+Space', device_id: 'dev', setup_completed: true,
    recordings_root: '~/Eavesy/Recordings', launcher_position: 'top_center', live_captions: true, add_screenshots: true,
    hud_preview_lines: params.has('lines') ? Number(params.get('lines')) : undefined, hud_translucent: params.has('solid') ? false : undefined,
    fast_live_words: undefined as unknown, hud_result_preview: params.has('receipt') ? false : undefined as boolean | undefined,
  };
  let preferencesLoadFailures = params.has('settings-offline') ? 2 : 0;
  let preferencesSaveFailures = params.has('settings-save-failure') ? 1 : 0;
  const account = mockAccount(params.has('noprojects'), params.has('manywords'));
  let dictionary = [{ id: 'word-1', from: 'easey', to: 'Eavesy' }];
  const results: Record<string, unknown> = {
    get_setup_status: { paired: true, completed: true },
    account_info: params.has('signedout') ? null : { name: 'Robin Avery', email: 'robin@example.com' },
    get_settings: settings,
    list_recordings: ({ offset = 0, limit = 50, query = '', filter = 'all' }: Record<string, unknown>) => {
      const category = (row: (typeof recordings)[number]) => row.source === 'both' ? 'meetings' : row.source === 'screenshot' ? 'screens' : row.source === 'note' ? 'notes' : 'voice';
      const q = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
      const visible = recordings.filter((row) => (filter === 'all' || category(row) === filter) && q.every((word) => `${row.title} ${row.transcript ?? ''}`.toLowerCase().includes(word)));
      const start = Number(offset); const count = Number(limit);
      return { items: visible.slice(start, start + count).map((row) => ({ ...row, transcript: row.transcript?.slice(0, 2048), transcript_truncated: (row.transcript?.length ?? 0) > 2048, revision: 1 })), next_offset: start + count < visible.length ? start + count : null,
        counts: { all: recordings.length, voice: recordings.filter((row) => category(row) === 'voice').length, meetings: recordings.filter((row) => category(row) === 'meetings').length, screens: recordings.filter((row) => category(row) === 'screens').length, notes: recordings.filter((row) => category(row) === 'notes').length } };
    },
    get_recording: ({ id }: Record<string, unknown>) => { const row = recordings.find((row) => row.id === id); return row ? { ...row, revision: 2 } : null; },
    set_hud_look: ({ lines, translucent, fastLiveWords, resultPreview }: Record<string, unknown>) => {
      Object.assign(settings, { hud_preview_lines: lines, hud_translucent: translucent });
      if (fastLiveWords !== undefined) settings.fast_live_words = fastLiveWords;
      if (resultPreview !== undefined) settings.hud_result_preview = Boolean(resultPreview);
      emit('hud:look', { lines, translucent, preview: settings.hud_result_preview ?? true });
    },
    copy_text: ({ text }: Record<string, unknown>) => { copiedText = String(text); },
    sync_status: { signedOut: false },
    check_permissions: { mic: true, micAsked: true, screen: !params.has('perms-missing'), accessibility: true, speech: true, inputMonitoring: true, notifications: !params.has('perms-missing') },
    get_hud_state: live
      ? { phase: 'recording', sessionId: 's-live', mode: 'audio', startedAtMs: now - 23_000 }
      : { phase: 'idle', sessionId: null },
    get_screenshot_folder: '~/Desktop',
    ...assistantMock(params.has('eavesy-empty'), (event, payload) => emit(event, payload)),
    get_app_info: { name: 'Eavesy', version, update: { state: 'upToDate', currentVersion: version } },
    capture_media: '/mock/shot.png',
    list_projects: params.has('noprojects') ? [] : [
      { id: 'p-eavesy', name: 'eavesy', about: 'Mac meeting recorder', vocabulary: ['Tauri', 'D1'], people: null, match: [], recordingCount: 12 },
      { id: 'p-acme', name: 'Acme redesign', about: null, vocabulary: [], people: 'Maya, Alex', match: ['acme'], recordingCount: 3 },
    ],
    front_window: { app: 'Cursor', title: 'summarize.ts — eavesy' },
    account_call: (args: Record<string, unknown>) => {
      if (args.path === '/api/me' && args.method === 'GET' && preferencesLoadFailures > 0) { preferencesLoadFailures--; throw new Error('Could not reach eavesy.com'); }
      if (args.path === '/api/me' && args.method === 'PATCH' && preferencesSaveFailures > 0) { preferencesSaveFailures--; throw new Error('Could not reach eavesy.com'); }
      return account(args);
    },
    dictionary_request: ({ method, body }: Record<string, unknown>) => {
      const fields = (body ?? {}) as { from?: string; to?: string; id?: string; entries?: { from: string; to: string }[] };
      const upsert = ({ from, to }: { from: string; to: string }) => {
        const kept = dictionary.filter((entry) => entry.from.toLowerCase() !== from.toLowerCase());
        dictionary = [{ id: `word-${Date.now()}-${kept.length}`, from, to }, ...kept];
      };
      if (method === 'PUT' && fields.entries) {
        fields.entries.forEach(upsert);
        return { learned: fields.entries.length, skipped: 0, status: 'saved' };
      }
      if (method === 'PUT' && fields.from && fields.to) upsert({ from: fields.from, to: fields.to });
      if (method === 'DELETE') dictionary = dictionary.filter((entry) => entry.id !== fields.id);
      return method === 'GET' ? { entries: dictionary } : { learned: 1, status: 'saved' };
    },
    agent_transcript: 'Rename `summarize.ts` to `summary.ts` and update the imports.',
    restyle_dictation: ({ text, style, forAgents }: Record<string, unknown>) => {
      if (forAgents) return `Remind me to do two things before Thursday:\n\n1. Send Priya the revised onboarding deck.\n2. Ask her whether the pricing page copy is final.`;
      const tones: Record<string, string> = {
        professional: 'Please remind me to send Priya the revised onboarding deck before Thursday and to confirm whether the pricing page copy is final.',
        friendly: 'Hey, remember to send Priya the updated onboarding deck before Thursday! And check in on whether the pricing page copy is good to go.',
        concise: 'Before Thursday: send Priya the revised onboarding deck; ask if pricing page copy is final.',
      };
      return tones[String(style)] ?? String(text);
    },
    live_transcript: live ? [{ startMs: 0, endMs: 4000, track: 'mic', text: 'so the plan for this week is to finish the panel and then', provisional: true }] : [],
    // ⌘V in the panel: text lands in the composer as a draft.
    paste_to_composer: () => ({ kind: 'text', text: copiedText || 'Pasted from the clipboard' }),
    save_note: ({ text }: Record<string, unknown>) => {
      recordings.unshift({ id: `note-${Date.now()}`, title: 'Note', started_at_ms: Date.now(), duration_sec: 0, source: 'note', status: 'complete', has_audio: false, transcript: String(text) });
      setTimeout(() => emit('recordings:updated'), 0);
    },
    import_files: ({ paths }: Record<string, unknown>) => ({ ids: Array.isArray(paths) ? paths.map(String) : [], skipped: [] }),
    cancel_history_search: null,
    // The real app opens the Settings window; the browser preview opens its page.
    show_settings: () => { window.open(`settings.html${window.location.search || '?mock'}`, 'eavesy-settings'); },
    open_privacy_settings: null,
    set_panel_pinned: null,
    set_project_choice: null,
  };
  if (params.has('setup')) installSetupMock(results);
  const listeners = new Map<string, Handler[]>();
  const emit = (event: string, payload: unknown = null) => listeners.get(event)?.forEach((handler) => handler({ payload }));
  const hotkeys = mockHotkeys(settings, params.get('fn') === 'ready');
  (window as unknown as { __evMock: unknown }).__evMock = { fnTap: () => emit('hotkeys:fn-tap'), refreshHistory: () => emit('recordings:updated'), get copiedText() { return copiedText; } };
  window.__TAURI__ = {
    core: {
      convertFileSrc: () => SHOT,
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => {
        console.debug('[mock invoke]', cmd, args);
        if (cmd === 'translation_request' || cmd === 'read_clipboard_text') return Promise.reject(new Error('Open the Mac app to translate, or use the signed-in web app. This preview uses sample captures.'));
        if (cmd in hotkeys) return hotkeys[cmd](args ?? {}) as Promise<T>;
        const value = cmd in results ? results[cmd] : null;
        return Promise.resolve((typeof value === 'function' ? (value as (a: Record<string, unknown>) => unknown)(args ?? {}) : value) as T);
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

type Bindings = { toggle_hotkey: string; dictation_hotkey: string; assistant_hotkey: string };
type Action = 'toggle' | 'dictation' | 'assistant';
const ACTIONS: Action[] = ['toggle', 'dictation', 'assistant'];
const DEFAULTS: Record<Action, string> = { toggle: 'Cmd+Shift+Space', dictation: 'Cmd+Shift+D', assistant: 'Alt+Space' };
const COMMON: Record<string, string> = { C: 'Copy', V: 'Paste', X: 'Cut', A: 'Select All', Z: 'Undo', S: 'Save', Q: 'Quit', W: 'Close' };

/** A rough stand-in for hotkeys.rs + shortcut_conflicts.rs, enough to see every Settings state. */
function mockHotkeys(settings: Bindings, fnReady: boolean): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const key = (action: unknown) => `${String(action)}_hotkey` as keyof Bindings;
  const holder = (action: unknown, accel: string) => ACTIONS.find((other) => other !== action && !!accel && settings[key(other)] === accel);
  const validate = (accel: string) => {
    if (!accel || accel === 'Fn' || /^F([1-9]|1[0-2])$/.test(accel) || /(^|\+)(Cmd|Ctrl|Alt)\+/.test(accel)) return null;
    return { kind: 'needsModifier' };
  };
  const plan = (action: unknown, accel: string, swap: boolean) => {
    const refused = validate(accel);
    if (refused) return refused;
    const taken = holder(action, accel);
    if (taken) {
      if (!swap) return { kind: 'taken', by: taken };
      settings[key(taken)] = settings[key(action)];
    }
    settings[key(action)] = accel;
    return null;
  };
  return {
    check_hotkey: ({ action, accelerator }) => {
      const accel = String(accelerator);
      const taken = holder(action, accel);
      const refused = validate(accel) ?? (taken ? { kind: 'taken', by: taken } : null);
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
      settings.assistant_hotkey = DEFAULTS.assistant;
      return Promise.resolve(null);
    },
    get_hotkey_defaults: () => Promise.resolve(DEFAULTS),
    get_settings: () => Promise.resolve({ ...settings }),
    fn_status: () => Promise.resolve(fnReady ? { input_monitoring: true, globe_action: 'do_nothing' } : { input_monitoring: false, globe_action: 'emoji' }),
    suspend_hotkeys: ({ suspended }) => Promise.resolve(suspended === true && fnReady),
    machine_inventory: () => Promise.resolve(MACHINE),
    machine_clean: ({ worktrees }) => Promise.resolve((worktrees as string[]).map((path) => ({ target: path, ok: true, message: null, restore: `git -C '/Users/w/Developer/eavesy' worktree add '${path}' 'some-branch'` }))),
  };
}

/** Settings → This Mac (machine/mod.rs `Inventory`). */
const MACHINE = {
  repos: ['/Users/w/Developer/eavesy', '/Users/w/Developer/repackify'],
  worktrees: [
    { path: '/Users/w/Developer/eavesy/.claude/worktrees/agent-a2f49f3017eaff5e0', repo: '/Users/w/Developer/eavesy', branch: 'feat/agent-reply-suggestion', status: 'stale' },
    { path: '/private/tmp/eavesy-oxlint-pr', repo: '/Users/w/Developer/eavesy', branch: 'codex/oxlint-parity', status: 'stale' },
    { path: '/Users/w/Developer/eavesy/.claude/worktrees/sharp-hodgkin-5cf282', repo: '/Users/w/Developer/eavesy', branch: 'claude/machine-inventory', status: 'in_use' },
    { path: '/Users/w/Developer/repackify/.claude/worktrees/bol-timing', repo: '/Users/w/Developer/repackify', branch: 'claude/bol-timing', status: 'unmerged' },
    { path: '/Users/w/Developer/repackify/.claude/worktrees/wip', repo: '/Users/w/Developer/repackify', branch: 'claude/wip', status: 'dirty' },
  ],
  leftovers: [
    ...Array.from({ length: 98 }, (_, i) => ({ pid: 8000 + i, started_us: 1_792_000_000_000_000 + i, name: 'git', exe: '/opt/homebrew/Cellar/git/2.56.0_1/bin/git', cwd: '/Users/w', session_id: null, helpers: 0, ports: [] })),
    { pid: 4191, started_us: 1_792_000_000_000_000, name: 'node', exe: '/opt/homebrew/bin/node', cwd: '/Users/w/Developer/vinext/tests/fixtures/pages-i18n', session_id: 'abc', helpers: 2, ports: [4191] },
  ],
  zombies: [],
  ports: [
    { port: 4191, address: '127.0.0.1', pid: 4191, name: 'node', cwd: '/Users/w/Developer/vinext/tests/fixtures/pages-i18n', owner: 'leftover' },
    { port: 27925, address: '127.0.0.1', pid: 5100, name: 'convex-local-backend', cwd: '/Users/w/Developer/repackify/.claude/worktrees/lint-tooling', owner: 'session' },
    { port: 7265, address: '127.0.0.1', pid: 700, name: 'Raycast', cwd: '/', owner: 'other' },
  ],
};

/** eavesy.com's /api/me and /api/projects, enough to edit them in Settings. */
function mockAccount(noProjects: boolean, manyWords: boolean): (args: Record<string, unknown>) => unknown {
  const many = ['Anthropic', 'Cloudflare', 'Durable Objects', 'Vectorize', 'SpeechAnalyzer', 'ScreenCaptureKit', 'TanStack', 'Drizzle', 'Clerk', 'PostHog', 'Homebrew', 'notarytool', 'Sparkle', 'Rolldown', 'Vite', 'Zod', 'Tailwind', 'lucide', 'Bun', 'wrangler', 'Priya Raman', 'Dana Okafor', 'Mateo Silva', 'Kenji Ito', 'Aisha Khan', 'Lukas Weber'];
  const me = {
    spokenLanguages: ['en'],
    dictationStyle: 'concise',
    dictationForAgents: true,
    customVocabulary: manyWords
      ? Array.from({ length: 140 }, (_, i) => (i < many.length ? many[i] : `${many[i % many.length]} ${Math.floor(i / many.length) + 1}`))
      : ['Eavesy', 'Priya Raman', 'Kubernetes'],
  };
  let projects = noProjects ? [] : [
    { id: 'p-eavesy', name: 'eavesy', about: 'Mac meeting recorder', vocabulary: ['Tauri', 'D1', 'wrangler'], people: null, match: [], dictationStyle: 'concise', dictationForAgents: true, recordingCount: 12 },
    { id: 'p-acme', name: 'Acme redesign', about: null, vocabulary: [], people: null, match: ['acme'], recordingCount: 3 },
  ];
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'prompt';
  let prompts = [
    { id: 'prm-triage', name: 'Triage support tickets', slug: 'triage-support-tickets', body: 'Search through all the open support tickets, debug each one, and write a plan to fix them.\n\nThen implement the plan, one ticket at a time, with a test for each fix.', useCount: 14, lastUsedAt: Date.now() - 3_600_000, updatedAt: Date.now() },
    { id: 'prm-review', name: 'Review this PR', slug: 'review-this-pr', body: 'Review the current diff for bugs first, then simplifications. Focus on {{details}}.', useCount: 6, lastUsedAt: null, updatedAt: Date.now() },
  ];
  return ({ method, path, body }) => {
    const fields = (body ?? {}) as Record<string, unknown>;
    if (String(path).startsWith('/api/prompts')) {
      if (method === 'GET') return { items: prompts };
      if (method === 'POST') {
        const prompt = { id: `prm-${Date.now()}`, name: String(fields.name), slug: slug(String(fields.name)), body: String(fields.body), useCount: 0, lastUsedAt: null, updatedAt: Date.now() };
        prompts = [...prompts, prompt];
        return { prompt };
      }
      const id = String(path).split('/').pop();
      if (method === 'DELETE') { prompts = prompts.filter((p) => p.id !== id); return { ok: true }; }
      prompts = prompts.map((p) => p.id !== id ? p : fields.used
        ? { ...p, useCount: p.useCount + 1, lastUsedAt: Date.now() }
        : { ...p, ...fields, ...(fields.name ? { slug: slug(String(fields.name)) } : {}), updatedAt: Date.now() });
      return { prompt: prompts.find((p) => p.id === id) };
    }
    if (path === '/api/me') return method === 'GET' ? me : Object.assign(me, fields) && { ok: true };
    if (path === '/api/projects' && method === 'GET') return { items: projects };
    if (path === '/api/projects' && method === 'POST') {
      const project = { id: `p-${Date.now()}`, name: String(fields.name), about: null, vocabulary: [], people: null, match: [], recordingCount: 0 };
      projects = [...projects, project];
      return { project };
    }
    const id = String(path).split('/').pop();
    if (method === 'DELETE') projects = projects.filter((p) => p.id !== id);
    else projects = projects.map((p) => (p.id === id ? { ...p, ...fields } : p));
    return { ok: true };
  };
}

/** Eavesy's tab (assistant/thread.rs and assistant/mod.rs), with a card waiting. */
function assistantMock(empty: boolean, emit: (event: string, payload: unknown) => void): Record<string, unknown> {
  const now = Date.now();
  const thread = {
    busy: false,
    turns: empty ? [] : [
      { id: 0, who: 'you', spoken: true, at_ms: now - 60_000, text: 'Which of my Claude sessions are still running from yesterday?', steps: [] },
      { id: 1, who: 'eavesy', spoken: false, at_ms: now - 55_000, text: 'Two dev servers outlived their sessions, both in worktrees you already merged: hud-fix and settings-race. Want me to show them out?', steps: [{ tool: 'machine_overview', line: '2 stale worktrees, 2 leftover processes', ok: true }] },
      { id: 3, who: 'you', spoken: false, at_ms: now - 30_000, text: 'Yes, and clear out their worktrees.', steps: [] },
      { id: 4, who: 'eavesy', spoken: false, at_ms: now - 28_000, text: 'It’s on the card below. Untick anything you want to keep.', steps: [{ tool: 'clean_machine', line: 'Waiting for your click', ok: true }] },
      { id: 5, who: 'you', spoken: false, at_ms: now - 20_000, text: 'Remember that I use bun, not npm.', steps: [] },
      { id: 6, who: 'eavesy', spoken: false, at_ms: now - 18_000, text: 'Noted.', steps: [{ tool: 'remember', line: 'Remembered: Uses bun, not npm', ok: true, remembered: 'Uses bun, not npm' }] },
    ],
  };
  let notes = empty ? [] : ['Uses bun, not npm', 'Ships risky changes behind a flag', 'Robin reviews PRs in the afternoon'];
  let memoryOn = true;
  const state = {
    mode: 'ask', effective: 'ask', until_ms: null as number | null, trusted_folders: [] as string[], tampered: false,
    cards: empty ? [] : [{
      id: 'card-1', requester: 'You', tool: 'machine.clean', title: 'Remove 2 worktrees and stop 2 leftover processes', warning: null, expires_ms: now + 300_000,
      rows: [
        { id: 'worktree:/Users/w/Developer/eavesy/.claude/worktrees/hud-fix', label: 'Remove worktree ~/Developer/eavesy/.claude/worktrees/hud-fix · claude/hud-fix, merged' },
        { id: 'worktree:/Users/w/Developer/eavesy/.claude/worktrees/settings-race', label: 'Remove worktree ~/Developer/eavesy/.claude/worktrees/settings-race · claude/settings-race, merged' },
        { id: 'process:4191:1', label: 'Stop node (pid 4191) in ~/Developer/eavesy/.claude/worktrees/hud-fix/web · port 5173' },
        { id: 'process:4207:1', label: 'Stop node (pid 4207) in ~/Developer/eavesy/.claude/worktrees/settings-race/web · port 5174' },
      ],
    }],
  };
  return {
    assistant_thread: () => thread,
    assistant_state: () => ({ ...state }),
    assistant_send: ({ text }: Record<string, unknown>) => {
      thread.turns.push({ id: thread.turns.length * 2, who: 'you', spoken: false, at_ms: Date.now(), text: String(text), steps: [] });
      thread.busy = true;
      emit('assistant:thread', { ...thread });
      return new Promise((resolve) => setTimeout(() => {
        thread.turns.push({ id: thread.turns.length * 2 + 1, who: 'eavesy', spoken: false, at_ms: Date.now(), text: 'Quiet on my end. Nothing else is waiting on you.', steps: [{ tool: 'agent_sessions', line: '3 sessions', ok: true }] });
        thread.busy = false;
        emit('assistant:thread', { ...thread });
        resolve(null);
      }, 1200));
    },
    assistant_clear: () => { thread.turns = []; emit('assistant:thread', { ...thread }); },
    assistant_card_decide: ({ cardId, acceptedRowIds }: Record<string, unknown>) => {
      state.cards = state.cards.filter((card) => card.id !== cardId);
      emit('assistant:cards', state.cards);
      const count = (acceptedRowIds as string[]).length;
      return count ? { summary: `${count} of ${count} done`, detail: null } : null;
    },
    set_assistant_mode: ({ mode, minutes }: Record<string, unknown>) => {
      state.mode = String(mode);
      state.effective = String(mode);
      state.until_ms = typeof minutes === 'number' && mode !== 'ask' ? Date.now() + minutes * 60_000 : null;
    },
    set_trusted_agent_folders: ({ folders }: Record<string, unknown>) => (state.trusted_folders = folders as string[]),
    set_assistant_style: () => null,
    assistant_memory: () => ({ on: memoryOn, notes: [...notes], path: '/Users/w/Eavesy/assistant/memory.md' }),
    assistant_forget: ({ note }: Record<string, unknown>) => { notes = notes.filter((kept) => kept !== note); },
    assistant_forget_all: () => { notes = []; },
    set_assistant_memory: ({ on }: Record<string, unknown>) => { memoryOn = on === true; },
    open_assistant_memory: () => null,
    set_assistant_voice: () => null,
    assistant_voices: () => [
      { name: 'Samantha', locale: 'en_US' }, { name: 'Daniel', locale: 'en_GB' }, { name: 'Eddy (English (US))', locale: 'en_US' }, { name: 'Thomas', locale: 'fr_FR' },
    ],
    assistant_activity: () => empty ? [] : [
      { at_ms: now - 25_000, requester: 'You', tool: 'machine.clean', summary: 'Remove 2 worktrees and stop 2 leftover processes', decision: 'accepted', outcome: '4 of 4 done' },
      { at_ms: now - 3_600_000, requester: 'Claude Code in eavesy', tool: 'open.link', summary: 'Open https://example.com/pricing', decision: 'refused', outcome: 'Only links you gave' },
      { at_ms: now - 7_200_000, requester: 'You', tool: 'assistant.mode', summary: 'Auto', decision: 'ran', outcome: 'for 60 min' },
    ],
  };
}
