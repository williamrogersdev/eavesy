import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route as sessionRoute } from '../../src/routes/api/sessions/$id/index';
import { handler, insertMeeting, insertUser, resetTables, row, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: 'user_mac', deviceId: 'dev_this' as string | undefined }));
vi.mock('../../src/server/device-auth', () => ({
  resolveIngestActor: async () => ({ userId: actor.userId, deviceId: actor.deviceId, isAnonymous: false }),
}));

const cancel = handler(sessionRoute, 'DELETE');

async function meeting(id: string, status: string, deviceId: string | null) {
  await insertMeeting({ id, userId: 'user_mac', status });
  await testEnv.DB.prepare('UPDATE meetings SET device_id = ? WHERE id = ?').bind(deviceId, id).run();
}

async function remove(id: string) {
  return cancel({ request: new Request(`https://eavesy.test/api/sessions/${id}`, { method: 'DELETE' }), params: { id } });
}

async function deleted(id: string) {
  return (await row<{ deleted_at: number | null }>('SELECT deleted_at FROM meetings WHERE id = ?', id))?.deleted_at != null;
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  actor.deviceId = 'dev_this';
  await resetTables('activity_log', 'meetings', 'users');
  await insertUser('user_mac');
});

describe('DELETE /api/sessions/:id', () => {
  it('deletes a recording this Mac is still making', async () => {
    await meeting('m_live', 'recording', 'dev_this');
    expect((await remove('m_live')).status).toBe(200);
    expect(await deleted('m_live')).toBe(true);
    // Gone is gone: a retry is told so, and the Mac forgets it.
    expect((await remove('m_live')).status).toBe(404);
  });

  it('leaves a finished meeting alone', async () => {
    await meeting('m_done', 'complete', 'dev_this');
    expect((await remove('m_done')).status).toBe(409);
    expect(await deleted('m_done')).toBe(false);
  });

  it('leaves another Mac’s recording alone', async () => {
    await meeting('m_other', 'recording', 'dev_other');
    expect((await remove('m_other')).status).toBe(409);
    expect(await deleted('m_other')).toBe(false);
  });
});
