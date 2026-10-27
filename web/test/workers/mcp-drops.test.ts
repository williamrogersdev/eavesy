import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { worker as mcpWorker } from '../../../workers/mcp/src/index';
import { publish } from '../../src/server/drops-hub';
import { INLINE_TEXT_MAX_BYTES, MAX_TEXT_BYTES, PREVIEW_CHARS } from '../../src/server/drops';
import { sha256Hex } from '../../src/lib/sha256';

// The DropsHub Durable Object lives in the web worker; here we only check what
// would be broadcast to it.
vi.mock('../../src/server/drops-hub', () => ({ publish: vi.fn(async () => {}) }));

interface TestEnv {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;

const WRITE_TOKEN = 'mcp-drops-write-token';
const READ_TOKEN = 'mcp-drops-read-token';

const mcpEnv = () =>
  ({ DB: testEnv.DB, AI: {}, VECTORIZE: {}, AUDIO_BUCKET: testEnv.AUDIO_BUCKET }) as unknown as Parameters<typeof mcpWorker.fetch>[1];

async function rpc(method: string, params: unknown, token = WRITE_TOKEN) {
  return mcpWorker.fetch(
    new Request('https://mcp.eavesy.com/', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    mcpEnv(),
  );
}

async function send(args: Record<string, unknown>, token = WRITE_TOKEN) {
  const body = await (await rpc('tools/call', { name: 'send_to_my_devices', arguments: args }, token)).json<{
    result?: { content: { text: string }[]; isError?: boolean };
    error?: { message: string };
  }>();
  return {
    result: body.result && !body.result.isError ? JSON.parse(body.result.content[0].text) : undefined,
    refused: body.result?.isError ? body.result.content[0].text : undefined,
    error: body.error,
  };
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
const dropCount = async () => (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drops').first<{ n: number }>())!.n;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  vi.mocked(publish).mockClear();
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM drops'),
    testEnv.DB.prepare('DELETE FROM mcp_tokens'),
    testEnv.DB.prepare('DELETE FROM users'),
    testEnv.DB.prepare(
      `INSERT INTO users (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at)
       VALUES ('owner', 'whisper', 'en', 0, ?, ?)`,
    ).bind(now, now),
    testEnv.DB.prepare(
      `INSERT INTO mcp_tokens (id, user_id, token_hash, name, scopes_json, created_at)
       VALUES ('mcp_w', 'owner', ?, 'Claude Code', '["read","write"]', ?)`,
    ).bind(await sha256Hex(WRITE_TOKEN), now),
    testEnv.DB.prepare(
      `INSERT INTO mcp_tokens (id, user_id, token_hash, name, scopes_json, created_at)
       VALUES ('mcp_r', 'owner', ?, 'Reader', '["read"]', ?)`,
    ).bind(await sha256Hex(READ_TOKEN), now),
  ]);
});

describe('MCP send_to_my_devices', () => {
  it('is listed, as a non-read-only tool, only for a connection with write access', async () => {
    type Listed = { result: { tools: { name: string; annotations: Record<string, boolean> }[] } };
    const writer = await (await rpc('tools/list', {})).json<Listed>();
    const tool = writer.result.tools.find((t) => t.name === 'send_to_my_devices');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });

    const reader = await (await rpc('tools/list', {}, READ_TOKEN)).json<Listed>();
    expect(reader.result.tools.map((t) => t.name)).not.toContain('send_to_my_devices');
  });

  it('is refused for a read-only connection without writing anything', async () => {
    const { refused } = await send({ text: 'hi' }, READ_TOKEN);
    expect(refused).toContain('needs write access');
    expect(await dropCount()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('stores a text drop for the token owner and broadcasts it', async () => {
    const { result, error } = await send({ text: 'Next steps:\n- ship it', title: '  Session\nhandoff ' });
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

  it('adds no heading for a blank title', async () => {
    const { result } = await send({ text: 'body', title: ' \n\t ' });
    expect((await dropRow(result.id))?.text).toBe('body');
  });

  it('ignores any user named in the arguments', async () => {
    const { result } = await send({ text: 'mine', userId: 'someone-else', user_id: 'someone-else' });
    expect((await dropRow(result.id))?.user_id).toBe('owner');
  });

  it('puts large text in R2 and keeps a preview in D1', async () => {
    const text = 'x'.repeat(INLINE_TEXT_MAX_BYTES + 1);
    const { result } = await send({ text });
    const row = await dropRow(result.id);
    expect(row).toMatchObject({ text: null, bytes: text.length, r2_key: `users/owner/drops/${result.id}/text.txt` });
    expect(row!.preview).toHaveLength(PREVIEW_CHARS);
    expect(await (await testEnv.AUDIO_BUCKET.get(row!.r2_key!))!.text()).toBe(text);
  });

  it('rejects empty text, an overlong title and oversized text without writing anything', async () => {
    expect((await send({ text: '   ' })).error?.message).toBe('text is required');
    expect((await send({ text: 'hi', title: 't'.repeat(201) })).error?.message).toMatch(/title/);
    expect((await send({ text: 'x'.repeat(MAX_TEXT_BYTES + 1) })).error?.message).toMatch(/too large/);
    expect(await dropCount()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses an unknown token', async () => {
    const response = await rpc('tools/call', { name: 'send_to_my_devices', arguments: { text: 'hi' } }, 'nope');
    expect(response.status).toBe(401);
  });
});
