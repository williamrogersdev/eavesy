import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { worker as mcpWorker } from '../../../workers/mcp/src/index';
import { Route as McpTokensRoute } from '../../src/routes/api/mcp-tokens';
import { MCP_TOKEN_TTL_MS } from '../../src/server/mcp-token-policy';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../../src/db/schema';
import { pollForDevice, resolveForDevice } from '../../src/server/agent-inbox';

interface TestEnv {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
type RouteHandler = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>;
const tokensRoute = (method: string) =>
  (McpTokensRoute.options as unknown as { server: { handlers: Record<string, RouteHandler> } }).server.handlers[method];

const actor = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
  tryResolveActor: async () => (actor.userId ? { userId: actor.userId, isAnonymous: false } : null),
}));

const mcpEnv = (vars: Record<string, string> = {}) =>
  ({ DB: testEnv.DB, AI: {}, VECTORIZE: {}, ...vars }) as unknown as Parameters<typeof mcpWorker.fetch>[1];

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  actor.userId = 'user_mcp';
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM mcp_tokens'),
    testEnv.DB.prepare('DELETE FROM users'),
  ]);
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO users (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at)
     VALUES ('user_mcp', 'whisper', 'en', 0, ?, ?)`,
  )
    .bind(now, now)
    .run();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mint(
  scopes?: string[],
): Promise<{ id: string; token: string; serverUrl: string; expiresAt: number; scopes: string[] }> {
  const response = await tokensRoute('POST')({
    request: new Request('https://eavesy.test/api/mcp-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Claude', ...(scopes ? { scopes } : {}) }),
    }),
    params: {},
  });
  expect(response.status).toBe(201);
  return response.json();
}

const toolsList = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const call = (url: string, headers: Record<string, string> = {}, vars: Record<string, string> = {}) =>
  mcpWorker.fetch(
    new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: toolsList }),
    mcpEnv(vars),
  );
const expiresAt = async () =>
  (await testEnv.DB.prepare('SELECT expires_at FROM mcp_tokens').first<{ expires_at: number }>())?.expires_at;

describe('MCP tokens', () => {
  it('are minted with a 90-day expiry that settings can show', async () => {
    const before = Date.now();
    const minted = await mint();
    expect(minted.serverUrl).toBe('https://mcp.eavesy.com');
    expect(minted.token).toMatch(/^nt_/);
    expect(minted.expiresAt).toBeGreaterThanOrEqual(before + MCP_TOKEN_TTL_MS);
    expect(minted.expiresAt).toBeLessThanOrEqual(Date.now() + MCP_TOKEN_TTL_MS);

    const listed = await (await tokensRoute('GET')({ request: new Request('https://eavesy.test/api/mcp-tokens'), params: {} })).json();
    expect(listed).toEqual([expect.objectContaining({ id: minted.id, expiresAt: minted.expiresAt, usesLegacyUrl: false })]);
  });

  it('authenticate from the Authorization header', async () => {
    const { token } = await mint();
    expect((await call('https://mcp.eavesy.com/', { authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await call('https://mcp.eavesy.com/', { authorization: `bearer ${token}` })).status).toBe(200);
    expect((await call('https://mcp.eavesy.com/', { authorization: 'Bearer nt_wrong' })).status).toBe(401);
  });

  it('still authenticate from the URL path during the deprecation window, and say so', async () => {
    const { id, token } = await mint();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const response = await call(`https://mcp.eavesy.com/${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('deprecation')).toBe('true');
    const logged = warn.mock.calls.map((args) => String(args[0])).join('\n');
    expect(logged).toContain('mcp token sent in URL path');
    expect(logged).toContain(id);
    expect(logged).not.toContain(token);

    const listed = await (await tokensRoute('GET')({ request: new Request('https://eavesy.test/api/mcp-tokens'), params: {} })).json();
    expect(listed).toEqual([expect.objectContaining({ id, usesLegacyUrl: true })]);
  });

  it('stop authenticating from the URL path once MCP_ALLOW_PATH_TOKENS is false', async () => {
    const { token } = await mint();
    const off = { MCP_ALLOW_PATH_TOKENS: 'false' };
    const response = await call(`https://mcp.eavesy.com/${token}`, {}, off);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'token must be sent in the Authorization header' });
    expect((await call('https://mcp.eavesy.com/', { authorization: `Bearer ${token}` }, off)).status).toBe(200);
  });

  it('slide their expiry forward on use, at most once a day', async () => {
    const { token } = await mint();
    const soon = Date.now() + 10 * 24 * 60 * 60 * 1000;
    await testEnv.DB.prepare('UPDATE mcp_tokens SET expires_at = ?').bind(soon).run();
    const before = Date.now();
    expect((await call('https://mcp.eavesy.com/', { authorization: `Bearer ${token}` })).status).toBe(200);
    const renewed = await expiresAt();
    expect(renewed).toBeGreaterThanOrEqual(before + MCP_TOKEN_TTL_MS);

    // Renewed an hour ago: a use now doesn't write again.
    const recent = Date.now() + MCP_TOKEN_TTL_MS - 60 * 60 * 1000;
    await testEnv.DB.prepare('UPDATE mcp_tokens SET expires_at = ?, last_used_at = ?').bind(recent, Date.now()).run();
    expect((await call('https://mcp.eavesy.com/', { authorization: `Bearer ${token}` })).status).toBe(200);
    expect(await expiresAt()).toBe(recent);
  });

  it('count against the rate limit only once the token is known to be valid', async () => {
    const { id, token } = await mint();
    await testEnv.DB.prepare('DELETE FROM rate_limits').run();
    await testEnv.DB.prepare('UPDATE mcp_tokens SET expires_at = ?').bind(Date.now() - 1).run();
    expect((await call('https://mcp.eavesy.com/', { authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await call('https://mcp.eavesy.com/', { authorization: 'Bearer nt_wrong' })).status).toBe(401);
    const counted = () => testEnv.DB.prepare("SELECT key FROM rate_limits WHERE key LIKE 'mcp:%'").all<{ key: string }>();
    expect((await counted()).results).toEqual([]);

    await testEnv.DB.prepare('UPDATE mcp_tokens SET expires_at = ?').bind(Date.now() + MCP_TOKEN_TTL_MS).run();
    expect((await call('https://mcp.eavesy.com/', { authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await counted()).results.map((row) => row.key.split(':').slice(0, 2).join(':'))).toEqual([`mcp:${id}`]);
  });

  it('are refused once expired', async () => {
    const { token } = await mint();
    await testEnv.DB.prepare('UPDATE mcp_tokens SET expires_at = ?').bind(Date.now() - 1).run();
    const response = await call('https://mcp.eavesy.com/', { authorization: `Bearer ${token}` });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'token expired' });
  });

  it('created before expiry existed get 90 days from their creation', async () => {
    const { token } = await mint();
    await testEnv.DB.prepare('UPDATE mcp_tokens SET expires_at = NULL, created_at = ?')
      .bind(Date.now() - MCP_TOKEN_TTL_MS - 1)
      .run();
    expect((await call('https://mcp.eavesy.com/', { authorization: `Bearer ${token}` })).status).toBe(401);
  });
});

describe('MCP scopes', () => {
  const rpc = async (token: string, method: string, params?: unknown) =>
    (await mcpWorker.fetch(
      new Request('https://mcp.eavesy.com/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
      mcpEnv(),
    )).json<{ result?: { tools?: { name: string; scope?: string }[]; isError?: boolean; content?: { text: string }[] } }>();
  const storedScopes = async () =>
    (await testEnv.DB.prepare('SELECT scopes_json FROM mcp_tokens').first<{ scopes_json: string }>())?.scopes_json;

  it('are read-only unless writes are asked for, and read is always included', async () => {
    const readOnly = await mint();
    expect(readOnly.scopes).toEqual(['read']);
    expect(await storedScopes()).toBe('["read"]');

    await testEnv.DB.prepare('DELETE FROM mcp_tokens').run();
    const writer = await mint(['write']);
    expect(writer.scopes).toEqual(['read', 'write']);
    expect(await storedScopes()).toBe('["read","write"]');
    const listed = await (await tokensRoute('GET')({ request: new Request('https://eavesy.test/api/mcp-tokens'), params: {} })).json();
    expect(listed).toEqual([expect.objectContaining({ id: writer.id, scopes: ['read', 'write'] })]);
  });

  it('reject unknown scopes when minting', async () => {
    const response = await tokensRoute('POST')({
      request: new Request('https://eavesy.test/api/mcp-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Claude', scopes: ['admin'] }),
      }),
      params: {},
    });
    expect(response.status).toBe(400);
  });

  it('list the tools a read connection may call, without the scope field', async () => {
    const { token } = await mint();
    const tools = (await rpc(token, 'tools/list')).result?.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([
      'send_to_human',
      'ask_human',
      'report_feedback',
      'search',
      'recent',
      'get',
      'search_library',
      'ask_library',
      'search_meetings',
      'get_meeting',
      'recent_meetings',
      'list_projects',
      'search_dictations',
      'get_action_items',
      'get_account_info',
      'sign_out',
    ]);
    expect(tools.every((tool) => tool.scope === undefined)).toBe(true);
  });

  it('hide and refuse tools outside the connection’s scopes', async () => {
    const { token } = await mint();
    await testEnv.DB.prepare(`UPDATE mcp_tokens SET scopes_json = '["write"]'`).run();
    expect((await rpc(token, 'tools/list')).result?.tools?.map((tool) => tool.name)).toEqual([
      'send_to_my_devices',
      'save_note',
      'update_action_item',
      'set_project',
      'rename',
    ]);
    const refused = (await rpc(token, 'tools/call', { name: 'recent_meetings', arguments: {} })).result;
    expect(refused?.isError).toBe(true);
    expect(refused?.content?.[0]?.text).toContain('needs read access');
  });

  it('treat an unreadable scopes value as read-only', async () => {
    const { token } = await mint(['write']);
    await testEnv.DB.prepare(`UPDATE mcp_tokens SET scopes_json = 'oops'`).run();
    expect((await rpc(token, 'tools/list')).result?.tools?.length).toBe(16);
  });
});

describe('MCP account tools', () => {
  const rpc = async (token: string, method: string, params?: unknown) =>
    (await mcpWorker.fetch(
      new Request('https://mcp.eavesy.com/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
      mcpEnv(),
    )).json<{
      result?: { tools?: { name: string; annotations?: Record<string, boolean> }[]; content?: { text: string }[] };
      error?: unknown;
    }>();
  const callJson = async (token: string, name: string) =>
    JSON.parse((await rpc(token, 'tools/call', { name, arguments: {} })).result?.content?.[0]?.text ?? 'null');

  it('mark only the library tools as read-only', async () => {
    const { token } = await mint();
    const tools = (await rpc(token, 'tools/list')).result?.tools ?? [];
    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(hints.search_meetings).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(hints.get_account_info?.readOnlyHint).toBe(true);
    expect(hints.send_to_human).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hints.ask_human).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hints.sign_out).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    // A suggestion for the user to review: not a plain read, but it changes nothing they see.
    expect(hints.report_feedback).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(tools.every((tool) => tool.annotations !== undefined)).toBe(true);
  });

  it('say which account and connection the token belongs to', async () => {
    await testEnv.DB.prepare(`UPDATE users SET email = 'ada@example.com', display_name = 'Ada' WHERE id = 'user_mcp'`).run();
    const minted = await mint(['write']);
    const info = await callJson(minted.token, 'get_account_info');
    expect(info).toEqual({
      email: 'ada@example.com',
      name: 'Ada',
      connection: {
        name: 'Claude',
        access: ['read', 'write'],
        kind: 'token',
        created_at: expect.any(String),
        expires_at: new Date(minted.expiresAt).toISOString(),
      },
    });
  });

  it('sign out only the calling connection', async () => {
    const first = await mint();
    const second = await mint();
    expect((await callJson(first.token, 'sign_out')).status).toBe('signed_out');
    const after = await call('https://mcp.eavesy.com/', { authorization: `Bearer ${first.token}` });
    expect(after.status).toBe(401);
    expect((await rpc(second.token, 'tools/list')).result?.tools?.length).toBe(16);
  });
});

describe('MCP meetings', () => {
  const call = async (token: string, name: string, args: Record<string, unknown>) => {
    const body = await (await mcpWorker.fetch(
      new Request('https://mcp.eavesy.com/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
      mcpEnv(),
    )).json<{ result?: { isError?: boolean; content?: { text: string }[] } }>();
    return JSON.parse(body.result?.content?.[0]?.text ?? 'null') as Record<string, unknown> & Record<string, unknown>[];
  };

  beforeEach(async () => {
    const now = Date.now();
    await testEnv.DB.prepare(
      `INSERT INTO folders (id, user_id, name, about, vocabulary_json, match_json) VALUES ('p1', 'user_mcp', 'eavesy', 'Mac recorder.', '["Tauri"]', '[]')`,
    ).run();
    await testEnv.DB.prepare(
      `INSERT INTO meetings (id, user_id, title, started_at, source, status, folder_id, speaker_names_json, agent_transcript_md, transcript_kind, created_at, updated_at)
       VALUES ('m1', 'user_mcp', 'Cask fix', ?, 'desktop', 'complete', 'p1', '{"you":"Will"}', '<transcript kind="conversation">
Will: Bump it.
</transcript>', 'conversation', ?, ?),
              ('m2', 'user_mcp', 'Other', ?, 'desktop', 'complete', NULL, NULL, NULL, NULL, ?, ?)`,
    ).bind(now, now, now, now - 1, now, now).run();
    await testEnv.DB.prepare(
      `INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, speaker_id, text) VALUES ('t1', 'm1', 0, 1000, 'you', 'um bump it')`,
    ).run();
  });

  afterEach(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare('DELETE FROM transcript_segments'),
      testEnv.DB.prepare('DELETE FROM meetings'),
      testEnv.DB.prepare('DELETE FROM folders'),
    ]);
  });

  it('give the agent-ready transcript by default and the raw one on request', async () => {
    const { token } = await mint();
    const agent = await call(token, 'get_meeting', { id: 'm1' });
    expect(agent).toMatchObject({ project: 'eavesy', transcript_kind: 'conversation' });
    expect(agent.transcript).toContain('Will: Bump it.');
    const raw = await call(token, 'get_meeting', { id: 'm1', transcript_format: 'raw' });
    expect(raw.transcript).toBe('[00:00] Will: um bump it');
  });

  it('list projects and filter recent meetings by one', async () => {
    const { token } = await mint();
    expect(await call(token, 'list_projects', {})).toEqual([
      { name: 'eavesy', about: 'Mac recorder.', terms: ['Tauri'], people: null, recordings: 1 },
    ]);
    const recent = await call(token, 'recent_meetings', { project: 'Eavesy' });
    expect(recent.map((meeting) => meeting.id)).toEqual(['m1']);
    expect(recent[0].project).toBe('eavesy');
  });

  const raw = async (token: string, body: unknown) =>
    (await mcpWorker.fetch(
      new Request('https://mcp.eavesy.com/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      mcpEnv(),
    )).json<{ result?: { content?: { text: string }[] }; error?: { code: number; message: string } }>();
  const tool = (token: string, name: string, args: unknown) =>
    raw(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  it('clamp list limits to 1–50 and ignore ones that are not numbers', async () => {
    const { token } = await mint();
    expect(await call(token, 'recent_meetings', { limit: -1 })).toHaveLength(1);
    expect(await call(token, 'recent_meetings', { limit: 0 })).toHaveLength(2);
    expect(await call(token, 'recent_meetings', { limit: 'lots' })).toHaveLength(2);
    expect(await call(token, 'recent_meetings', { limit: 1e9 })).toHaveLength(2);
  });

  it('hide imports that have not finished, as search does', async () => {
    const { token } = await mint();
    const now = Date.now();
    await testEnv.DB.prepare(
      `INSERT INTO meetings (id, user_id, title, started_at, source, status, created_at, updated_at)
       VALUES ('m3', 'user_mcp', 'Half imported', ?, 'import', 'processing', ?, ?)`,
    ).bind(now + 1, now, now).run();
    expect((await call(token, 'recent_meetings', {})).map((meeting) => meeting.id)).toEqual(['m1', 'm2']);
    expect((await tool(token, 'get_meeting', { id: 'm3' })).error?.message).toBe('not found');
  });

  it('match LIKE wildcards literally and refuse a query that is not text', async () => {
    const { token } = await mint();
    const now = Date.now();
    await testEnv.DB.prepare(
      `INSERT INTO dictations (id, user_id, title, transcript, duration_sec, created_at)
       VALUES ('d1', 'user_mcp', 'a', 'rename user_id', 1, ?), ('d2', 'user_mcp', 'b', 'rename userXid', 1, ?),
              ('d3', 'user_mcp', 'c', '100% done', 1, ?), ('d4', 'user_mcp', 'd', '100 done', 1, ?)`,
    ).bind(now, now, now, now).run();
    try {
      expect((await call(token, 'search_dictations', { query: 'user_id' })).map((d) => d.id)).toEqual(['d1']);
      expect((await call(token, 'search_dictations', { query: '100%' })).map((d) => d.id)).toEqual(['d3']);
      expect(await call(token, 'search_dictations', { query: 42 })).toEqual([]);
    } finally {
      await testEnv.DB.prepare('DELETE FROM dictations').run();
    }
  });

  it('count model-backed tools against the user’s daily quotas, as the web app does', async () => {
    const { token } = await mint();
    const day = Math.floor(Date.now() / 86_400_000);
    await testEnv.DB.prepare('INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1000, ?)')
      .bind(`budget:user:search:user_mcp:${day}`, (day + 1) * 86_400_000).run();
    try {
      const refused = await tool(token, 'search_meetings', { query: 'cask' });
      expect(refused.error).toEqual({ code: -32602, message: expect.stringContaining('today’s limit') });
      const library = await tool(token, 'search_library', { query: 'cask fix' });
      expect(library.error?.message).toContain('today’s limit');
      // Tools that don't call a model are not counted.
      expect((await tool(token, 'recent_meetings', {})).error).toBeUndefined();

      // A search whose model call fails gives its use back. (The test Worker
      // has no AI binding, so embedding the query throws.)
      await testEnv.DB.prepare('UPDATE rate_limits SET count = 5').run();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect((await tool(token, 'search_meetings', { query: 'cask' })).error?.code).toBe(-32000);
      expect(await testEnv.DB.prepare('SELECT count FROM rate_limits').first()).toEqual({ count: 5 });
    } finally {
      await testEnv.DB.prepare('DELETE FROM rate_limits').run();
    }
  });

  it('answer a request that is not an object, and keep internal errors to themselves', async () => {
    const { token } = await mint();
    expect((await raw(token, null)).error?.code).toBe(-32600);
    expect((await raw(token, [1, 2])).error?.code).toBe(-32600);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The test Worker has no AI binding, so embedding the query throws inside.
    const failed = await tool(token, 'search_meetings', { query: 'cask' });
    expect(failed.error).toEqual({ code: -32000, message: 'The tool call failed. Please try again.' });
    expect((await tool(token, 'no_such_tool', {})).error?.message).toBe('unknown tool: no_such_tool');
  });
});

describe('MCP library items', () => {
  const DAY = 86_400_000;
  const T0 = Date.parse('2026-10-20T12:00:00Z');
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const vectorQueries: unknown[] = [];
  const itemsEnv = () =>
    ({
      DB: testEnv.DB,
      AUDIO_BUCKET: testEnv.AUDIO_BUCKET,
      AI: { run: async () => ({ data: [Array.from({ length: 1024 }, () => 0.1)] }) },
      VECTORIZE: {
        query: async (...args: unknown[]) => {
          vectorQueries.push(args);
          return {
            matches: [
              { id: 'vec_meeting', score: 0.7, metadata: { userId: 'user_mcp', sourceType: 'meeting', sourceId: 'meet_meaning' } },
              { id: 'vec_dictation', score: 0.6, metadata: { userId: 'user_mcp', sourceType: 'dictation', sourceId: 'dict_meaning' } },
            ],
          };
        },
      },
    }) as unknown as Parameters<typeof mcpWorker.fetch>[1];
  const rpc = async (token: string, name: string, args: Record<string, unknown>) =>
    (await mcpWorker.fetch(
      new Request('https://mcp.eavesy.com/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
      itemsEnv(),
    )).json<{
      result?: { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: unknown };
      error?: { code: number; message: string };
    }>();
  const call = async (token: string, name: string, args: Record<string, unknown>) =>
    JSON.parse((await rpc(token, name, args)).result?.content?.[0]?.text ?? 'null');
  const ids = async (token: string, name: string, args: Record<string, unknown>) =>
    ((await call(token, name, args)).items as { id: string }[]).map((item) => item.id);

  beforeEach(async () => {
    vectorQueries.length = 0;
    const capture = `INSERT INTO captures (id, user_id, kind, capture_mode, source, title, r2_key, content_type, bytes, transcript, transcript_status, folder_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, 'desktop', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(`INSERT INTO folders (id, user_id, name, about, vocabulary_json, match_json) VALUES ('p1', 'user_mcp', 'Eavesy', '', '[]', '[]')`),
      testEnv.DB.prepare(
        `INSERT INTO meetings (id, user_id, title, description, started_at, source, status, folder_id, created_at, updated_at)
         VALUES ('meet_words', 'user_mcp', 'Pricing review', 'We set the price.', ?, 'desktop', 'complete', 'p1', ?, ?),
                ('meet_meaning', 'user_mcp', 'Standup', 'Daily sync.', ?, 'desktop', 'complete', NULL, ?, ?)`,
      ).bind(T0, T0, T0, T0 - DAY, T0, T0),
      testEnv.DB.prepare(`INSERT INTO user_notes (meeting_id, content_md, updated_at) VALUES ('meet_words', 'Ask Ada about pricing.', ?)`).bind(T0),
      testEnv.DB.prepare(
        `INSERT INTO dictations (id, user_id, title, transcript, cleaned_text, duration_sec, created_at)
         VALUES ('dict_words', 'user_mcp', 'Dictation', 'um pricing tiers', 'Pricing tiers.', 4, ?),
                ('dict_meaning', 'user_mcp', 'Dictation', 'ship friday', NULL, 2, ?)`,
      ).bind(T0 - 2 * DAY, T0 - 3 * DAY),
      testEnv.DB.prepare(capture).bind('cap_note', 'user_mcp', 'note', 'note', 'Groceries', 'users/user_mcp/captures/cap_note.md', 'text/markdown', 30,
        '# Groceries\n\n- oat milk\n- pricing stickers', 'complete', null, T0 - 4 * DAY, T0, null),
      testEnv.DB.prepare(capture).bind('cap_old_note', 'user_mcp', 'note', 'note', 'Old note', 'users/user_mcp/captures/cap_old_note.md', 'text/markdown', 9,
        null, 'none', null, T0 - 5 * DAY, T0, null),
      testEnv.DB.prepare(capture).bind('cap_shot', 'user_mcp', 'image', 'screenshot', 'Screenshot', 'users/user_mcp/captures/cap_shot.png', 'image/png', PNG.byteLength,
        'Pricing page: $10 a month', 'complete', 'p1', T0 - 6 * DAY, T0, null),
      testEnv.DB.prepare(capture).bind('cap_gone', 'user_mcp', 'note', 'note', 'Pricing draft', 'users/user_mcp/captures/cap_gone.md', 'text/markdown', 5,
        'pricing', 'complete', null, T0 - DAY, T0, T0),
      testEnv.DB.prepare(
        `INSERT INTO embeddings (id, user_id, source_type, source_id, chunk_idx, content_excerpt, created_at)
         VALUES ('vec_meeting', 'user_mcp', 'meeting', 'meet_meaning', 0, 'We talked about what to charge.', ?),
                ('vec_dictation', 'user_mcp', 'dictation', 'dict_meaning', 0, 'ship friday', ?)`,
      ).bind(T0, T0),
    ]);
    await testEnv.AUDIO_BUCKET.put('users/user_mcp/captures/cap_old_note.md', 'Old words');
    await testEnv.AUDIO_BUCKET.put('users/user_mcp/captures/cap_shot.png', PNG);
  });

  afterEach(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare('DELETE FROM embeddings'),
      testEnv.DB.prepare('DELETE FROM captures'),
      testEnv.DB.prepare('DELETE FROM dictations'),
      testEnv.DB.prepare('DELETE FROM user_notes'),
      testEnv.DB.prepare('DELETE FROM meetings'),
      testEnv.DB.prepare('DELETE FROM folders'),
      testEnv.DB.prepare('DELETE FROM rate_limits'),
    ]);
  });

  it('list everything newest first, with structured results, and filter by kind, project and date', async () => {
    const { token } = await mint();
    const response = await rpc(token, 'recent', {});
    const parsed = JSON.parse(response.result?.content?.[0]?.text ?? 'null');
    expect(response.result?.structuredContent).toEqual(parsed);
    expect(parsed.items.map((item: { id: string }) => item.id)).toEqual([
      'meet_words', 'meet_meaning', 'dict_words', 'dict_meaning', 'cap_note', 'cap_old_note', 'cap_shot',
    ]);
    expect(parsed.items[0]).toEqual({
      id: 'meet_words',
      kind: 'meeting',
      title: 'Pricing review',
      excerpt: 'We set the price.',
      project: 'Eavesy',
      created_at: '2026-10-20T12:00:00.000Z',
      duration_sec: null,
      url: 'https://eavesy.com/app/meetings/meet_words',
    });
    expect(parsed.items[4]).toMatchObject({ kind: 'note', excerpt: '# Groceries - oat milk - pricing stickers', url: null });

    expect(await ids(token, 'recent', { kinds: ['note', 'image'] })).toEqual(['cap_note', 'cap_old_note', 'cap_shot']);
    expect(await ids(token, 'recent', { kinds: 'dictation' })).toEqual(['dict_words', 'dict_meaning']);
    // Dictations have no project, so a project leaves them out.
    expect(await ids(token, 'recent', { project: 'eavesy' })).toEqual(['meet_words', 'cap_shot']);
    expect(await ids(token, 'recent', { since: '2026-10-16', until: '2026-10-18' })).toEqual(['dict_words', 'dict_meaning', 'cap_note']);
    expect(await ids(token, 'recent', { until: '2026-10-19T00:00:00Z' })).toEqual(['dict_words', 'dict_meaning', 'cap_note', 'cap_old_note', 'cap_shot']);
    expect(await ids(token, 'recent', { limit: 2 })).toEqual(['meet_words', 'meet_meaning']);
  });

  it('refuse a kind, date or project it does not know', async () => {
    const { token } = await mint();
    expect((await rpc(token, 'recent', { kinds: ['email'] })).error?.message).toContain('unknown kind "email"');
    expect((await rpc(token, 'recent', { since: 'last week' })).error?.message).toContain('since must be an ISO 8601');
    expect((await rpc(token, 'recent', { since: '2026-10-20', until: '2026-10-01' })).error?.message).toBe('since must be before until');
    expect((await rpc(token, 'search', { query: 'x', project: 'nope' })).error?.message).toBe('no project named "nope"');
  });

  it('search words across every kind and meaning across recordings and dictations, best first', async () => {
    const { token } = await mint();
    const { items } = await call(token, 'search', { query: 'pricing' });
    expect(items.map((item: { id: string; score: number }) => [item.id, item.score])).toEqual([
      ['meet_words', 1],
      ['dict_words', 1],
      ['cap_note', 1],
      ['cap_shot', 1],
      ['meet_meaning', 0.7],
      ['dict_meaning', 0.6],
    ]);
    expect(items.find((item: { id: string }) => item.id === 'meet_meaning').excerpt).toBe('We talked about what to charge.');
    expect(items.find((item: { id: string }) => item.id === 'cap_shot').excerpt).toBe('Pricing page: $10 a month');
    expect(vectorQueries).toHaveLength(1);
    const day = Math.floor(Date.now() / DAY);
    expect(await testEnv.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(`budget:user:search:user_mcp:${day}`).first()).toEqual({ count: 1 });

    expect(await ids(token, 'search', { query: 'pricing', kinds: ['image'], project: 'Eavesy' })).toEqual(['cap_shot']);
    expect(await ids(token, 'search', { query: 'pricing', since: '2026-10-19' })).toEqual(['meet_words', 'meet_meaning']);
    expect(await call(token, 'search', { query: '  ' })).toEqual({ items: [] });
  });

  it('search notes and captures without a model call or a quota', async () => {
    const { token } = await mint();
    expect(await ids(token, 'search', { query: 'oat milk', kinds: ['note', 'image', 'video', 'audio'] })).toEqual(['cap_note']);
    expect(vectorQueries).toHaveLength(0);
    expect(await testEnv.DB.prepare(`SELECT count(*) AS n FROM rate_limits WHERE key LIKE 'budget:user:%'`).first()).toEqual({ n: 0 });
  });

  it('get a recording with the user’s notes, a dictation, a note and a screenshot with its image', async () => {
    const { token } = await mint();
    expect(await call(token, 'get', { id: 'meet_words' })).toMatchObject({
      kind: 'meeting',
      title: 'Pricing review',
      notes: 'Ask Ada about pricing.',
      project: 'Eavesy',
    });
    expect(await call(token, 'get_meeting', { id: 'meet_words' })).toMatchObject({ notes: 'Ask Ada about pricing.' });
    expect(await call(token, 'get', { id: 'dict_words' })).toMatchObject({ kind: 'dictation', text: 'Pricing tiers.', transcript: 'um pricing tiers' });
    expect(await call(token, 'get', { id: 'cap_note' })).toMatchObject({ kind: 'note', text: '# Groceries\n\n- oat milk\n- pricing stickers' });
    // A note from before its text was kept on the row is read from R2.
    expect(await call(token, 'get', { id: 'cap_old_note' })).toMatchObject({ text: 'Old words' });

    const shot = await rpc(token, 'get', { id: 'cap_shot' });
    expect(JSON.parse(shot.result?.content?.[0]?.text ?? 'null')).toMatchObject({
      kind: 'image',
      text: 'Pricing page: $10 a month',
      project: 'Eavesy',
      image_attached: true,
      url: 'https://eavesy.com/app/captures/cap_shot',
    });
    expect(shot.result?.content?.[1]).toEqual({ type: 'image', mimeType: 'image/png', data: btoa(String.fromCharCode(...PNG)) });
    expect(shot.result?.structuredContent).toBeUndefined();

    // Too big to attach: the text and details still come back.
    await testEnv.DB.prepare(`UPDATE captures SET bytes = ? WHERE id = 'cap_shot'`).bind(4 * 1024 * 1024 + 1).run();
    const big = await rpc(token, 'get', { id: 'cap_shot' });
    expect(JSON.parse(big.result?.content?.[0]?.text ?? 'null')).toMatchObject({ text: 'Pricing page: $10 a month', image_attached: false });
    expect(big.result?.content).toHaveLength(1);

    expect((await rpc(token, 'get', { id: 'cap_gone' })).error?.message).toBe('not found');
    expect((await rpc(token, 'get', { id: 'nope' })).error?.message).toBe('not found');
  });

  it('never reach another user’s items', async () => {
    const { token } = await mint();
    const now = Date.now();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO users (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at) VALUES ('user_other', 'whisper', 'en', 0, ?, ?)`,
      ).bind(now, now),
      testEnv.DB.prepare(
        `INSERT INTO captures (id, user_id, kind, capture_mode, source, title, r2_key, content_type, bytes, transcript, created_at, updated_at)
         VALUES ('cap_theirs', 'user_other', 'note', 'note', 'desktop', 'Pricing', 'users/user_other/captures/cap_theirs.md', 'text/markdown', 7, 'pricing', ?, ?)`,
      ).bind(now, now),
    ]);
    try {
      expect(await ids(token, 'search', { query: 'pricing', kinds: ['note'] })).toEqual(['cap_note']);
      expect(await ids(token, 'recent', { kinds: ['note'] })).not.toContain('cap_theirs');
      expect((await rpc(token, 'get', { id: 'cap_theirs' })).error?.message).toBe('not found');
    } finally {
      await testEnv.DB.prepare(`DELETE FROM captures WHERE user_id = 'user_other'`).run();
    }
  });
});

describe('MCP write tools', () => {
  const T0 = Date.parse('2026-10-20T12:00:00Z');
  const ACTION_ITEMS = JSON.stringify([{ text: 'Ship the cask', completed: false }, 'not an item', { text: 'Email Ada', owner: 'Will', completed: false }]);
  const rpc = async (token: string, name: string, args: Record<string, unknown>) =>
    (await mcpWorker.fetch(
      new Request('https://mcp.eavesy.com/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
      ({ DB: testEnv.DB, AUDIO_BUCKET: testEnv.AUDIO_BUCKET, AI: {}, VECTORIZE: {} }) as unknown as Parameters<typeof mcpWorker.fetch>[1],
    )).json<{ result?: { isError?: boolean; content?: { text: string }[] }; error?: { code: number; message: string } }>();
  const call = async (token: string, name: string, args: Record<string, unknown>) =>
    JSON.parse((await rpc(token, name, args)).result?.content?.[0]?.text ?? 'null');
  const error = async (token: string, name: string, args: Record<string, unknown>) => (await rpc(token, name, args)).error?.message;
  const row = (sql: string, ...values: unknown[]) => testEnv.DB.prepare(sql).bind(...values).first();
  /** The rebuild is queued after the response, so the stale copy goes a moment later. */
  const staleCopyDropped = async () => {
    for (let i = 0; i < 50; i++) {
      if ((await row(`SELECT agent_transcript_md AS md FROM meetings WHERE id = 'meet_one'`))?.md === null) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };

  beforeEach(async () => {
    const now = Date.now();
    await testEnv.DB.batch([
      testEnv.DB.prepare(`INSERT INTO folders (id, user_id, name, about, vocabulary_json, match_json) VALUES ('p1', 'user_mcp', 'Eavesy', '', '[]', '[]')`),
      testEnv.DB.prepare(
        `INSERT INTO users (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at) VALUES ('user_other', 'whisper', 'en', 0, ?, ?)`,
      ).bind(now, now),
      testEnv.DB.prepare(
        `INSERT INTO meetings (id, user_id, title, started_at, source, status, agent_transcript_md, created_at, updated_at)
         VALUES ('meet_one', 'user_mcp', 'Standup', ?, 'desktop', 'complete', '<transcript title="Standup">', ?, ?),
                ('meet_theirs', 'user_other', 'Theirs', ?, 'desktop', 'complete', NULL, ?, ?)`,
      ).bind(T0, T0, T0, T0, T0, T0),
      testEnv.DB.prepare(
        `INSERT INTO summaries (id, meeting_id, tldr, action_items_json, generated_by_model, generated_at)
         VALUES ('sum_one', 'meet_one', 'Short.', ?, 'test', ?), ('sum_theirs', 'meet_theirs', 'Theirs.', ?, 'test', ?)`,
      ).bind(ACTION_ITEMS, T0, ACTION_ITEMS, T0),
      testEnv.DB.prepare(
        `INSERT INTO dictations (id, user_id, title, transcript, duration_sec, created_at) VALUES ('dict_one', 'user_mcp', 'Dictation', 'ship it', 2, ?)`,
      ).bind(T0),
      testEnv.DB.prepare(
        `INSERT INTO captures (id, user_id, kind, capture_mode, source, title, r2_key, content_type, bytes, created_at, updated_at)
         VALUES ('cap_shot', 'user_mcp', 'image', 'screenshot', 'desktop', 'Screenshot', 'users/user_mcp/captures/cap_shot.png', 'image/png', 3, ?, ?)`,
      ).bind(T0, T0),
    ]);
  });

  afterEach(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare('DELETE FROM summaries'),
      testEnv.DB.prepare('DELETE FROM captures'),
      testEnv.DB.prepare('DELETE FROM dictations'),
      testEnv.DB.prepare('DELETE FROM meetings'),
      testEnv.DB.prepare('DELETE FROM folders'),
      testEnv.DB.prepare('DELETE FROM rate_limits'),
    ]);
  });

  it('are hidden from and refused to a read-only connection', async () => {
    const { token } = await mint();
    for (const name of ['save_note', 'update_action_item', 'set_project', 'rename']) {
      const refused = (await rpc(token, name, {})).result;
      expect(refused?.isError).toBe(true);
      expect(refused?.content?.[0]?.text).toContain('needs write access');
    }
    expect(await row(`SELECT title FROM meetings WHERE id = 'meet_one'`)).toEqual({ title: 'Standup' });
  });

  it('save a note that search, get and the user’s Macs can read', async () => {
    const { token } = await mint(['write']);
    const saved = await call(token, 'save_note', { text: '## Launch plan\n\n- Ship Friday', project: 'eavesy' });
    expect(saved).toEqual({ id: expect.stringMatching(/^cap_/), kind: 'note', title: 'Launch plan', project: 'Eavesy', created_at: expect.any(String) });
    expect(await row('SELECT kind, source, title, transcript, folder_id, device_id, client_capture_id, r2_key FROM captures WHERE id = ?', saved.id)).toEqual({
      kind: 'note',
      source: 'web',
      title: 'Launch plan',
      transcript: '## Launch plan\n\n- Ship Friday',
      folder_id: 'p1',
      device_id: null,
      client_capture_id: null,
      r2_key: `users/user_mcp/captures/${saved.id}.md`,
    });
    expect(await (await testEnv.AUDIO_BUCKET.get(`users/user_mcp/captures/${saved.id}.md`))?.text()).toBe('## Launch plan\n\n- Ship Friday');
    expect(await call(token, 'get', { id: saved.id })).toMatchObject({ kind: 'note', text: '## Launch plan\n\n- Ship Friday' });
    expect((await call(token, 'search', { query: 'friday', kinds: ['note'] })).items.map((item: { id: string }) => item.id)).toEqual([saved.id]);

    expect((await call(token, 'save_note', { text: 'plain', title: '  My   title ' })).title).toBe('My title');
    expect((await call(token, 'save_note', { text: '#\n\n' + 'x'.repeat(100) })).title).toBe(`${'x'.repeat(79)}…`);
    const day = Math.floor(Date.now() / 86_400_000);
    expect(await row('SELECT count FROM rate_limits WHERE key = ?', `budget:user:capture:user_mcp:${day}`)).toEqual({ count: 3 });
  });

  it('refuse a note that is empty, too large or for a project that is not there, and store nothing', async () => {
    const { token } = await mint(['write']);
    expect(await error(token, 'save_note', { text: '   ' })).toBe('text is required');
    expect(await error(token, 'save_note', { text: 'x'.repeat(1024 * 1024 + 1) })).toContain('text too large');
    expect(await error(token, 'save_note', { text: 'hi', project: 'nope' })).toBe('no project named "nope"');
    expect(await error(token, 'save_note', { text: 'hi', title: 'x'.repeat(201) })).toBe('title must be at most 200 characters');
    expect(await row(`SELECT count(*) AS n FROM captures WHERE kind = 'note'`)).toEqual({ n: 0 });
    expect(await row(`SELECT count(*) AS n FROM rate_limits WHERE key LIKE 'budget:user:capture:%'`)).toEqual({ n: 0 });

    const day = Math.floor(Date.now() / 86_400_000);
    await testEnv.DB.prepare('INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 300, ?)')
      .bind(`budget:user:capture:user_mcp:${day}`, (day + 1) * 86_400_000).run();
    expect(await error(token, 'save_note', { text: 'one more' })).toContain('today’s limit');
    expect(await row(`SELECT count(*) AS n FROM captures WHERE kind = 'note'`)).toEqual({ n: 0 });
  });

  it('mark an action item done by the index get_action_items gives, and refuse a stale one', async () => {
    const { token } = await mint(['write']);
    const open = await call(token, 'get_action_items', {});
    expect(open.map((item: { index: number; text: string }) => [item.index, item.text])).toEqual([[0, 'Ship the cask'], [2, 'Email Ada']]);

    expect(await call(token, 'update_action_item', { meeting_id: 'meet_one', index: 2, completed: true, text: 'Email Ada' })).toEqual({
      meeting_id: 'meet_one',
      index: 2,
      text: 'Email Ada',
      owner: 'Will',
      completed: true,
    });
    const stored = await row(`SELECT action_items_json, user_edited_at FROM summaries WHERE id = 'sum_one'`) as { action_items_json: string; user_edited_at: number };
    expect(JSON.parse(stored.action_items_json)).toEqual([
      { text: 'Ship the cask', completed: false },
      'not an item',
      { text: 'Email Ada', owner: 'Will', completed: true },
    ]);
    expect(stored.user_edited_at).toBeGreaterThan(0);

    // Already open: nothing is written, so the brief isn't marked as edited.
    await testEnv.DB.prepare(`UPDATE summaries SET user_edited_at = NULL WHERE id = 'sum_one'`).run();
    expect((await call(token, 'update_action_item', { meeting_id: 'meet_one', index: 0, completed: false })).completed).toBe(false);
    expect(await row(`SELECT user_edited_at FROM summaries WHERE id = 'sum_one'`)).toEqual({ user_edited_at: null });
    await testEnv.DB.prepare(`UPDATE summaries SET user_edited_at = 1 WHERE id = 'sum_one'`).run();
    expect((await call(token, 'get_action_items', { status: 'completed' })).map((item: { index: number }) => item.index)).toEqual([2]);

    expect(await error(token, 'update_action_item', { meeting_id: 'meet_one', index: 0, completed: true, text: 'Ship the boat' }))
      .toContain('action item 0 reads "Ship the cask" now');
    expect(await error(token, 'update_action_item', { meeting_id: 'meet_one', index: 1, completed: true })).toBe('that recording has no action item 1');
    expect(await error(token, 'update_action_item', { meeting_id: 'meet_one', index: 9, completed: true })).toBe('that recording has no action item 9');
    expect(await error(token, 'update_action_item', { meeting_id: 'meet_one', index: 1.5, completed: true })).toBe('index must be a whole number from 0');
    expect(await error(token, 'update_action_item', { meeting_id: 'meet_one', index: 0, completed: 'yes' })).toBe('completed must be true or false');
    expect(await error(token, 'update_action_item', { meeting_id: 'meet_theirs', index: 0, completed: true })).toBe('no recording with a summary has that id');
    expect(JSON.parse((await row(`SELECT action_items_json AS j FROM summaries WHERE id = 'sum_theirs'`) as { j: string }).j)[0].completed).toBe(false);
  });

  it('file a recording or capture under a project and take it out again', async () => {
    const { token } = await mint(['write']);
    expect(await call(token, 'set_project', { id: 'meet_one', project: 'eavesy' })).toEqual({ id: 'meet_one', kind: 'meeting', project: 'Eavesy' });
    expect(await row(`SELECT folder_id FROM meetings WHERE id = 'meet_one'`)).toEqual({ folder_id: 'p1' });
    // The cleaned transcript names the project, so it is rebuilt.
    expect(await staleCopyDropped()).toBe(true);
    expect(await call(token, 'set_project', { id: 'cap_shot', project: 'Eavesy' })).toEqual({ id: 'cap_shot', kind: 'image', project: 'Eavesy' });
    expect(await call(token, 'set_project', { id: 'meet_one', project: null })).toEqual({ id: 'meet_one', kind: 'meeting', project: null });
    expect(await row(`SELECT folder_id FROM meetings WHERE id = 'meet_one'`)).toEqual({ folder_id: null });

    expect(await error(token, 'set_project', { id: 'dict_one', project: 'Eavesy' })).toBe('dictations have no project');
    expect(await error(token, 'set_project', { id: 'meet_one', project: 'nope' })).toBe('no project named "nope"');
    expect(await error(token, 'set_project', { id: 'meet_one', project: '' })).toContain('project must be a project name, or null');
    expect(await error(token, 'set_project', { id: 'meet_theirs', project: 'Eavesy' })).toBe('not found');
    expect(await row(`SELECT folder_id FROM meetings WHERE id = 'meet_theirs'`)).toEqual({ folder_id: null });
  });

  it('rename a recording, dictation or capture, and nothing of anyone else’s', async () => {
    const { token } = await mint(['write']);
    expect(await call(token, 'rename', { id: 'meet_one', title: 'Daily  standup' })).toEqual({ id: 'meet_one', kind: 'meeting', title: 'Daily standup' });
    expect(await staleCopyDropped()).toBe(true);
    expect(await call(token, 'rename', { id: 'dict_one', title: 'Ship note' })).toEqual({ id: 'dict_one', kind: 'dictation', title: 'Ship note' });
    expect(await call(token, 'rename', { id: 'cap_shot', title: 'Pricing page' })).toEqual({ id: 'cap_shot', kind: 'image', title: 'Pricing page' });
    expect(await row(`SELECT title FROM captures WHERE id = 'cap_shot'`)).toEqual({ title: 'Pricing page' });

    expect(await error(token, 'rename', { id: 'meet_one', title: ' ' })).toBe('title is required');
    expect(await error(token, 'rename', { id: 'meet_one', title: 'x'.repeat(201) })).toBe('title must be at most 200 characters');
    expect(await error(token, 'rename', { id: 'meet_theirs', title: 'Mine now' })).toBe('not found');
    expect(await row(`SELECT title FROM meetings WHERE id = 'meet_theirs'`)).toEqual({ title: 'Theirs' });
  });
});

describe('MCP prompts', () => {
  const rpc = async (token: string, method: string, params?: unknown) =>
    (await mcpWorker.fetch(
      new Request('https://mcp.eavesy.com/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
      mcpEnv(),
    )).json<{
      result?: {
        capabilities?: Record<string, unknown>;
        prompts?: { name: string; title: string; description: string; arguments: unknown[] }[];
        messages?: { role: string; content: { type: string; text: string } }[];
      };
      error?: { message: string };
    }>();

  beforeEach(async () => {
    const now = Date.now();
    await testEnv.DB.prepare(
      `INSERT INTO users (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at)
       VALUES ('user_other', 'whisper', 'en', 0, ?, ?)`,
    ).bind(now, now).run();
    await testEnv.DB.prepare(
      `INSERT INTO saved_prompts (id, user_id, name, slug, body, created_at, updated_at) VALUES
       ('prm_1', 'user_mcp', 'Triage tickets', 'triage-tickets', 'Search every support ticket.
Then debug each one.', ?, ?),
       ('prm_2', 'user_mcp', 'Focus', 'focus', 'Look at {{details}} first.', ?, ?),
       ('prm_3', 'user_other', 'Not yours', 'not-yours', 'Secret', ?, ?)`,
    ).bind(now, now, now, now, now, now).run();
  });

  afterEach(async () => {
    await testEnv.DB.prepare('DELETE FROM saved_prompts').run();
  });

  it('are offered at initialize and listed by slug, only the caller’s own', async () => {
    const { token } = await mint();
    expect((await rpc(token, 'initialize', { protocolVersion: '2025-06-18' })).result?.capabilities)
      .toMatchObject({ prompts: { listChanged: false } });
    expect((await rpc(token, 'prompts/list')).result?.prompts).toEqual([
      { name: 'focus', title: 'Focus', description: 'Look at {{details}} first.', arguments: [{ name: 'details', description: 'Anything to add for this run', required: false }] },
      { name: 'triage-tickets', title: 'Triage tickets', description: 'Search every support ticket.', arguments: [{ name: 'details', description: 'Anything to add for this run', required: false }] },
    ]);
  });

  it('give the prompt text with the details filled in, and count the use', async () => {
    const { token } = await mint();
    const got = (await rpc(token, 'prompts/get', { name: 'triage-tickets', arguments: { details: 'only billing' } })).result;
    expect(got?.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Search every support ticket.\nThen debug each one.\n\nonly billing' } }]);
    const slotted = (await rpc(token, 'prompts/get', { name: 'focus', arguments: { details: 'auth' } })).result;
    expect(slotted?.messages?.[0]?.content.text).toBe('Look at auth first.');
    const used = await testEnv.DB.prepare(`SELECT use_count FROM saved_prompts WHERE id = 'prm_1'`).first<{ use_count: number }>();
    expect(used?.use_count).toBe(1);
  });

  it('stay hidden from a connection without read access', async () => {
    const { token } = await mint();
    await testEnv.DB.prepare(`UPDATE mcp_tokens SET scopes_json = '["write"]'`).run();
    expect((await rpc(token, 'prompts/list')).result?.prompts).toEqual([]);
    expect((await rpc(token, 'prompts/get', { name: 'focus' })).error?.message).toContain('can’t read your prompts');
    expect((await rpc(token, 'prompts/get', { name: 'nope' })).error?.message).toContain('can’t read your prompts');
    const counted = await testEnv.DB.prepare(`SELECT use_count FROM saved_prompts WHERE id = 'prm_2'`).first<{ use_count: number }>();
    expect(counted?.use_count).toBe(0);
  });

  it('refuse another user’s prompt and one that doesn’t exist', async () => {
    const { token } = await mint();
    expect((await rpc(token, 'prompts/get', { name: 'not-yours' })).error?.message).toContain('No saved prompt');
    expect((await rpc(token, 'prompts/get', { name: 'nope' })).error?.message).toContain('No saved prompt');
  });
});

describe('MCP messages to the human', () => {
  const call = async (token: string, name: string, args: Record<string, unknown>) => {
    const body = await (await mcpWorker.fetch(
      new Request('https://mcp.eavesy.com/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
      mcpEnv(),
    )).json<{ result?: { content?: { text: string }[] }; error?: { message: string } }>();
    return body.error ? { error: body.error.message } : (JSON.parse(body.result?.content?.[0]?.text ?? 'null') as Record<string, unknown>);
  };
  const db = () => drizzle(testEnv.DB, { schema });

  afterEach(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare('DELETE FROM agent_messages'),
      testEnv.DB.prepare('DELETE FROM agent_listeners'),
      testEnv.DB.prepare('DELETE FROM rate_limits'),
    ]);
  });

  it('say the Mac is offline at once when none is listening', async () => {
    const { token } = await mint();
    expect(await call(token, 'ask_human', { question: 'Ship it?' })).toEqual({ status: 'mac_offline' });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM agent_messages').first('n')).toBe(0);
  });

  it('keep nothing for someone who never turned messages on', async () => {
    const { token } = await mint();
    expect(await call(token, 'send_to_human', { text: 'Done.' })).toEqual({ status: 'not_enabled' });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM agent_messages').first('n')).toBe(0);
  });

  it('queue a message for a Mac that comes back, under the connection’s name', async () => {
    const { token } = await mint();
    await testEnv.DB.prepare("INSERT INTO agent_listeners (device_id, user_id, seen_at) VALUES ('mac-a', 'user_mcp', ?)").bind(Date.now() - 60 * 60 * 1000).run();
    expect(await call(token, 'send_to_human', { text: 'The report is ready.', spoken: 'Report ready.' })).toMatchObject({ status: 'queued' });
    const { items } = await pollForDevice(db(), 'user_mcp', 'mac-a');
    expect(items).toEqual([expect.objectContaining({ kind: 'send', source: 'Claude', text: 'The report is ready.', spoken: 'Report ready.' })]);
    expect(await call(token, 'send_to_human', {})).toEqual({ error: 'text is required' });
  });

  it('refuse once too many wait, without spending the connection’s rate limit', async () => {
    const { token } = await mint();
    await pollForDevice(db(), 'user_mcp', 'mac-a');
    const now = Date.now();
    for (let i = 0; i < 20; i += 1) {
      await testEnv.DB.prepare(
        "INSERT INTO agent_messages (id, user_id, mcp_token_id, source, kind, text, status, created_at, expires_at) VALUES (?, 'user_mcp', 't', 'x', 'send', 'hi', 'pending', ?, ?)",
      ).bind(`m${i}`, now, now + 60_000).run();
    }
    expect(await call(token, 'send_to_human', { text: 'One more.' })).toEqual({ error: expect.stringContaining('Too many messages') });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'mcp-human:%'").first('n')).toBe(0);
  });

  it('return the answer typed on the Mac to the call that asked', async () => {
    const { token } = await mint();
    await pollForDevice(db(), 'user_mcp', 'mac-a');
    const asking = call(token, 'ask_human', { question: 'Flag or not?', choices: ['flag', 'no flag'], timeout_sec: 30 });
    let id: string | undefined;
    for (let i = 0; i < 50 && !id; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      id = (await pollForDevice(db(), 'user_mcp', 'mac-a')).waiting[0];
    }
    expect(id).toBeDefined();
    expect(await resolveForDevice(db(), 'user_mcp', 'mac-a', id!, { status: 'answered', text: 'no flag' })).toBe(true);
    expect(await asking).toEqual({ status: 'answered', text: 'no flag' });
  });
});

describe('MCP feedback from agents', () => {
  const call = async (token: string, args: Record<string, unknown>) => {
    const body = await (await mcpWorker.fetch(
      new Request('https://mcp.eavesy.com/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report_feedback', arguments: args } }),
      }),
      mcpEnv(),
    )).json<{ result?: { content?: { text: string }[]; isError?: boolean }; error?: { message: string } }>();
    if (body.error) return { error: body.error.message };
    if (body.result?.isError) return { refused: body.result.content?.[0]?.text ?? '' };
    return JSON.parse(body.result?.content?.[0]?.text ?? 'null') as Record<string, unknown>;
  };
  const stored = () => testEnv.DB.prepare('SELECT * FROM agent_feedback ORDER BY created_at').all<Record<string, unknown>>().then((r) => r.results);
  const report = { kind: 'poor_prompt', prompt: 'triage', explanation: 'It never says what to do with tickets already fixed.', suggested_rewrite: 'Search every open ticket.' };

  beforeEach(async () => {
    const now = Date.now();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO users (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at) VALUES ('user_other', 'whisper', 'en', 0, ?, ?)`,
      ).bind(now, now),
      testEnv.DB.prepare(
        `INSERT INTO saved_prompts (id, user_id, name, slug, body, created_at, updated_at) VALUES
         ('prm_mine', 'user_mcp', 'Triage', 'triage', 'Search every ticket.', 1, 5),
         ('prm_theirs', 'user_other', 'Theirs', 'theirs', 'Secret', 1, 1)`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO captures (id, user_id, kind, capture_mode, source, title, r2_key, content_type, bytes, created_at, updated_at)
         VALUES ('cap_note', 'user_mcp', 'note', 'note', 'web', 'Pricing notes', 'users/user_mcp/captures/cap_note.md', 'text/markdown', 3, ?, ?),
                ('cap_theirs', 'user_other', 'note', 'note', 'web', 'Theirs', 'users/user_other/captures/cap_theirs.md', 'text/markdown', 3, ?, ?)`,
      ).bind(now, now, now, now),
    ]);
  });

  afterEach(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare('DELETE FROM agent_feedback'),
      testEnv.DB.prepare('DELETE FROM saved_prompts'),
      testEnv.DB.prepare('DELETE FROM captures'),
      testEnv.DB.prepare('DELETE FROM rate_limits'),
    ]);
  });

  it('keep a report on a saved prompt from a read-only connection, under its name, without changing the prompt', async () => {
    const { id, token } = await mint();
    const result = await call(token, report);
    expect(result).toMatchObject({ status: 'recorded', id: expect.stringMatching(/^afb_/) });
    expect(await stored()).toEqual([expect.objectContaining({
      user_id: 'user_mcp', mcp_token_id: id, source: 'Claude', kind: 'poor_prompt', target_type: 'prompt', target_id: 'prm_mine',
      target_label: 'Triage', target_version: 5, suggested_rewrite: 'Search every open ticket.', status: 'new',
    })]);
    expect(await testEnv.DB.prepare(`SELECT body FROM saved_prompts WHERE id = 'prm_mine'`).first('body')).toBe('Search every ticket.');
    // Never turned into a message the Mac reads aloud.
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM agent_messages').first('n')).toBe(0);
  });

  it('count the same report sent again once, whatever its case or spacing', async () => {
    const { token } = await mint();
    expect((await call(token, report)).status).toBe('recorded');
    expect((await call(token, { ...report, prompt: '/triage', explanation: `  ${report.explanation.toUpperCase()} ` })).status).toBe('duplicate');
    expect(await stored()).toHaveLength(1);
  });

  it('keep a typo in a capture, named by its id', async () => {
    const { token } = await mint();
    const result = await call(token, { kind: 'typo', item_id: 'cap_note', excerpt: 'Cloudfare', explanation: 'Misspelt.', suggested_rewrite: 'Cloudflare' });
    expect(result.status).toBe('recorded');
    expect(await stored()).toEqual([expect.objectContaining({ target_type: 'capture', target_id: 'cap_note', target_label: 'Pricing notes', target_version: null, excerpt: 'Cloudfare' })]);
  });

  it('never reach another user’s prompt or item, and say not found either way', async () => {
    const { token } = await mint();
    expect((await call(token, { ...report, prompt: 'theirs' })).error).toContain('No saved prompt is called theirs');
    expect((await call(token, { ...report, prompt: 'prm_theirs' })).error).toContain('No saved prompt');
    expect((await call(token, { kind: 'typo', item_id: 'cap_theirs', explanation: 'x' })).error).toBe('not found');
    expect((await call(token, { kind: 'typo', item_id: 'cap_nothing', explanation: 'x' })).error).toBe('not found');
    expect(await stored()).toEqual([]);
  });

  it('refuse a malformed report before counting it', async () => {
    const { token } = await mint();
    expect((await call(token, { ...report, kind: 'rant' })).error).toContain('kind must be one of');
    expect((await call(token, { ...report, explanation: ' ' })).error).toContain('explanation is required');
    expect((await call(token, { ...report, explanation: 'x'.repeat(1_001) })).error).toContain('at most 1000');
    expect((await call(token, { ...report, item_id: 'cap_note' })).error).toContain('either prompt or item_id');
    expect((await call(token, { kind: 'typo', explanation: 'x' })).error).toContain('either prompt or item_id');
    expect((await call(token, { kind: 'typo', item_id: 'cap_note', explanation: 'x', suggested_rewrite: 'y'.repeat(1_001) })).error).toContain('at most 1000');
    expect(await stored()).toEqual([]);
    expect(await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'mcp-feedback:%'`).first('n')).toBe(0);
  });

  it('are refused to a connection without read access', async () => {
    const { token } = await mint();
    await testEnv.DB.prepare(`UPDATE mcp_tokens SET scopes_json = '["write"]'`).run();
    expect((await call(token, report)).refused).toContain('needs read access');
    expect(await stored()).toEqual([]);
  });

  it('stop a connection that sends too many in an hour', async () => {
    const { id, token } = await mint();
    const hour = Math.floor(Date.now() / 3_600_000);
    await testEnv.DB.prepare('INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 20, ?)')
      .bind(`mcp-feedback:${id}:${hour}`, (hour + 1) * 3_600_000).run();
    expect((await call(token, report)).error).toContain('too many reports');
    expect(await stored()).toEqual([]);
  });

  it('say there are enough once a prompt has many open reports, and take more once they are dealt with', async () => {
    const { token } = await mint();
    const now = Date.now();
    await testEnv.DB.batch(Array.from({ length: 20 }, (_, i) => testEnv.DB.prepare(
      `INSERT INTO agent_feedback (id, user_id, mcp_token_id, source, kind, target_type, target_id, target_label, explanation, status, dedupe_key, created_at)
       VALUES (?, 'user_mcp', 'other', 'Other', 'typo', 'prompt', 'prm_mine', 'Triage', 'x', 'new', ?, ?)`,
    ).bind(`afb_old_${i}`, `key_${i}`, now)));
    expect((await call(token, report)).status).toBe('full');
    await testEnv.DB.prepare(`UPDATE agent_feedback SET status = 'dismissed' WHERE id = 'afb_old_0'`).run();
    expect((await call(token, report)).status).toBe('recorded');
  });
});
