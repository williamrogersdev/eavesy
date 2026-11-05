import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route as attachmentRoute } from '../../src/routes/api/sessions/$id/attachments/$name';
import { getDb } from '../../src/db/client';
import * as attachmentsRepo from '../../src/db/repo/attachments';
import * as meetingsRepo from '../../src/db/repo/meetings';
import { handler, insertMeeting, insertUser, resetTables, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: 'user_mac' }));
vi.mock('../../src/server/device-auth', () => ({
  resolveIngestActor: async () => ({ userId: actor.userId, deviceId: 'dev_this', isAnonymous: false }),
}));

const put = handler(attachmentRoute, 'PUT');

/** A PNG's first bytes: enough for its signature and its size. */
function png(width = 1600, height = 900): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function upload(name: string, body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) {
  return put({
    request: new Request(`https://eavesy.test/api/sessions/m_live/attachments/${name}`, {
      method: 'PUT',
      body,
      headers: {
        'content-type': 'image/jpeg',
        'x-attachment-kind': name.split('-')[0],
        'x-attachment-offset-ms': '65432',
        'content-length': String(body.byteLength),
        ...headers,
      },
    }),
    params: { id: 'm_live', name },
  });
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  actor.userId = 'user_mac';
  await resetTables('meeting_attachments', 'meetings', 'users');
  await insertUser('user_mac');
  await insertUser('user_other');
  await insertMeeting({ id: 'm_live', userId: 'user_mac', status: 'recording' });
});

describe('PUT /api/sessions/:id/attachments/:name', () => {
  it('stores a picture once, at its offset, typed by its bytes', async () => {
    // Claims JPEG; the bytes say PNG, and PNG is what is stored.
    expect((await upload('screenshot-000065432', png())).status).toBe(201);
    const retry = await upload('screenshot-000065432', png());
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ idempotent: true });

    const [stored] = await attachmentsRepo.listForMeeting(getDb(), 'm_live');
    expect(stored).toMatchObject({
      kind: 'screenshot',
      offsetMs: 65_432,
      contentType: 'image/png',
      width: 1600,
      height: 900,
      caption: null,
      r2Key: 'users/user_mac/meetings/m_live/attachments/screenshot-000065432.png',
    });
    expect(await testEnv.AUDIO_BUCKET.head(stored.r2Key)).not.toBeNull();

    // The meeting page gets it, and the captioning queue sees it until it is described.
    const full = await meetingsRepo.getFull(getDb(), { meetingId: 'm_live', userId: 'user_mac' });
    expect(full?.attachments).toEqual([expect.objectContaining({ kind: 'screenshot', offsetMs: 65_432 })]);
    expect(await attachmentsRepo.listUncaptioned(getDb(), { meetingId: 'm_live' })).toHaveLength(1);
    await attachmentsRepo.setCaption(getDb(), { id: stored.id, caption: 'Q3 revenue chart', model: 'test' });
    expect(await attachmentsRepo.listUncaptioned(getDb(), { meetingId: 'm_live' })).toHaveLength(0);
  });

  it('refuses what is not a picture, or not described right', async () => {
    expect((await upload('snapshot-000000001', new TextEncoder().encode('<svg/>'))).status).toBe(415);
    expect((await upload('snapshot-000000001', new Uint8Array())).status).toBe(400);
    expect((await upload('snapshot-1x', png())).status).toBe(400);
    expect((await upload('snapshot-000000001', png(), { 'x-attachment-kind': 'screenshot' })).status).toBe(400);
    expect((await upload('snapshot-000000001', png(), { 'x-attachment-offset-ms': '-1' })).status).toBe(400);
    expect((await upload('snapshot-000000001', png(), { 'content-length': 'lots' })).status).toBe(411);
    expect((await upload('snapshot-000000001', png(), { 'content-length': String(21 * 1024 * 1024) })).status).toBe(413);
    expect(await attachmentsRepo.listForMeeting(getDb(), 'm_live')).toHaveLength(0);
  });

  it('only takes pictures for the caller’s own meeting', async () => {
    actor.userId = 'user_other';
    expect((await upload('snapshot-000000001', png())).status).toBe(404);
  });
});
