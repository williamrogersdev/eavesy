import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { worker } from '../../../workers/processing/src/index';
import type { ProcessingMessage } from '../../src/server/processing-worker';
import { Route as PairRoute } from '../../src/routes/api/devices/pair';
import { Route as PairStatusRoute } from '../../src/routes/api/devices/pair/status';
import { Route as SegmentRoute } from '../../src/routes/api/sessions/$id/segments/$idx';
import {
  handler,
  insertDeviceActor,
  insertMeeting,
  insertSegment,
  insertUser,
  mockQueue,
  requestBody,
  resetTables,
  row,
  runtimeEnv,
  sha256,
  testEnv,
} from './support';

const actor = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
  tryResolveActor: async () => (actor.userId ? { userId: actor.userId, isAnonymous: false } : null),
}));

const segmentPut = handler(SegmentRoute, 'PUT');
const pairPost = handler(PairRoute, 'POST');
const pairStatus = handler(PairStatusRoute, 'POST');

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  actor.userId = null;
  await resetTables(
    'transcript_segments',
    'meeting_segments',
    'meetings',
    'device_pairing_codes',
    'device_tokens',
    'devices',
    'activity_log',
    'users',
  );
});

function segmentRequest(meetingId: string, idx: number, token: string): Request {
  const body = new Uint8Array([1, 2, 3, 4]);
  return new Request(`https://eavesy.test/api/sessions/${meetingId}/segments/${idx}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-length': String(body.byteLength),
      'content-type': 'audio/mp4',
      'x-segment-duration-ms': '3000',
      'x-segment-start-ms': String(idx * 3000),
    },
    body: requestBody(body),
  });
}

describe('concurrent segment uploads', () => {
  it('stores one row and answers both requests successfully', async () => {
    const token = await insertDeviceActor('user_dup', 'device_dup');
    await insertMeeting({ id: 'meet_dup', userId: 'user_dup', status: 'recording' });

    const responses = await Promise.all(
      [0, 1, 2].map(() => segmentPut({ request: segmentRequest('meet_dup', 0, token), params: { id: 'meet_dup', idx: '0' } })),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 202]);
    expect(
      await row<{ count: number }>('SELECT count(*) AS count FROM meeting_segments WHERE meeting_id = ?', 'meet_dup'),
    ).toEqual({ count: 1 });
  });
});

describe('concurrent transcribe jobs', () => {
  it('lets only one job transcribe a segment; the other waits and retries', async () => {
    await insertUser('user_claim');
    await insertMeeting({ id: 'meet_claim', userId: 'user_claim', status: 'uploading' });
    const key = 'users/user_claim/meetings/meet_claim/segments/000000.m4a';
    await insertSegment({ id: 'mseg_claim', meetingId: 'meet_claim', idx: 0, r2Key: key });
    await testEnv.AUDIO_BUCKET.put(key, new Uint8Array([1, 2, 3]));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ai = {
      run: vi.fn(async () => {
        await gate;
        return { text: 'hello', segments: [{ start: 0, end: 1, text: 'hello' }] };
      }),
    };
    const message = { kind: 'transcribe-segment', meetingId: 'meet_claim', idx: 0 } as const;
    const first = createMessageBatch<ProcessingMessage>('eavesy-processing', [
      { id: 'first', timestamp: new Date(), attempts: 1, body: message },
    ]);
    const second = createMessageBatch<ProcessingMessage>('eavesy-processing', [
      { id: 'second', timestamp: new Date(), attempts: 1, body: message },
    ]);
    const env = runtimeEnv(mockQueue().binding, ai);

    const running = worker.queue(first, env);
    await vi.waitFor(() => expect(ai.run).toHaveBeenCalledTimes(1));
    await worker.queue(second, env);
    release();
    await running;

    expect(ai.run).toHaveBeenCalledTimes(1);
    const firstResult = await getQueueResult(first, createExecutionContext());
    const secondResult = await getQueueResult(second, createExecutionContext());
    expect(firstResult.explicitAcks).toEqual(['first']);
    expect(secondResult.retryMessages.map((retry: { msgId: string }) => retry.msgId)).toEqual(['second']);
    expect(
      await row<{ transcribe_status: string }>('SELECT transcribe_status FROM meeting_segments WHERE id = ?', 'mseg_claim'),
    ).toEqual({ transcribe_status: 'complete' });
  });

  it('reclaims a segment whose worker died mid-transcription', async () => {
    await insertUser('user_stale');
    await insertMeeting({ id: 'meet_stale', userId: 'user_stale', status: 'uploading' });
    const key = 'users/user_stale/meetings/meet_stale/segments/000000.m4a';
    await insertSegment({ id: 'mseg_stale', meetingId: 'meet_stale', idx: 0, r2Key: key });
    await testEnv.AUDIO_BUCKET.put(key, new Uint8Array([1, 2, 3]));
    await testEnv.DB.prepare(
      "UPDATE meeting_segments SET transcribe_status = 'processing', transcribe_claimed_at = ? WHERE id = ?",
    )
      .bind(Date.now() - 60 * 60 * 1000, 'mseg_stale')
      .run();

    const ai = { run: vi.fn(async () => ({ text: 'back', segments: [{ start: 0, end: 1, text: 'back' }] })) };
    const batch = createMessageBatch<ProcessingMessage>('eavesy-processing', [
      { id: 'redelivered', timestamp: new Date(), attempts: 2, body: { kind: 'transcribe-segment', meetingId: 'meet_stale', idx: 0 } },
    ]);
    await worker.queue(batch, runtimeEnv(mockQueue().binding, ai));

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(
      await row<{ transcribe_status: string }>('SELECT transcribe_status FROM meeting_segments WHERE id = ?', 'mseg_stale'),
    ).toEqual({ transcribe_status: 'complete' });
  });
});

describe('pairing codes', () => {
  const CODE = 'ABCD2345';
  const DEVICE = '6f1c2a4e-1b2c-4d3e-8f90-123456789abc';

  async function insertCode() {
    const now = Date.now();
    await testEnv.DB.prepare(
      `INSERT INTO device_pairing_codes (code_hash, device_id, name, root_folder_path, expires_at, created_at)
       VALUES (?, ?, 'Mac', '/tmp/Eavesy', ?, ?)`,
    )
      .bind(await sha256(CODE), DEVICE, now + 600_000, now)
      .run();
  }

  const claim = () =>
    pairPost({
      request: new Request('https://eavesy.test/api/devices/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: CODE }),
      }),
      params: {},
    });

  it('can be claimed only once, and the handed-off token is the live one', async () => {
    await insertUser('user_pair');
    await insertCode();
    actor.userId = 'user_pair';

    const responses = await Promise.all([claim(), claim(), claim()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404, 404]);
    expect(
      await row<{ n: number }>('SELECT count(*) AS n FROM device_tokens WHERE device_id = ?', DEVICE),
    ).toEqual({ n: 1 });

    const handoff = await pairStatus({
      request: new Request('https://eavesy.test/api/devices/pair/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
        body: JSON.stringify({ code: CODE, deviceId: DEVICE }),
      }),
      params: {},
    });
    const { token } = await handoff.json<{ token: string }>();
    expect(
      await row<{ revoked_at: number | null }>(
        'SELECT revoked_at FROM device_tokens WHERE token_hash = ?',
        await sha256(token),
      ),
    ).toEqual({ revoked_at: null });
  });

  it('hands the token to the device only once', async () => {
    await insertUser('user_once');
    await insertCode();
    actor.userId = 'user_once';
    expect((await claim()).status).toBe(200);

    const poll = () =>
      pairStatus({
        request: new Request('https://eavesy.test/api/devices/pair/status', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
          body: JSON.stringify({ code: CODE, deviceId: DEVICE }),
        }),
        params: {},
      });
    const bodies = await Promise.all([poll(), poll(), poll()].map(async (response) => (await response).json<{ token?: string }>()));
    expect(bodies.filter((body) => body.token)).toHaveLength(1);
  });

  it('releases the claim when registration is refused', async () => {
    await insertDeviceActor('user_holder', DEVICE);
    await insertUser('user_taker');
    await insertCode();
    actor.userId = 'user_taker';

    expect((await claim()).status).toBe(409);
    expect(
      await row<{ claimed_by_user_id: string | null }>(
        'SELECT claimed_by_user_id FROM device_pairing_codes WHERE code_hash = ?',
        await sha256(CODE),
      ),
    ).toEqual({ claimed_by_user_id: null });
  });
});
