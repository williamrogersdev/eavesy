import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Database } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as dictionary from '../../src/db/repo/dictionary';
import * as dbSchema from '../../src/db/schema';
import { registerDevice, STALE_DEVICE_MS } from '../../src/server/pair-device';
import { Route as DevicesMeRoute } from '../../src/routes/api/devices/me';
import { Route as PairStartRoute } from '../../src/routes/api/devices/pair/start';

interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const db = () => drizzle(testEnv.DB, { schema: dbSchema });
type RouteHandler = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>;
const devicesMeDelete = (
  DevicesMeRoute.options as unknown as { server: { handlers: { DELETE: RouteHandler } } }
).server.handlers.DELETE;

const pairStart = (
  PairStartRoute.options as unknown as { server: { handlers: { POST: RouteHandler } } }
).server.handlers.POST;
const startPairing = (body: Record<string, string>) =>
  pairStart({
    request: new Request('https://eavesy.test/api/devices/pair/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: {},
  });

const DEVICE = '6f1c2a4e-1b2c-4d3e-8f90-123456789abc';

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM personal_dictionary'),
    testEnv.DB.prepare('DELETE FROM device_pairing_codes'),
    testEnv.DB.prepare('DELETE FROM device_tokens'),
    testEnv.DB.prepare('DELETE FROM devices'),
    testEnv.DB.prepare('DELETE FROM users'),
  ]);
  for (const id of ['owner', 'other']) {
    const now = Date.now();
    await testEnv.DB.prepare(
      `INSERT INTO users
        (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at)
       VALUES (?, 'whisper', 'en', 0, ?, ?)`,
    )
      .bind(id, now, now)
      .run();
  }
});

const pair = (userId: string) =>
  registerDevice(db(), { userId, deviceId: DEVICE, name: 'Mac', rootFolderPath: '/tmp/Eavesy', allowTransfer: true });

async function activeTokens(userId: string): Promise<number> {
  const row = await testEnv.DB.prepare(
    'SELECT count(*) AS n FROM device_tokens WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL',
  )
    .bind(DEVICE, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('moving a Mac between accounts', () => {
  it('refuses while the current account holds a live credential for it', async () => {
    await pair('owner');
    await expect(pair('other')).rejects.toThrow('device_already_registered');
    expect(await activeTokens('owner')).toBe(1);
  });

  it('allows it once the Mac has signed itself out', async () => {
    const token = await pair('owner');
    const signedOut = await devicesMeDelete({
      request: new Request('https://eavesy.test/api/devices/me', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      }),
      params: {},
    });
    expect(signedOut.status).toBe(204);
    expect(await activeTokens('owner')).toBe(0);

    await pair('other');
    expect(await activeTokens('other')).toBe(1);
  });

  it('allows it when the old credential has gone stale', async () => {
    await pair('owner');
    await testEnv.DB.prepare('UPDATE device_tokens SET last_used_at = ? WHERE device_id = ?')
      .bind(Date.now() - STALE_DEVICE_MS - 1, DEVICE)
      .run();

    await pair('other');
    expect(await activeTokens('owner')).toBe(0);
    expect(await activeTokens('other')).toBe(1);
  });
});

it('feeds learned spellings only to the owning Mac recognizer', async () => {
  const token = await pair('owner');
  await dictionary.remember(db(), 'owner', [{ from: 'repack a fi', to: 'Repackify' }], 'manual');
  await dictionary.remember(db(), 'other', [{ from: 'private phrase', to: 'Other account secret' }], 'manual');
  const get = (DevicesMeRoute.options as unknown as { server: { handlers: { GET: RouteHandler } } }).server.handlers.GET;
  const response = await get({ request: new Request('https://eavesy.test/api/devices/me', { headers: { authorization: `Bearer ${token}` } }), params: {} });
  expect(response.status).toBe(200);
  const body = await response.json() as { vocabulary: string[] };
  expect(body.vocabulary).toContain('Repackify');
  expect(body.vocabulary).not.toContain('Other account secret');
  const custom = Array.from({ length: 500 }, (_, i) => `custom${i}`);
  await testEnv.DB.prepare('UPDATE users SET custom_vocabulary_json=? WHERE id=?').bind(JSON.stringify(custom), 'owner').run();
  const again = await get({ request: new Request('https://eavesy.test/api/devices/me', { headers: { authorization: `Bearer ${token}` } }), params: {} });
  const newest = await again.json() as { vocabulary: string[] };
  expect(newest.vocabulary).toHaveLength(500);
  expect(newest.vocabulary.at(-1)).toBe('Repackify');
  expect(newest.vocabulary).toContain('custom499');
  expect(newest.vocabulary).not.toContain('custom0');
});

it('atomically admits one of two competing dictionary inserts at capacity in D1', async () => {
  await testEnv.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<499)
    INSERT INTO personal_dictionary(id,user_id,source_key,from_text,to_text,created_at,updated_at)
    SELECT 'word_'||i,'owner','source_'||i,'source_'||i,'target_'||i,1,1 FROM n`).run();
  const counts = await Promise.all([
    dictionary.remember(db(), 'owner', [{ from: 'misheard alpha', to: 'Alpha' }], 'manual'),
    dictionary.remember(db(), 'owner', [{ from: 'misheard beta', to: 'Beta' }], 'manual'),
  ]);
  expect(counts.reduce((a, b) => a+b, 0)).toBe(1);
  expect(await dictionary.list(db(), 'owner')).toHaveLength(500);
});

describe('pairing a phone', () => {
  it('records the platform it paired as', async () => {
    await registerDevice(db(), { userId: 'owner', deviceId: DEVICE, name: 'Eavesy for iPhone', rootFolderPath: 'On this iPhone', platform: 'ios' });
    const row = await testEnv.DB.prepare('SELECT platform FROM devices WHERE id = ?').bind(DEVICE).first<{ platform: string }>();
    expect(row?.platform).toBe('ios');
  });

  it('keeps calling a device a Mac when it does not say', async () => {
    await pair('owner');
    const row = await testEnv.DB.prepare('SELECT platform FROM devices WHERE id = ?').bind(DEVICE).first<{ platform: string }>();
    expect(row?.platform).toBe('macos');
  });

  it('starts a code for a phone, which has no recordings folder to name', async () => {
    const response = await startPairing({ deviceId: DEVICE, name: 'Eavesy for iPhone', platform: 'ios' });
    expect(response.status).toBe(200);
    const row = await testEnv.DB.prepare('SELECT platform, root_folder_path AS root FROM device_pairing_codes WHERE device_id = ?')
      .bind(DEVICE)
      .first<{ platform: string; root: string }>();
    expect(row).toEqual({ platform: 'ios', root: 'On this iPhone' });
  });

  it('still requires a Mac to name its recordings folder', async () => {
    expect((await startPairing({ deviceId: DEVICE, name: 'Eavesy for Mac' })).status).toBe(400);
    const response = await startPairing({ deviceId: DEVICE, name: 'Eavesy for Mac', rootFolderPath: '~/Eavesy/Recordings' });
    expect(response.status).toBe(200);
    const row = await testEnv.DB.prepare('SELECT platform FROM device_pairing_codes WHERE device_id = ?').bind(DEVICE).first<{ platform: string }>();
    expect(row?.platform).toBe('macos');
  });
});
