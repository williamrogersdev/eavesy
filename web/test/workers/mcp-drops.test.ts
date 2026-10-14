import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mcpWorker from '../../../workers/mcp/src/index';
import { publish } from '../../src/server/drops-hub';
import { INLINE_TEXT_MAX_BYTES, MAX_TEXT_BYTES, PREVIEW_CHARS } from '../../src/server/drops';

// The DropsHub Durable Object lives in the web worker; here we only check what
// would be broadcast to it.
vi.mock('../../src/server/drops-hub', () => ({ publish: vi.fn(async () => {}) }));

interface TestEnv {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;

const RAW_TOKEN = 'mcp-test-token';

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function rpc(method: string, params: unknown, token = RAW_TOKEN) {
  const request = new Request('https://mcp.eavesy.com/', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const ctx = createExecutionContext();
  const worker = mcpWorker as unknown as {
    fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
  };
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function send(args: Record<string, unknown>) {
  const body = (await (await rpc('tools/call', { name: 'send_to_my_devices', arguments: args })).json()) as {
    result?: { content: { text: string }[] };
    error?: { message: string };
  };
  return { result: body.result ? JSON.parse(body.result.content[0].text) : undefined, error: body.error };
}

const dropRow = (id: string) =>
  testEnv.DB.prepare('SELECT * FROM drops WHERE id = ?').bind(id).first<{
    user_id: string;
    kind: string;
    text: string | null;
    preview: string;
    r2_key: string | null;
    bytes: number;
    device_label: string;
  }>();

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at)
       VALUES ('owner', 'whisper', 'en', 0, ?, ?)`,
    ).bind(now, now),
    testEnv.DB.prepare(
      `INSERT INTO mcp_tokens (id, user_id, token_hash, name, created_at) VALUES ('mcp1', 'owner', ?, 'Claude Code', ?)`,
    ).bind(await sha256Hex(RAW_TOKEN), now),
  ]);
});

beforeEach(() => {
  vi.mocked(publish).mockClear();
});

describe('MCP send_to_my_devices', () => {
  it('is listed in tools/list', async () => {
    const body = (await (await rpc('tools/list', {})).json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((tool) => tool.name)).toContain('send_to_my_devices');
  });

  it('stores a text drop for the token owner and broadcasts it', async () => {
    const { result, error } = await send({ text: 'Next steps:\n- ship it', title: 'Session handoff' });
    expect(error).toBeUndefined();
    expect(result.id).toMatch(/^drp_/);

    const row = await dropRow(result.id);
    expect(row).toMatchObject({
      user_id: 'owner',
      kind: 'text',
      text: '# Session handoff\n\nNext steps:\n- ship it',
      r2_key: null,
      device_label: 'Claude Code (MCP)',
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('owner', {
      type: 'drop',
      origin: null,
      drop: expect.objectContaining({ id: result.id, kind: 'text', text: row!.text, deviceLabel: 'Claude Code (MCP)' }),
    });
  });

  it('puts large text in R2 and keeps a preview in D1', async () => {
    const text = 'x'.repeat(INLINE_TEXT_MAX_BYTES + 1);
    const { result } = await send({ text });
    const row = await dropRow(result.id);
    expect(row).toMatchObject({ text: null, bytes: text.length, r2_key: `users/owner/drops/${result.id}/text.txt` });
    expect(row!.preview).toHaveLength(PREVIEW_CHARS);
    expect(await (await testEnv.AUDIO_BUCKET.get(row!.r2_key!))!.text()).toBe(text);
  });

  it('rejects empty and oversized text without writing anything', async () => {
    expect((await send({ text: '   ' })).error?.message).toBe('text is required');
    expect((await send({ text: 'x'.repeat(MAX_TEXT_BYTES + 1) })).error?.message).toMatch(/too large/);
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses an unknown token', async () => {
    const response = await rpc('tools/call', { name: 'send_to_my_devices', arguments: { text: 'hi' } }, 'nope');
    expect(response.status).toBe(401);
  });
});
