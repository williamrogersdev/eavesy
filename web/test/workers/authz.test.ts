/// <reference types="vite/client" />
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handlersOf,
  insertDeviceActor,
  insertMeeting,
  insertUser,
  requestBody,
  resetTables,
  row,
  testEnv,
  type RouteHandler,
} from './support';

/**
 * Authorization coverage for every API route, generated from the route files.
 *
 * Each handler gets two checks where they apply:
 * - with no credentials it answers 401 (or its documented equivalent) before
 *   reading the body, so a malformed request can't tell it apart from a valid one;
 * - signed in as another user, it can't read, change, or list the owner's data.
 *
 * A route file or method missing from POLICIES fails the suite, so a new
 * route can't ship without deciding who may call it.
 */

const actor = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
  tryResolveActor: async () => (actor.userId ? { userId: actor.userId, isAnonymous: false } : null),
}));

// Owners' calls get through to the model; answer locally instead of calling out.
vi.mock('../../src/lib/ai/chat-meeting', () => ({ chatWithMeeting: async () => 'Stub reply' }));
vi.mock('../../src/lib/ai/summarize', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  summarizeMeeting: async () => ({
    title: 'Stub',
    description: '',
    tldr: 'Stub',
    decisions: [],
    actionItems: [],
    followUps: [],
    openQuestions: [],
    topics: [],
    mentions: [],
  }),
}));

const routeModules = import.meta.glob<{ Route: { options: unknown } }>('../../src/routes/api/**/*.ts', { eager: true });

const OWNER = 'user_owner';
const OTHER = 'user_other';
const MEETING = 'meet_owner';
const RECORDING = 'meet_owner_recording';
const LINE = 'line_owner';
const CAPTURE = 'cap_owner';
const TEMPLATE = 'tpl_owner';
const MCP_TOKEN = 'mcp_owner';
const DICTATION = 'dict_owner';
const AUDIO_KEY = `users/${OWNER}/meetings/${MEETING}/audio.m4a`;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Call {
  path: string;
  params?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

/** What another signed-in user sees when they aim at the owner's data. */
type CrossUser =
  | { call: Call; status: number }
  | { call: Call; unchanged: () => Promise<unknown> }
  | { call: Call; excludes: string[] };

type Policy =
  | { public: string }
  | { unauthenticated: { status: number; call?: Call }; crossUser?: CrossUser; scopedToCaller?: string };

const json = (body: unknown) => body;
const meetingCall = (suffix = '', body?: unknown): Call => ({
  path: `/api/meetings/${MEETING}${suffix}`,
  params: { id: MEETING },
  body,
});

const SIGNED_IN = { status: 401 };

const POLICIES: Record<string, Partial<Record<Method, Policy>>> = {
  '/api/account/': {
    DELETE: { unauthenticated: SIGNED_IN, scopedToCaller: 'deletes only the caller’s account' },
  },
  '/api/account/export': {
    GET: { unauthenticated: SIGNED_IN, scopedToCaller: 'exports only the caller’s data' },
  },
  '/api/audio/$': {
    GET: {
      unauthenticated: { status: 401, call: { path: `/api/audio/${AUDIO_KEY}`, params: { _splat: AUDIO_KEY } } },
      crossUser: { call: { path: `/api/audio/${AUDIO_KEY}`, params: { _splat: AUDIO_KEY } }, status: 403 },
    },
  },
  '/api/authcheck': { GET: { public: 'Sign-in diagnostic: reports only whether the caller’s own session is valid' } },
  '/api/captures': {
    GET: { unauthenticated: SIGNED_IN, crossUser: { call: { path: '/api/captures' }, excludes: [CAPTURE] } },
    POST: { unauthenticated: SIGNED_IN, scopedToCaller: 'creates a capture owned by the caller' },
  },
  '/api/captures/$id': {
    GET: {
      unauthenticated: SIGNED_IN,
      crossUser: { call: { path: `/api/captures/${CAPTURE}`, params: { id: CAPTURE } }, status: 404 },
    },
    DELETE: {
      unauthenticated: SIGNED_IN,
      crossUser: { call: { path: `/api/captures/${CAPTURE}`, params: { id: CAPTURE } }, status: 404 },
    },
  },
  '/api/connections/openrouter': {
    GET: { unauthenticated: { status: 302 }, scopedToCaller: 'starts OAuth for the caller' },
    DELETE: { unauthenticated: SIGNED_IN, scopedToCaller: 'disconnects only the caller' },
  },
  '/api/connections/openrouter/callback': {
    GET: { unauthenticated: { status: 302 }, scopedToCaller: 'stores the key on the caller' },
  },
  '/api/contact': { POST: { public: 'Public contact form, rate limited per IP' } },
  '/api/devices/me': {
    GET: { unauthenticated: SIGNED_IN, scopedToCaller: 'describes the calling device' },
    DELETE: { unauthenticated: SIGNED_IN, scopedToCaller: 'signs out the calling device' },
  },
  '/api/devices/pair': {
    GET: { unauthenticated: SIGNED_IN, scopedToCaller: 'checks a code the caller holds' },
    POST: { unauthenticated: SIGNED_IN, scopedToCaller: 'pairs a device to the caller' },
  },
  '/api/devices/pair/start': { POST: { public: 'Called by an unpaired Mac; issues a short-lived code, rate limited per IP' } },
  '/api/devices/pair/status': {
    POST: { public: 'Polled by the unpaired Mac; needs the code and its device id, rate limited per IP' },
  },
  '/api/dictations': {
    GET: { unauthenticated: SIGNED_IN, crossUser: { call: { path: '/api/dictations' }, excludes: [DICTATION] } },
    POST: { unauthenticated: SIGNED_IN, scopedToCaller: 'creates a dictation owned by the caller' },
  },
  '/api/downloads/mac/latest': { GET: { public: 'Public app download' } },
  '/api/downloads/mac/update/$file': { GET: { public: 'Public app update artifacts' } },
  '/api/export/$id/zip': {
    GET: {
      unauthenticated: SIGNED_IN,
      crossUser: { call: { path: `/api/export/${MEETING}/zip`, params: { id: MEETING } }, status: 404 },
    },
  },
  '/api/mcp-tokens': {
    GET: { unauthenticated: SIGNED_IN, crossUser: { call: { path: '/api/mcp-tokens' }, excludes: [MCP_TOKEN] } },
    POST: { unauthenticated: SIGNED_IN, scopedToCaller: 'mints a token for the caller' },
    DELETE: {
      unauthenticated: SIGNED_IN,
      crossUser: {
        call: { path: '/api/mcp-tokens', body: json({ id: MCP_TOKEN }) },
        unchanged: () => row('SELECT revoked_at FROM mcp_tokens WHERE id = ?', MCP_TOKEN),
      },
    },
  },
  '/api/me': {
    GET: { unauthenticated: SIGNED_IN, crossUser: { call: { path: '/api/me' }, excludes: [OWNER] } },
    PATCH: {
      unauthenticated: SIGNED_IN,
      crossUser: {
        call: { path: '/api/me', body: json({ displayName: 'Renamed' }) },
        unchanged: () => row('SELECT display_name FROM users WHERE id = ?', OWNER),
      },
    },
  },
  '/api/media/$': {
    GET: {
      unauthenticated: { status: 401, call: { path: `/api/media/${AUDIO_KEY}`, params: { _splat: AUDIO_KEY } } },
      crossUser: { call: { path: `/api/media/${AUDIO_KEY}`, params: { _splat: AUDIO_KEY } }, status: 403 },
    },
  },
  '/api/meetings/$id': {
    GET: { unauthenticated: SIGNED_IN, crossUser: { call: meetingCall(), status: 404 } },
    PATCH: { unauthenticated: SIGNED_IN, crossUser: { call: meetingCall('', { title: 'Mine now' }), status: 404 } },
    DELETE: { unauthenticated: SIGNED_IN, crossUser: { call: meetingCall(), status: 404 } },
  },
  '/api/meetings/$id/brief': {
    PATCH: { unauthenticated: SIGNED_IN, crossUser: { call: meetingCall('/brief', { contentMd: '# Mine' }), status: 404 } },
    DELETE: { unauthenticated: SIGNED_IN, crossUser: { call: meetingCall('/brief'), status: 404 } },
  },
  '/api/meetings/$id/chat': {
    POST: {
      unauthenticated: SIGNED_IN,
      crossUser: { call: meetingCall('/chat', { messages: [{ role: 'user', content: 'Summarise' }] }), status: 404 },
    },
  },
  '/api/meetings/$id/copy': { POST: { unauthenticated: SIGNED_IN, crossUser: { call: meetingCall('/copy', {}), status: 404 } } },
  '/api/meetings/$id/lines/$lineId': {
    PATCH: {
      unauthenticated: SIGNED_IN,
      crossUser: { call: lineCall({ text: 'Rewritten' }), status: 404 },
    },
    DELETE: { unauthenticated: SIGNED_IN, crossUser: { call: lineCall(), status: 404 } },
    POST: {
      unauthenticated: SIGNED_IN,
      crossUser: { call: lineCall({ startMs: 0, endMs: 1, speakerId: null, text: 'Restored' }), status: 404 },
    },
  },
  '/api/meetings/$id/transcript': {
    GET: { unauthenticated: SIGNED_IN, crossUser: { call: meetingCall('/transcript'), status: 404 } },
  },
  '/api/meetings/$id/regenerate': {
    POST: { unauthenticated: SIGNED_IN, crossUser: { call: meetingCall('/regenerate', {}), status: 404 } },
  },
  '/api/meetings/list': {
    GET: { unauthenticated: SIGNED_IN, crossUser: { call: { path: '/api/meetings/list' }, excludes: [MEETING, RECORDING] } },
  },
  '/api/meetings/start': { POST: { unauthenticated: SIGNED_IN, scopedToCaller: 'starts a meeting owned by the caller' } },
  '/api/notes': {
    POST: {
      unauthenticated: SIGNED_IN,
      crossUser: { call: { path: '/api/notes', body: json({ meetingId: MEETING, contentMd: 'Mine' }) }, status: 404 },
    },
  },
  '/api/onboarding/complete': { POST: { unauthenticated: SIGNED_IN, scopedToCaller: 'updates the caller' } },
  '/api/ops/metrics': {
    GET: { unauthenticated: SIGNED_IN, scopedToCaller: 'operator bearer token; aggregate counts only' },
  },
  '/api/process-recording': {
    POST: { unauthenticated: SIGNED_IN, scopedToCaller: 'creates a meeting owned by the caller' },
  },
  '/api/search': {
    GET: {
      unauthenticated: SIGNED_IN,
      // Matches the seeded meeting's title lexically; vectors are filtered by userId.
      crossUser: { call: { path: '/api/search?q=Test' }, excludes: [MEETING] },
    },
  },
  '/api/sessions/$id/files': {
    PATCH: {
      unauthenticated: SIGNED_IN,
      crossUser: {
        call: {
          path: `/api/sessions/${MEETING}/files`,
          params: { id: MEETING },
          body: json({ role: 'summary', contentMd: '# Mine', contentHash: 'a'.repeat(64) }),
        },
        status: 404,
      },
    },
  },
  '/api/sessions/$id/finalize/': {
    POST: {
      unauthenticated: SIGNED_IN,
      crossUser: {
        call: { path: `/api/sessions/${RECORDING}/finalize`, params: { id: RECORDING }, body: new Uint8Array([1, 2, 3]) },
        status: 404,
      },
    },
  },
  '/api/sessions/$id/': {
    GET: { unauthenticated: SIGNED_IN, crossUser: { call: { path: `/api/sessions/${RECORDING}`, params: { id: RECORDING } }, status: 404 } },
  },
  '/api/sessions/$id/parts/$n': {
    PUT: {
      unauthenticated: SIGNED_IN,
      crossUser: {
        call: {
          path: `/api/sessions/${RECORDING}/parts/1`,
          params: { id: RECORDING, n: '1' },
          // Parts must declare exactly 8 MiB; ownership is checked before the body is read.
          headers: { 'content-length': String(8 * 1024 * 1024) },
        },
        status: 404,
      },
    },
  },
  '/api/sessions/$id/result': {
    GET: { unauthenticated: SIGNED_IN, crossUser: { call: { path: `/api/sessions/${MEETING}/result`, params: { id: MEETING } }, status: 404 } },
  },
  '/api/sessions/$id/transcript': {
    GET: { unauthenticated: SIGNED_IN, crossUser: { call: { path: `/api/sessions/${MEETING}/transcript`, params: { id: MEETING } }, status: 404 } },
  },
  '/api/sessions/$id/segments/$idx': {
    PUT: {
      unauthenticated: SIGNED_IN,
      crossUser: {
        call: {
          path: `/api/sessions/${RECORDING}/segments/0`,
          params: { id: RECORDING, idx: '0' },
          body: new Uint8Array([1, 2, 3]),
          headers: { 'x-segment-duration-ms': '3000', 'x-segment-start-ms': '0', 'content-type': 'audio/mp4' },
        },
        status: 404,
      },
    },
  },
  '/api/sessions/': { POST: { unauthenticated: SIGNED_IN, scopedToCaller: 'creates a session owned by the caller' } },
  '/api/templates': {
    GET: { unauthenticated: SIGNED_IN, crossUser: { call: { path: '/api/templates' }, excludes: [TEMPLATE] } },
    POST: { unauthenticated: SIGNED_IN, scopedToCaller: 'creates a template owned by the caller' },
    PATCH: {
      unauthenticated: SIGNED_IN,
      crossUser: {
        call: { path: '/api/templates', body: json({ id: TEMPLATE, name: 'Mine now' }) },
        unchanged: () => row('SELECT name, system_prompt FROM prompt_templates WHERE id = ?', TEMPLATE),
      },
    },
    DELETE: {
      unauthenticated: SIGNED_IN,
      crossUser: {
        call: { path: `/api/templates?id=${TEMPLATE}` },
        unchanged: () => row('SELECT id FROM prompt_templates WHERE id = ?', TEMPLATE),
      },
    },
  },
  '/api/transcribe': { POST: { unauthenticated: SIGNED_IN, scopedToCaller: 'transcribes the caller’s upload; nothing is stored' } },
  '/api/updates/$target/$arch/$version': { GET: { public: 'Public updater manifest' } },
};

function lineCall(body?: unknown): Call {
  return { path: `/api/meetings/${MEETING}/lines/${LINE}`, params: { id: MEETING, lineId: LINE }, body };
}

interface Discovered {
  file: string;
  routeId: string;
  method: Method;
  handler: RouteHandler;
}

const discovered: Discovered[] = Object.entries(routeModules).flatMap(([file, module]) => {
  const routeId = (module.Route.options as { path?: string }).path ?? routeIdFromFile(file);
  return Object.entries(handlersOf(module.Route)).flatMap(([method, handler]) =>
    handler ? [{ file, routeId, method: method as Method, handler }] : [],
  );
});

function routeIdFromFile(file: string): string {
  return file.replace('../../src/routes', '').replace(/\.ts$/, '').replace(/\/index$/, '/');
}

function request(method: Method, call: Call): Request {
  const body = method === 'GET' ? undefined : call.body;
  const bytes = body instanceof Uint8Array ? body : null;
  const isJson = body !== undefined && !bytes;
  return new Request(`https://eavesy.test${call.path}`, {
    method,
    headers: {
      ...(isJson ? { 'content-type': 'application/json' } : {}),
      ...(bytes ? { 'content-length': String(bytes.byteLength) } : {}),
      ...call.headers,
    },
    // A string is sent as-is so tests can send malformed JSON.
    body: bytes ? requestBody(bytes) : typeof body === 'string' ? body : isJson ? JSON.stringify(body) : undefined,
  });
}

function defaultCall(routeId: string): Call {
  const params: Record<string, string> = {};
  const path = routeId.replace(/\$(\w+)|\$$/g, (_, name: string | undefined) => {
    const key = name ?? '_splat';
    params[key] = key === '_splat' ? 'users/someone/file.m4a' : 'x1';
    return params[key];
  });
  return { path, params };
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  actor.userId = null;
  // rate_limits only exists once the rate-limit migration has landed.
  await testEnv.DB.prepare('DELETE FROM rate_limits').run().catch(() => undefined);
  await resetTables(
    'transcript_segments',
    'meeting_segments',
    'summaries',
    'user_notes',
    'captures',
    'dictations',
    'prompt_templates',
    'mcp_tokens',
    'activity_log',
    'meetings',
    'device_pairing_codes',
    'device_tokens',
    'devices',
    'users',
  );
  await seedOwner();
});

async function seedOwner() {
  const now = Date.now();
  await insertDeviceActor(OWNER, 'device_owner');
  await insertUser(OTHER);
  await insertMeeting({ id: MEETING, userId: OWNER, status: 'complete', audioR2Key: AUDIO_KEY });
  await insertMeeting({ id: RECORDING, userId: OWNER, status: 'recording' });
  await testEnv.AUDIO_BUCKET.put(AUDIO_KEY, new Uint8Array([1, 2, 3]));
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, text, is_final, is_edited)
       VALUES (?, ?, 0, 1000, 'Owner line', 1, 0)`,
    ).bind(LINE, MEETING),
    testEnv.DB.prepare(
      `INSERT INTO captures (id, user_id, kind, capture_mode, title, r2_key, content_type, bytes, created_at, updated_at)
       VALUES (?, ?, 'image', 'screenshot', 'Owner capture', ?, 'image/png', 3, ?, ?)`,
    ).bind(CAPTURE, OWNER, `users/${OWNER}/captures/${CAPTURE}.png`, now, now),
    testEnv.DB.prepare(
      `INSERT INTO prompt_templates (id, user_id, name, system_prompt, applies_to, sort_order)
       VALUES (?, ?, 'Owner template', 'Owner prompt', 'meeting', 0)`,
    ).bind(TEMPLATE, OWNER),
    testEnv.DB.prepare(
      `INSERT INTO dictations (id, user_id, title, transcript, duration_sec, created_at)
       VALUES (?, ?, 'Owner dictation', 'Owner words', 3, ?)`,
    ).bind(DICTATION, OWNER, now),
    testEnv.DB.prepare(
      `INSERT INTO mcp_tokens (id, user_id, token_hash, name, created_at) VALUES (?, ?, 'hash_owner', 'Owner', ?)`,
    ).bind(MCP_TOKEN, OWNER, now),
  ]);
}

describe('API authorization coverage', () => {
  it('has a policy for every route and method', () => {
    expect(discovered.length).toBeGreaterThan(40);
    const missing = discovered
      .filter(({ routeId, method }) => !POLICIES[routeId]?.[method])
      .map(({ routeId, method, file }) => `${method} ${routeId} (${file})`);
    expect(missing).toEqual([]);
  });

  it('has no policy for a route or method that no longer exists', () => {
    const live = new Set(discovered.map(({ routeId, method }) => `${method} ${routeId}`));
    const stale = Object.entries(POLICIES).flatMap(([routeId, methods]) =>
      Object.keys(methods).map((method) => `${method} ${routeId}`).filter((key) => !live.has(key)),
    );
    expect(stale).toEqual([]);
  });
});

describe.each(discovered.filter(({ routeId, method }) => POLICIES[routeId]?.[method]))(
  '$method $routeId',
  ({ routeId, method, handler }) => {
    const policy = POLICIES[routeId][method]!;
    if ('public' in policy) {
      it.skip(`is public: ${policy.public}`, () => undefined);
      return;
    }

    it(`answers ${policy.unauthenticated.status} without credentials, before reading the body`, async () => {
      const call = policy.unauthenticated.call ?? defaultCall(routeId);
      const body = method === 'GET' ? undefined : (call.body ?? '{not json');
      const response = await handler({
        request: request(method, { ...call, body }),
        params: call.params ?? {},
      });
      expect(response.status).toBe(policy.unauthenticated.status);
    });

    const crossUser = policy.crossUser;
    if (!crossUser) return;

    // Positive control: the owner making the same call gets through, so the
    // other user's 404 comes from ownership, not from a fixture that doesn't fit.
    it('lets the owner make the same call', async () => {
      const before = 'unchanged' in crossUser ? await crossUser.unchanged() : null;
      actor.userId = OWNER;
      const response = await handler({ request: request(method, crossUser.call), params: crossUser.call.params ?? {} });
      const text = 'excludes' in crossUser ? await response.text() : (await response.arrayBuffer(), '');
      expect({ status: response.status, body: text.slice(0, 300) }).toMatchObject({
        status: expect.toSatisfy((status: number) => status >= 200 && status < 300) as number,
      });
      if ('unchanged' in crossUser) expect(await crossUser.unchanged()).not.toEqual(before);
      if ('excludes' in crossUser) for (const id of crossUser.excludes) expect(text).toContain(id);
    });
    it('does not expose or change another user’s data', async () => {
      const before = 'unchanged' in crossUser ? await crossUser.unchanged() : null;
      actor.userId = OTHER;
      const response = await handler({ request: request(method, crossUser.call), params: crossUser.call.params ?? {} });
      if ('status' in crossUser) expect(response.status).toBe(crossUser.status);
      if ('unchanged' in crossUser) expect(await crossUser.unchanged()).toEqual(before);
      if ('excludes' in crossUser) {
        expect(response.status).toBe(200);
        const text = await response.text();
        for (const id of crossUser.excludes) expect(text).not.toContain(id);
      }
    });
  },
);
