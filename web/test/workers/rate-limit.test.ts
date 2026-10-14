import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Database } from '@cloudflare/workers-types';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { consumeRateLimit, pruneRateLimits } from '../../src/server/rate-limit-store';
import { guardUserQuota } from '../../src/server/rate-limit';
import { Route as SessionsRoute } from '../../src/routes/api/sessions/index';

interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
type RouteHandler = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>;
const createSession = (SessionsRoute.options as unknown as { server: { handlers: { POST: RouteHandler } } }).server
  .handlers.POST;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM rate_limits'),
    testEnv.DB.prepare('DELETE FROM meetings'),
    testEnv.DB.prepare('DELETE FROM device_tokens'),
    testEnv.DB.prepare('DELETE FROM devices'),
    testEnv.DB.prepare('DELETE FROM users'),
  ]);
});

afterEach(() => {
  delete process.env.RL_SESSION_CREATE_PER_WINDOW;
});

const brokenDb = {
  prepare: () => {
    throw new Error('D1 is unavailable');
  },
} as unknown as D1Database;

describe('rate limiting', () => {
  it('admits exactly the limit when requests arrive together', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        consumeRateLimit(testEnv.DB, { key: 'burst:user_a', limit: 5, windowSec: 60, failMode: 'closed' }),
      ),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    const refused = results.find((result) => !result.allowed);
    expect(refused?.retryAfterSec).toBeGreaterThan(0);
  });

  it('starts a fresh count in the next window', async () => {
    const policy = { key: 'window:user_a', limit: 1, windowSec: 60, failMode: 'closed' as const };
    const start = Date.UTC(2026, 9, 14, 12, 0, 0);
    expect((await consumeRateLimit(testEnv.DB, policy, start)).allowed).toBe(true);
    expect((await consumeRateLimit(testEnv.DB, policy, start + 30_000)).allowed).toBe(false);
    expect((await consumeRateLimit(testEnv.DB, policy, start + 60_000)).allowed).toBe(true);
  });

  it('fails open or closed as the route chooses when the counter is unreachable', async () => {
    const base = { key: 'outage', limit: 5, windowSec: 60 };
    expect((await consumeRateLimit(brokenDb, { ...base, failMode: 'open' })).allowed).toBe(true);
    expect((await consumeRateLimit(brokenDb, { ...base, failMode: 'closed' })).allowed).toBe(false);
    expect((await consumeRateLimit(null, { ...base, failMode: 'closed' })).allowed).toBe(false);
  });

  it('keeps per-user daily quotas separate', async () => {
    process.env.QUOTA_REGENERATE_PER_DAY = '2';
    try {
      expect(await guardUserQuota('u1', 'regenerate')).toBeNull();
      expect(await guardUserQuota('u1', 'regenerate')).toBeNull();
      const blocked = await guardUserQuota('u1', 'regenerate');
      expect(blocked?.status).toBe(429);
      expect(await blocked?.json()).toMatchObject({ code: 'daily_quota' });
      expect(await guardUserQuota('u2', 'regenerate')).toBeNull();
    } finally {
      delete process.env.QUOTA_REGENERATE_PER_DAY;
    }
  });

  it('limits session creation per user', async () => {
    process.env.RL_SESSION_CREATE_PER_WINDOW = '2';
    const token = await insertDeviceActor('user_sessions', 'device_sessions');
    const create = () =>
      createSession({
        request: new Request('https://eavesy.test/api/sessions', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ clientSessionId: crypto.randomUUID() }),
        }),
        params: {},
      });

    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(201);
    const limited = await create();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('prunes expired windows', async () => {
    const now = Date.now();
    await testEnv.DB.prepare('INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?), (?, 1, ?)')
      .bind('old:1', now - 1, 'live:1', now + 60_000)
      .run();
    await pruneRateLimits(testEnv.DB, now);
    const keys = await testEnv.DB.prepare('SELECT key FROM rate_limits').all<{ key: string }>();
    expect(keys.results.map((row) => row.key)).toEqual(['live:1']);
  });
});

async function insertDeviceActor(userId: string, deviceId: string): Promise<string> {
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO users (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at)
     VALUES (?, 'whisper', 'en', 0, ?, ?)`,
  )
    .bind(userId, now, now)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO devices (id, user_id, name, platform, root_folder_path, last_seen_at, created_at)
     VALUES (?, ?, 'Test Mac', 'macos', '/tmp/Eavesy', ?, ?)`,
  )
    .bind(deviceId, userId, now, now)
    .run();
  const rawToken = `eavesy_device_${userId}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken));
  const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  await testEnv.DB.prepare(
    `INSERT INTO device_tokens (id, user_id, device_id, token_hash, name, created_at)
     VALUES (?, ?, ?, ?, 'Test Mac', ?)`,
  )
    .bind(`token_${deviceId}`, userId, deviceId, tokenHash, now)
    .run();
  return rawToken;
}
