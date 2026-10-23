import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Database } from '@cloudflare/workers-types';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { worker as mcpWorker } from '../../../workers/mcp/src/index';
import { Route as McpTokensRoute } from '../../src/routes/api/mcp-tokens';
import { MCP_TOKEN_TTL_MS } from '../../src/server/mcp-token-policy';

interface TestEnv {
  DB: D1Database;
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
      'search_library',
      'ask_library',
      'search_meetings',
      'get_meeting',
      'recent_meetings',
      'list_projects',
      'search_dictations',
      'get_action_items',
    ]);
    expect(tools.every((tool) => tool.scope === undefined)).toBe(true);
  });

  it('hide and refuse tools outside the connection’s scopes', async () => {
    const { token } = await mint();
    await testEnv.DB.prepare(`UPDATE mcp_tokens SET scopes_json = '["write"]'`).run();
    expect((await rpc(token, 'tools/list')).result?.tools).toEqual([]);
    const refused = (await rpc(token, 'tools/call', { name: 'recent_meetings', arguments: {} })).result;
    expect(refused?.isError).toBe(true);
    expect(refused?.content?.[0]?.text).toContain('needs read access');
  });

  it('treat an unreadable scopes value as read-only', async () => {
    const { token } = await mint(['write']);
    await testEnv.DB.prepare(`UPDATE mcp_tokens SET scopes_json = 'oops'`).run();
    expect((await rpc(token, 'tools/list')).result?.tools?.length).toBe(8);
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
