import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { worker as mcpWorker } from '../../../workers/mcp/src/index';
import { API_ROUTES } from '../../../workers/mcp/src/rest';
import { openApiDocument } from '../../../workers/mcp/src/openapi';
import { Route as McpTokensRoute } from '../../src/routes/api/mcp-tokens';
import * as schema from '../../src/db/schema';
import { logMeetingComplete } from '../../src/server/processing/summarize';
import { verifySvixWebhook } from '../../src/server/svix';
import {
  type WebhookDelivery,
  WEBHOOK_DISABLE_AFTER,
  WEBHOOK_RETRY_DELAYS_SEC,
  deliverWebhook,
  emitWebhookEvent,
  webhookUrlProblem,
} from '../../src/server/webhooks';

interface TestEnv {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
type RouteHandler = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>;
const tokensRoute = (method: string) =>
  (McpTokensRoute.options as unknown as { server: { handlers: Record<string, RouteHandler> } }).server.handlers[method];

vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => ({ userId: 'user_api', isAnonymous: false }),
  tryResolveActor: async () => ({ userId: 'user_api', isAnonymous: false }),
}));

const T0 = Date.parse('2026-10-20T12:00:00Z');
const queue = { send: vi.fn(async (_message: unknown, _options?: { delaySeconds?: number }) => undefined) };
const workerEnv = () =>
  ({ DB: testEnv.DB, AUDIO_BUCKET: testEnv.AUDIO_BUCKET, PROCESSING_QUEUE: queue, AI: {}, VECTORIZE: {} }) as unknown as Parameters<typeof mcpWorker.fetch>[1];
const db = () => drizzle(testEnv.DB, { schema });
const row = (sql: string, ...values: unknown[]) => testEnv.DB.prepare(sql).bind(...values).first();

async function mint(scopes: string[] = ['read']): Promise<string> {
  const response = await tokensRoute('POST')({
    request: new Request('https://eavesy.test/api/mcp-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Script', scopes }),
    }),
    params: {},
  });
  return ((await response.json()) as { token: string }).token;
}

const api = (key: string | null, method: string, path: string, body?: unknown) =>
  mcpWorker.fetch(
    new Request(`https://mcp.eavesy.com/v1${path}`, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    workerEnv(),
  );
const apiJson = async (key: string | null, method: string, path: string, body?: unknown) => {
  const response = await api(key, method, path, body);
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
};

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  queue.send.mockClear();
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM webhook_endpoints'),
    testEnv.DB.prepare('DELETE FROM activity_log'),
    testEnv.DB.prepare('DELETE FROM summaries'),
    testEnv.DB.prepare('DELETE FROM captures'),
    testEnv.DB.prepare('DELETE FROM meetings'),
    testEnv.DB.prepare('DELETE FROM folders'),
    testEnv.DB.prepare('DELETE FROM rate_limits'),
    testEnv.DB.prepare('DELETE FROM mcp_tokens'),
    testEnv.DB.prepare('DELETE FROM users'),
  ]);
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at)
       VALUES ('user_api', 'whisper', 'en', 0, ?, ?), ('user_other', 'whisper', 'en', 0, ?, ?)`,
    ).bind(T0, T0, T0, T0),
    testEnv.DB.prepare(`INSERT INTO folders (id, user_id, name, about, vocabulary_json, match_json) VALUES ('p1', 'user_api', 'Eavesy', '', '[]', '[]')`),
    testEnv.DB.prepare(
      `INSERT INTO meetings (id, user_id, title, started_at, source, status, created_at, updated_at)
       VALUES ('meet_one', 'user_api', 'Standup', ?, 'desktop', 'complete', ?, ?),
              ('meet_theirs', 'user_other', 'Theirs', ?, 'desktop', 'complete', ?, ?)`,
    ).bind(T0, T0, T0, T0, T0, T0),
    testEnv.DB.prepare(
      `INSERT INTO summaries (id, meeting_id, tldr, action_items_json, generated_by_model, generated_at)
       VALUES ('sum_one', 'meet_one', 'Short.', ?, 'test', ?)`,
    ).bind(JSON.stringify([{ text: 'Ship the cask', completed: false }]), T0),
    testEnv.DB.prepare(
      `INSERT INTO captures (id, user_id, kind, capture_mode, source, title, r2_key, content_type, bytes, created_at, updated_at)
       VALUES ('cap_shot', 'user_api', 'image', 'screenshot', 'desktop', 'Screenshot', 'users/user_api/captures/cap_shot.png', 'image/png', 3, ?, ?)`,
    ).bind(T0, T0),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('REST API', () => {
  it('serves its OpenAPI document without a key, covering every route', async () => {
    const response = await api(null, 'GET', '/openapi.json');
    expect(response.status).toBe(200);
    const doc = (await response.json()) as { openapi: string; servers: { url: string }[]; paths: Record<string, Record<string, unknown>> };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers).toEqual([{ url: 'https://mcp.eavesy.com/v1' }]);
    const documented = Object.entries(doc.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`));
    expect(documented.sort()).toEqual(API_ROUTES.map((route) => `${route.method} ${route.path}`).sort());
    expect(JSON.stringify(openApiDocument('https://x.test'))).not.toContain('undefined');
  });

  it('asks for a key in the header, and only in the header', async () => {
    expect(await apiJson(null, 'GET', '/items')).toEqual({ status: 401, body: { error: { code: 'unauthorized', message: expect.stringContaining('Bearer') } } });
    expect((await apiJson('nt_wrong', 'GET', '/items')).status).toBe(401);
    const key = await mint();
    expect((await mcpWorker.fetch(new Request(`https://mcp.eavesy.com/v1/${key}`), workerEnv())).status).toBe(401);
  });

  it('lists, searches and reads items with a read-only key, and only the key owner’s', async () => {
    const key = await mint();
    const listed = await apiJson(key, 'GET', '/items?kinds=meeting,image&limit=5');
    expect(listed.status).toBe(200);
    expect((listed.body.items as { id: string }[]).map((item) => item.id).sort()).toEqual(['cap_shot', 'meet_one']);
    expect(((await apiJson(key, 'GET', '/items?kinds=image')).body.items as { id: string }[]).map((item) => item.id)).toEqual(['cap_shot']);
    expect(((await apiJson(key, 'GET', '/search?q=screenshot&kinds=image')).body.items as { id: string }[]).map((item) => item.id)).toEqual(['cap_shot']);
    expect(await apiJson(key, 'GET', '/search')).toEqual({ status: 400, body: { error: { code: 'invalid_request', message: 'q is required' } } });

    expect((await apiJson(key, 'GET', '/items/meet_one')).body).toMatchObject({ id: 'meet_one', kind: 'meeting', summary: { tldr: 'Short.' } });
    expect((await apiJson(key, 'GET', '/items/meet_theirs')).status).toBe(404);
    expect((await apiJson(key, 'GET', '/projects')).body).toEqual({ projects: [expect.objectContaining({ name: 'Eavesy' })] });
    expect((await apiJson(key, 'GET', '/me')).body).toMatchObject({ connection: { access: ['read'], kind: 'token' } });
    expect((await apiJson(key, 'GET', '/action-items')).body).toEqual({
      action_items: [expect.objectContaining({ index: 0, text: 'Ship the cask', meeting_id: 'meet_one' })],
    });
  });

  it('downloads a capture’s file', async () => {
    const key = await mint();
    await testEnv.AUDIO_BUCKET.put('users/user_api/captures/cap_shot.png', new Uint8Array([1, 2, 3]));
    const response = await api(key, 'GET', '/items/cap_shot/file');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await api(key, 'GET', '/items/meet_one/file')).status).toBe(404);
  });

  it('refuses a change to a read-only key, and makes it with a write key', async () => {
    const readKey = await mint();
    expect((await apiJson(readKey, 'PATCH', '/items/meet_one', { title: 'Nope' })).body).toMatchObject({ error: { code: 'insufficient_scope' } });
    expect(await row(`SELECT title FROM meetings WHERE id = 'meet_one'`)).toEqual({ title: 'Standup' });

    const key = await mint(['read', 'write']);
    expect(await apiJson(key, 'PATCH', '/items/meet_one', { title: 'Daily standup', project: 'Eavesy' })).toEqual({
      status: 200,
      body: { id: 'meet_one', kind: 'meeting', title: 'Daily standup', project: 'Eavesy' },
    });
    expect(await row(`SELECT title, folder_id FROM meetings WHERE id = 'meet_one'`)).toEqual({ title: 'Daily standup', folder_id: 'p1' });
    expect((await apiJson(key, 'PATCH', '/items/meet_one', {})).status).toBe(400);
    expect((await apiJson(key, 'PATCH', '/items/meet_theirs', { title: 'Mine' })).status).toBe(404);

    const note = await apiJson(key, 'POST', '/notes', { text: '# Plan\n\nShip it' });
    expect(note).toEqual({ status: 201, body: expect.objectContaining({ id: expect.stringMatching(/^cap_/), kind: 'note', title: 'Plan' }) });

    expect(await apiJson(key, 'PATCH', '/meetings/meet_one/action-items/0', { completed: true, text: 'Ship the boat' })).toMatchObject({ status: 409 });
    expect(await apiJson(key, 'PATCH', '/meetings/meet_one/action-items/0', { completed: true, text: 'Ship the cask' })).toEqual({
      status: 200,
      body: { meeting_id: 'meet_one', index: 0, text: 'Ship the cask', completed: true },
    });
    expect((await apiJson(key, 'PATCH', '/meetings/meet_one/action-items/7', { completed: true })).status).toBe(404);
    expect((await apiJson(key, 'PATCH', '/meetings/meet_one/action-items/x', { completed: true })).status).toBe(400);
  });

  it('says when an endpoint or method does not exist', async () => {
    const key = await mint();
    expect((await apiJson(key, 'GET', '/nope')).body).toMatchObject({ error: { code: 'not_found' } });
    const wrongMethod = await api(key, 'DELETE', '/items');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');
    expect((await mcpWorker.fetch(new Request('https://mcp.eavesy.com/v1/items', { method: 'OPTIONS' }), workerEnv())).headers.get('access-control-allow-methods')).toContain('PATCH');
  });
});

describe('Webhooks', () => {
  it('only send to a public https URL', () => {
    expect(webhookUrlProblem('https://hooks.example.com/eavesy')).toBeNull();
    expect(webhookUrlProblem('http://hooks.example.com/eavesy')).toBe('url must start with https://');
    expect(webhookUrlProblem('https://127.0.0.1/hook')).toBe('url must use a host name, not an IP address');
    expect(webhookUrlProblem('https://0x7f000001/hook')).toBe('url must use a host name, not an IP address');
    expect(webhookUrlProblem('https://[::1]/hook')).toBe('url must use a host name, not an IP address');
    expect(webhookUrlProblem('https://localhost/hook')).toBe('url must be a public address');
    expect(webhookUrlProblem('https://printer.local/hook')).toBe('url must be a public address');
    expect(webhookUrlProblem('https://user:pw@hooks.example.com/')).toBe('url must not contain a user name or password');
    expect(webhookUrlProblem('not a url')).toContain('full URL');
  });

  it('are added, listed, changed and removed over the API, with the secret shown once', async () => {
    const readKey = await mint();
    expect((await apiJson(readKey, 'POST', '/webhooks', { url: 'https://hooks.example.com/a' })).status).toBe(403);

    const key = await mint(['read', 'write']);
    const created = await apiJson(key, 'POST', '/webhooks', { url: 'https://hooks.example.com/a', description: 'Zapier' });
    expect(created).toEqual({
      status: 201,
      body: expect.objectContaining({
        id: expect.stringMatching(/^whk_/),
        url: 'https://hooks.example.com/a',
        events: ['recording.completed', 'dictation.created', 'capture.created'],
        enabled: true,
        secret: expect.stringMatching(/^whsec_/),
      }),
    });
    const id = created.body.id as string;
    expect((await apiJson(readKey, 'GET', '/webhooks')).body).toEqual({ webhooks: [expect.not.objectContaining({ secret: expect.anything() })] });
    expect((await apiJson(readKey, 'GET', `/webhooks/${id}`)).body).toMatchObject({ id, description: 'Zapier' });

    expect((await apiJson(key, 'POST', '/webhooks', { url: 'https://hooks.example.com/b', events: ['meeting.done'] })).body).toMatchObject({
      error: { code: 'invalid_request', message: expect.stringContaining('unknown event "meeting.done"') },
    });
    expect((await apiJson(key, 'POST', '/webhooks', { url: 'http://hooks.example.com/b' })).status).toBe(400);

    expect((await apiJson(key, 'PATCH', `/webhooks/${id}`, { events: ['capture.created'], enabled: false })).body).toMatchObject({
      events: ['capture.created'],
      enabled: false,
      disabled_reason: 'Turned off.',
    });
    expect((await apiJson(key, 'PATCH', `/webhooks/${id}`, { enabled: true })).body).toMatchObject({ enabled: true, disabled_reason: null });

    expect((await api(key, 'DELETE', `/webhooks/${id}`)).status).toBe(204);
    expect((await apiJson(key, 'GET', `/webhooks/${id}`)).status).toBe(404);
    expect((await api(key, 'DELETE', `/webhooks/${id}`)).status).toBe(404);
  });

  it('stop at ten per account', async () => {
    const key = await mint(['read', 'write']);
    for (let i = 0; i < 10; i++) expect((await apiJson(key, 'POST', '/webhooks', { url: `https://hooks.example.com/${i}` })).status).toBe(201);
    expect((await apiJson(key, 'POST', '/webhooks', { url: 'https://hooks.example.com/11' })).body).toMatchObject({
      error: { message: 'an account can have at most 10 webhook endpoints' },
    });
  });

  it('send a test event signed as Standard Webhooks sign, which the receiver can verify', async () => {
    const key = await mint(['read', 'write']);
    const created = await apiJson(key, 'POST', '/webhooks', { url: 'https://hooks.example.com/a' });
    const received: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      received.push(new Request(input, init));
      return new Response('ok');
    }));
    const tested = await apiJson(key, 'POST', `/webhooks/${String(created.body.id)}/test`);
    expect(tested.body).toEqual({ delivered: true, status: 200, error: null, event_id: expect.stringMatching(/^evt_/) });
    const request = received[0];
    const body = await request.text();
    expect(JSON.parse(body)).toMatchObject({ type: 'webhook.test', id: tested.body.event_id });
    expect(request.headers.get('webhook-id')).toBe(tested.body.event_id);
    expect(await verifySvixWebhook(String(created.body.secret), request.headers, body)).toBe(tested.body.event_id);
    expect(await verifySvixWebhook('whsec_' + btoa('not the secret'), request.headers, body)).toBeNull();
  });

  it('queue an event for each enabled endpoint that wants it', async () => {
    const key = await mint(['read', 'write']);
    const all = (await apiJson(key, 'POST', '/webhooks', { url: 'https://hooks.example.com/all' })).body.id;
    await apiJson(key, 'POST', '/webhooks', { url: 'https://hooks.example.com/dictations', events: ['dictation.created'] });
    const off = (await apiJson(key, 'POST', '/webhooks', { url: 'https://hooks.example.com/off' })).body.id;
    await apiJson(key, 'PATCH', `/webhooks/${String(off)}`, { enabled: false });
    queue.send.mockClear();

    await emitWebhookEvent(
      { DB: testEnv.DB, PROCESSING_QUEUE: queue },
      'user_api',
      'capture.created',
      { id: 'cap_x', kind: 'note', title: 'Plan', created_at: new Date(T0).toISOString(), url: null },
    );
    expect(queue.send.mock.calls).toEqual([
      [{ kind: 'deliver-webhook', endpointId: all, attempt: 1, event: expect.objectContaining({ type: 'capture.created', data: expect.objectContaining({ id: 'cap_x' }) }) }],
    ]);

    queue.send.mockClear();
    await emitWebhookEvent({ DB: testEnv.DB, PROCESSING_QUEUE: queue }, 'user_other', 'capture.created', { id: 'cap_y', kind: 'note', title: 'x', created_at: '', url: null });
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('fire recording.completed once per recording, however many times it is marked complete', async () => {
    const key = await mint(['read', 'write']);
    await apiJson(key, 'POST', '/webhooks', { url: 'https://hooks.example.com/all' });
    queue.send.mockClear();
    const processingEnv = { DB: testEnv.DB, PROCESSING_QUEUE: queue };
    await logMeetingComplete(db(), processingEnv, 'user_api', 'meet_one', T0);
    await logMeetingComplete(db(), processingEnv, 'user_api', 'meet_one', T0 + 1);
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send.mock.calls[0][0]).toMatchObject({
      event: { type: 'recording.completed', data: { id: 'meet_one', kind: 'meeting', title: 'Standup', url: 'https://eavesy.com/app/meetings/meet_one' } },
    });
  });

  it('fire capture.created when an agent saves a note', async () => {
    const key = await mint(['read', 'write']);
    await apiJson(key, 'POST', '/webhooks', { url: 'https://hooks.example.com/all', events: ['capture.created'] });
    queue.send.mockClear();
    const note = await apiJson(key, 'POST', '/notes', { text: 'Hello' });
    expect(queue.send.mock.calls[0][0]).toMatchObject({ event: { type: 'capture.created', data: { id: note.body.id, kind: 'note', title: 'Hello' } } });
  });

  describe('delivery', () => {
    const delivery = (endpointId: string, attempt = 1): WebhookDelivery => ({
      kind: 'deliver-webhook',
      endpointId,
      attempt,
      event: { id: 'evt_1', type: 'capture.created', timestamp: new Date(T0).toISOString(), data: { id: 'cap_x' } },
    });
    const endpoint = async () => {
      const key = await mint(['read', 'write']);
      const id = String((await apiJson(key, 'POST', '/webhooks', { url: 'https://hooks.example.com/a' })).body.id);
      queue.send.mockClear();
      return id;
    };
    const state = (id: string) =>
      row('SELECT last_status, last_error, last_success_at, failed_events, disabled_at, disabled_reason FROM webhook_endpoints WHERE id = ?', id);

    it('records a success and clears earlier failures', async () => {
      const id = await endpoint();
      await testEnv.DB.prepare('UPDATE webhook_endpoints SET failed_events = 3 WHERE id = ?').bind(id).run();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
      await deliverWebhook(db(), queue, delivery(id), T0);
      expect(await state(id)).toEqual({ last_status: 204, last_error: null, last_success_at: T0, failed_events: 0, disabled_at: null, disabled_reason: null });
      expect(queue.send).not.toHaveBeenCalled();
    });

    it('queues the next attempt after a failure, then gives up and in time turns the endpoint off', async () => {
      const id = await endpoint();
      const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
      vi.stubGlobal('fetch', fetchMock);
      await deliverWebhook(db(), queue, delivery(id, 1), T0);
      expect(queue.send).toHaveBeenCalledWith(delivery(id, 2), { delaySeconds: WEBHOOK_RETRY_DELAYS_SEC[0] });
      expect(await state(id)).toMatchObject({ last_status: 500, last_error: 'The endpoint answered HTTP 500.', failed_events: 0 });

      queue.send.mockClear();
      const last = WEBHOOK_RETRY_DELAYS_SEC.length + 1;
      for (let i = 1; i < WEBHOOK_DISABLE_AFTER; i++) await deliverWebhook(db(), queue, delivery(id, last), T0);
      expect(queue.send).not.toHaveBeenCalled();
      expect(await state(id)).toMatchObject({ failed_events: WEBHOOK_DISABLE_AFTER - 1, disabled_at: null });
      await deliverWebhook(db(), queue, delivery(id, last), T0);
      expect(await state(id)).toMatchObject({ failed_events: WEBHOOK_DISABLE_AFTER, disabled_at: T0, disabled_reason: expect.stringContaining('Turned off after 5') });

      fetchMock.mockClear();
      await deliverWebhook(db(), queue, delivery(id, 1), T0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats a redirect or a dead host as a failure, and drops a delivery to a removed endpoint', async () => {
      const id = await endpoint();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com' } })));
      await deliverWebhook(db(), queue, delivery(id), T0);
      expect(await state(id)).toMatchObject({ last_status: 302, last_error: 'The endpoint answered HTTP 302.' });

      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new TypeError('connect failed');
      }));
      await deliverWebhook(db(), queue, delivery(id), T0);
      expect(await state(id)).toMatchObject({ last_status: null, last_error: 'Could not connect to the endpoint.' });

      await testEnv.DB.prepare('DELETE FROM webhook_endpoints').run();
      queue.send.mockClear();
      await deliverWebhook(db(), queue, delivery(id), T0);
      expect(queue.send).not.toHaveBeenCalled();
    });
  });
});
