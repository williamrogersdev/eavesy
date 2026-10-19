import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route as sessionsRoute } from '../../src/routes/api/sessions/index';
import { handler, insertMeeting, insertUser, resetTables, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: 'user_mac' as string | null, deviceId: 'dev_this' as string | undefined }));
vi.mock('../../src/server/device-auth', () => ({
  resolveIngestActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, deviceId: actor.deviceId, isAnonymous: false };
  },
}));

const list = handler(sessionsRoute, 'GET');

async function meeting(id: string, args: { deviceId?: string; status?: string; deleted?: boolean; startedAt: number }) {
  await insertMeeting({ id, userId: 'user_mac', status: args.status ?? 'complete' });
  await testEnv.DB.prepare('UPDATE meetings SET device_id = ?, started_at = ?, deleted_at = ? WHERE id = ?')
    .bind(args.deviceId ?? null, args.startedAt, args.deleted ? Date.now() : null, id)
    .run();
}

async function ids(query = '') {
  const response = await list({ request: new Request(`https://eavesy.test/api/sessions${query}`), params: {} });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: { id: string }[] };
  return body.items.map((item) => item.id);
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  actor.userId = 'user_mac';
  actor.deviceId = 'dev_this';
  await resetTables('meetings', 'users');
  await insertUser('user_mac');
  await meeting('m_other', { deviceId: 'dev_other', startedAt: 5 });
  await meeting('m_web', { startedAt: 4 });
  await meeting('m_this', { deviceId: 'dev_this', startedAt: 3 });
  await meeting('m_deleted', { deviceId: 'dev_other', deleted: true, startedAt: 2 });
  await meeting('m_processing', { deviceId: 'dev_other', status: 'processing', startedAt: 1 });
});

describe('GET /api/sessions', () => {
  it('lists finished meetings this device did not record, newest first', async () => {
    expect(await ids()).toEqual(['m_other', 'm_web']);
  });

  it('pages with offset', async () => {
    expect(await ids('?limit=1')).toEqual(['m_other']);
    expect(await ids('?limit=1&offset=1')).toEqual(['m_web']);
    expect(await ids('?limit=1&offset=2')).toEqual([]);
    expect(await ids('?offset=1000000')).toEqual([]);
  });

  it('lists every finished meeting for a caller without a device', async () => {
    actor.deviceId = undefined;
    expect(await ids()).toEqual(['m_other', 'm_web', 'm_this']);
  });

  it('answers 401 without credentials', async () => {
    actor.userId = null;
    const response = await list({ request: new Request('https://eavesy.test/api/sessions'), params: {} });
    expect(response.status).toBe(401);
  });
});
