import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Database } from '@cloudflare/workers-types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { worker as mcpWorker } from '../../../workers/mcp/src/index';
import { Route as AuthorizeRoute } from '../../src/routes/api/oauth/authorize';
import { Route as McpTokensRoute } from '../../src/routes/api/mcp-tokens';
import { pkceChallenge } from '../../src/server/mcp-oauth';

interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
type RouteHandler = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>;
const handler = (route: unknown, method: string) =>
  (route as { options: { server: { handlers: Record<string, RouteHandler> } } }).options.server.handlers[method];

const actor = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
  tryResolveActor: async () => (actor.userId ? { userId: actor.userId, isAnonymous: false } : null),
}));

const MCP = 'https://mcp.eavesy.com';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'a'.repeat(20) + '-._~' + 'b'.repeat(30);
const mcpEnv = () => ({ DB: testEnv.DB, AI: {}, VECTORIZE: {} }) as unknown as Parameters<typeof mcpWorker.fetch>[1];
const mcp = (path: string, init?: RequestInit) => mcpWorker.fetch(new Request(`${MCP}${path}`, init), mcpEnv());

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  actor.userId = 'user_oauth';
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM mcp_tokens'),
    testEnv.DB.prepare('DELETE FROM oauth_codes'),
    testEnv.DB.prepare('DELETE FROM oauth_clients'),
    testEnv.DB.prepare('DELETE FROM rate_limits'),
    testEnv.DB.prepare('DELETE FROM users'),
  ]);
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO users (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at)
     VALUES ('user_oauth', 'whisper', 'en', 0, ?, ?)`,
  )
    .bind(now, now)
    .run();
});

async function register(body: Record<string, unknown> = { client_name: 'Claude', redirect_uris: [REDIRECT] }) {
  return await mcp('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
    body: JSON.stringify(body),
  });
}

async function clientId(): Promise<string> {
  const response = await register();
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function authorizeQuery(client: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    client_id: client,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: 'S256',
    state: 'xyz',
    ...extra,
  });
}

async function consent(query: URLSearchParams, decision: 'approve' | 'deny' = 'approve', scopes = ['read']) {
  return await handler(AuthorizeRoute, 'POST')({
    request: new Request('https://eavesy.com/api/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://eavesy.com' },
      body: JSON.stringify({ params: Object.fromEntries(query), decision, scopes }),
    }),
    params: {},
  });
}

async function code(client: string, extra: Record<string, string> = {}, scopes = ['read']): Promise<string> {
  const response = await consent(await authorizeQuery(client, extra), 'approve', scopes);
  const { redirectTo } = (await response.json()) as { redirectTo: string };
  const url = new URL(redirectTo);
  expect(url.origin + url.pathname).toBe(REDIRECT);
  expect(url.searchParams.get('state')).toBe('xyz');
  expect(url.searchParams.get('iss')).toBe(MCP);
  return url.searchParams.get('code')!;
}

const token = (form: Record<string, string>) =>
  mcp('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

async function tokens(client: string, scopes = ['read'], extra: Record<string, string> = {}): Promise<Tokens> {
  const response = await token({
    grant_type: 'authorization_code',
    code: await code(client, extra, scopes),
    code_verifier: VERIFIER,
    client_id: client,
    redirect_uri: REDIRECT,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return await response.json();
}

const toolsList = (accessToken: string) =>
  mcp('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

describe('MCP OAuth discovery', () => {
  it('answers an unauthenticated MCP request with a 401 that points at the resource metadata', async () => {
    const response = await mcp('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${MCP}/.well-known/oauth-protected-resource"`,
    );
    // A person opening the URL in a browser still gets a page, not an error.
    expect((await mcp('/')).status).toBe(200);
  });

  it('flags a bad token as invalid_token so clients start over', async () => {
    const response = await toolsList('nt_wrong');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('publishes protected-resource and authorization-server metadata', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await mcp(path);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(await response.json()).toMatchObject({ resource: MCP, authorization_servers: [MCP] });
    }
    const metadata = await (await mcp('/.well-known/oauth-authorization-server')).json();
    expect(metadata).toMatchObject({
      issuer: MCP,
      authorization_endpoint: `${MCP}/authorize`,
      token_endpoint: `${MCP}/token`,
      registration_endpoint: `${MCP}/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read', 'write'],
    });
    expect((await mcp('/token', { method: 'OPTIONS' })).status).toBe(204);
  });
});

describe('MCP OAuth client registration', () => {
  it('registers public clients with https, loopback or app-scheme redirects', async () => {
    const response = await register({
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost:33418/callback', 'http://127.0.0.1/cb', 'cursor://anysphere.cursor/oauth'],
      token_endpoint_auth_method: 'client_secret_post',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      client_id: expect.stringMatching(/^mcpc_/),
      client_name: 'Claude Code',
      token_endpoint_auth_method: 'none',
    });
  });

  it('refuses redirects an attacker could use', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'https://claude.ai/cb#frag', 'data:text/html,hi', 'not a url']) {
      const response = await register({ client_name: 'x', redirect_uris: [uri] });
      expect(response.status, uri).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    }
    expect((await register({ client_name: 'x' })).status).toBe(400);
  });

  it('rate-limits registrations per IP', async () => {
    for (let i = 0; i < 20; i++) expect((await register()).status).toBe(201);
    expect((await register()).status).toBe(429);
  });
});

describe('MCP OAuth authorization', () => {
  it('sends a valid request to the consent screen on the web app', async () => {
    const client = await clientId();
    const response = await mcp(`/authorize?${await authorizeQuery(client)}`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://eavesy.com/connect/mcp');
    expect(location.searchParams.get('client_id')).toBe(client);
  });

  it('never redirects to a URI it can’t trust', async () => {
    const client = await clientId();
    const unknownClient = await mcp(`/authorize?${await authorizeQuery('mcpc_nope')}`);
    expect(unknownClient.status).toBe(400);
    expect(unknownClient.headers.get('location')).toBeNull();
    const badRedirect = await mcp(`/authorize?${await authorizeQuery(client, { redirect_uri: 'https://evil.example/cb' })}`);
    expect(badRedirect.status).toBe(400);
    expect(badRedirect.headers.get('location')).toBeNull();
  });

  it('returns errors to a trusted redirect URI', async () => {
    const client = await clientId();
    const noPkce = await mcp(`/authorize?${await authorizeQuery(client, { code_challenge_method: 'plain' })}`);
    expect(noPkce.status).toBe(302);
    const location = new URL(noPkce.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('xyz');

    const otherResource = await mcp(`/authorize?${await authorizeQuery(client, { resource: 'https://other.example/' })}`);
    expect(new URL(otherResource.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
    const badScope = await mcp(`/authorize?${await authorizeQuery(client, { scope: 'read admin' })}`);
    expect(new URL(badScope.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
  });

  it('tells the consent screen who is asking, for signed-in users only', async () => {
    const client = await clientId();
    const describe = (query: URLSearchParams) =>
      handler(AuthorizeRoute, 'GET')({ request: new Request(`https://eavesy.com/api/oauth/authorize?${query}`), params: {} });
    const query = await authorizeQuery(client, { scope: 'read write' });
    expect(await (await describe(query)).json()).toEqual({
      clientName: 'Claude',
      redirectHost: 'claude.ai',
      scopes: ['read', 'write'],
    });
    actor.userId = null;
    expect((await describe(query)).status).toBe(401);
  });

  it('only accepts the user’s answer as JSON from its own origin', async () => {
    const client = await clientId();
    const query = await authorizeQuery(client);
    const post = (headers: Record<string, string>) =>
      handler(AuthorizeRoute, 'POST')({
        request: new Request('https://eavesy.com/api/oauth/authorize', {
          method: 'POST',
          headers,
          body: JSON.stringify({ params: Object.fromEntries(query), decision: 'approve' }),
        }),
        params: {},
      });
    expect((await post({ 'content-type': 'text/plain' })).status).toBe(403);
    expect((await post({ 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(403);
    actor.userId = null;
    expect((await post({ 'content-type': 'application/json' })).status).toBe(401);
  });

  it('sends access_denied back when the user cancels', async () => {
    const client = await clientId();
    const { redirectTo } = (await (await consent(await authorizeQuery(client), 'deny')).json()) as { redirectTo: string };
    const url = new URL(redirectTo);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('code')).toBeNull();
  });
});

describe('MCP OAuth tokens', () => {
  it('exchange a code for a working, read-only access token', async () => {
    const client = await clientId();
    const issued = await tokens(client);
    expect(issued).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read' });
    expect(issued.access_token).toMatch(/^nt_/);
    expect(issued.refresh_token).toMatch(/^rt_/);
    const response = await toolsList(issued.access_token);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(8);

    const listed = await (await handler(McpTokensRoute, 'GET')({ request: new Request('https://eavesy.com/api/mcp-tokens'), params: {} })).json();
    expect(listed).toEqual([
      expect.objectContaining({ name: 'Claude', scopes: ['read'], expiresAt: expect.any(Number) }),
    ]);
    expect((listed as { expiresAt: number }[])[0].expiresAt).toBeGreaterThan(Date.now() + 80 * 24 * 60 * 60 * 1000);
  });

  it('grant write only when the client asked and the user allowed it', async () => {
    const client = await clientId();
    expect((await tokens(client, ['read', 'write'])).scope).toBe('read');
    expect((await tokens(client, ['read'], { scope: 'read write' })).scope).toBe('read');
    expect((await tokens(client, ['read', 'write'], { scope: 'read write' })).scope).toBe('read write');
  });

  it('refuse a code that is reused, expired, for another client, or fails PKCE', async () => {
    const client = await clientId();
    const other = await clientId();
    const exchange = (c: string, extra: Record<string, string> = {}) =>
      token({ grant_type: 'authorization_code', code: c, code_verifier: VERIFIER, client_id: client, redirect_uri: REDIRECT, ...extra });

    const wrongVerifier = await exchange(await code(client), { code_verifier: 'c'.repeat(50) });
    expect(wrongVerifier.status).toBe(400);
    expect(await wrongVerifier.json()).toMatchObject({ error: 'invalid_grant' });

    const once = await code(client);
    expect((await exchange(once)).status).toBe(200);
    expect(await (await exchange(once)).json()).toMatchObject({ error: 'invalid_grant' });

    expect(await (await exchange(await code(client), { client_id: other })).json()).toMatchObject({ error: 'invalid_grant' });
    expect(await (await exchange(await code(client), { redirect_uri: 'https://claude.ai/other' })).json()).toMatchObject({
      error: 'invalid_grant',
    });

    const stale = await code(client);
    await testEnv.DB.prepare('UPDATE oauth_codes SET expires_at = ?').bind(Date.now() - 1).run();
    expect(await (await exchange(stale)).json()).toMatchObject({ error: 'invalid_grant' });

    expect(await (await token({ grant_type: 'password' })).json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('expire access tokens after an hour without sliding them forward', async () => {
    const client = await clientId();
    const issued = await tokens(client);
    const { expires_at: before } = (await testEnv.DB.prepare('SELECT expires_at FROM mcp_tokens').first<{ expires_at: number }>())!;
    expect(before).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
    await toolsList(issued.access_token);
    expect((await testEnv.DB.prepare('SELECT expires_at FROM mcp_tokens').first<{ expires_at: number }>())!.expires_at).toBe(before);

    await testEnv.DB.prepare('UPDATE mcp_tokens SET expires_at = ?').bind(Date.now() - 1).run();
    const expired = await toolsList(issued.access_token);
    expect(expired.status).toBe(401);
    expect(expired.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('rotate on refresh: the new pair works and the old pair stops working', async () => {
    const client = await clientId();
    const first = await tokens(client);
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: client });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as Tokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await toolsList(second.access_token)).status).toBe(200);
    expect((await toolsList(first.access_token)).status).toBe(401);

    const replay = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: client });
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });

    const widened = await token({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: client, scope: 'read write' });
    expect(await widened.json()).toMatchObject({ error: 'invalid_scope' });
    // A refused scope doesn't cost the client its refresh token.
    expect((await token({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: client })).status).toBe(200);
  });

  it('stop working, refresh included, once the connection is revoked in settings', async () => {
    const client = await clientId();
    const issued = await tokens(client);
    const { id } = (await testEnv.DB.prepare('SELECT id FROM mcp_tokens').first<{ id: string }>())!;
    await handler(McpTokensRoute, 'DELETE')({
      request: new Request('https://eavesy.com/api/mcp-tokens', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      }),
      params: {},
    });
    expect((await toolsList(issued.access_token)).status).toBe(401);
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token, client_id: client });
    expect(await refreshed.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('replace the earlier connection when the same client authorizes again', async () => {
    const client = await clientId();
    const first = await tokens(client);
    const second = await tokens(client);
    expect((await toolsList(first.access_token)).status).toBe(401);
    expect((await toolsList(second.access_token)).status).toBe(200);
    const active = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE revoked_at IS NULL').first<{ n: number }>();
    expect(active?.n).toBe(1);
  });

  it('leave pasted bearer tokens working alongside OAuth', async () => {
    const minted = await handler(McpTokensRoute, 'POST')({
      request: new Request('https://eavesy.com/api/mcp-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Codex' }),
      }),
      params: {},
    });
    const { token: pasted } = (await minted.json()) as { token: string };
    await tokens(await clientId());
    expect((await toolsList(pasted)).status).toBe(200);
  });
});
