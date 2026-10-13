import { expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
mock.module('@/server/cloudflare-context', () => ({
  getCloudflareContext: () => ({
    env: {
      CACHE: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => void store.set(key, value),
      },
    },
  }),
}));
const { guardUserQuota } = await import('@/server/rate-limit');

test('each user gets their own daily quota per scope', async () => {
  process.env.QUOTA_REGENERATE_PER_DAY = '2';
  expect(await guardUserQuota('u1', 'regenerate')).toBeNull();
  expect(await guardUserQuota('u1', 'regenerate')).toBeNull();

  const blocked = await guardUserQuota('u1', 'regenerate');
  expect(blocked?.status).toBe(429);
  expect(await blocked?.json()).toMatchObject({ code: 'daily_quota' });

  expect(await guardUserQuota('u2', 'regenerate')).toBeNull();
  expect(await guardUserQuota('u1', 'chat')).toBeNull();
  delete process.env.QUOTA_REGENERATE_PER_DAY;
});
