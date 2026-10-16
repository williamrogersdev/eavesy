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
      'search_meetings',
      'get_meeting',
      'recent_meetings',
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
    expect((await rpc(token, 'tools/list')).result?.tools?.length).toBe(5);
  });
});
