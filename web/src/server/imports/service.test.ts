import { describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import { createFakeEnv, delivery } from '@/server/testing/fake-env';
import { queue, type ProcessingMessage } from '@/server/processing-worker';
import { encodeWav } from '@/lib/imports/wav';
import { createImport, importRequest } from './service';
function setup() {
  const t = createFakeEnv({ transcribe: () => ({ text: 'We will launch on Friday.', segments: [{ start: 0, end: 1, text: 'We will launch on Friday.' }] }) });
  t.sqlite.run("INSERT INTO users(id,created_at,updated_at) VALUES ('u1',1,1),('u2',1,1)");
  t.env.AUDIO_BUCKET.put = (async (key: string, body: Uint8Array | ReadableStream) => {
    t.objects.set(key, body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer())); return {};
  }) as typeof t.env.AUDIO_BUCKET.put;
  const db = drizzle(t.env.DB, { schema });
  return { ...t, db };
}
async function create(t: ReturnType<typeof setup>, user = 'u1') {
  return await (await createImport(t.db, user, { fingerprint: 'a'.repeat(64), title: 'Imported meeting', durationMs: 1000 })).json() as { meetingId: string };
}
const request = (method: string, body?: Uint8Array, headers?: Record<string, string>) => new Request('https://test/', { method, body, headers });
async function upload(t: ReturnType<typeof setup>, id: string) {
  const wav = encodeWav(new Float32Array(16000));
  expect([200, 202]).toContain((await importRequest(t.db, t.env, 'u1', `${id}/segments/0`, request('PUT', wav))).status);
  expect((await importRequest(t.db, t.env, 'u1', `${id}/archive`, request('PUT', wav, { 'content-type': 'audio/wav', 'content-length': String(wav.length) }))).status).toBe(200);
}
async function deliver(t: ReturnType<typeof setup>, body: ProcessingMessage) {
  const d = delivery(body);
  await queue({ queue: 'eavesy-processing', messages: [d.message], ackAll() {}, retryAll() {} }, t.env);
  return d.outcome;
}
describe('durable file import', () => {
  test('deduplicates within one owner and isolates status, writes and cancellation', async () => {
    const t = setup(); const first = await create(t); const second = await create(t); const other = await create(t, 'u2');
    expect(second.meetingId).toBe(first.meetingId);
    expect(other.meetingId).not.toBe(first.meetingId);
    for (const method of ['GET', 'DELETE', 'POST', 'PUT']) expect((await importRequest(t.db, t.env, 'u2', first.meetingId, request(method))).status).toBe(404);
  });
  test('rejects forged duration and cannot finalize missing audio', async () => {
    const t = setup(); const { meetingId: id } = await create(t);
    expect((await importRequest(t.db, t.env, 'u1', `${id}/finalize`, request('POST'))).status).toBe(409);
    const bad = encodeWav(new Float32Array(32000));
    expect((await importRequest(t.db, t.env, 'u1', `${id}/segments/0`, request('PUT', bad))).status).toBe(400);
    expect(t.sent).toHaveLength(0);
  });
  test('resumes duplicate uploads and restores a lost queue handoff on finalize replay', async () => {
    const t = setup(); const { meetingId: id } = await create(t);
    await upload(t, id); await upload(t, id);
    expect(t.sent).toHaveLength(0);
    expect((t.sqlite.query('SELECT count(*) n FROM meeting_segments').get() as { n: number }).n).toBe(1);
    await importRequest(t.db, t.env, 'u1', `${id}/finalize`, request('POST'));
    const first = t.sent.map(m => m.body);
    expect(first.map(m => m.kind)).toEqual(['transcribe-segment', 'summarize']);
    await importRequest(t.db, t.env, 'u1', `${id}/finalize`, request('POST'));
    expect(t.sent).toHaveLength(4);
    expect((await deliver(t, first[0])).acked).toBe(true);
    expect((await deliver(t, first[0])).acked).toBe(true);
    expect((t.sqlite.query('SELECT count(*) n FROM transcript_segments').get() as { n: number }).n).toBe(1);
  });
  test('queued messages do no inference after cancellation', async () => {
    const t = setup(); const { meetingId: id } = await create(t); await upload(t, id);
    await importRequest(t.db, t.env, 'u1', `${id}/finalize`, request('POST'));
    await importRequest(t.db, t.env, 'u1', id, request('DELETE'));
    await deliver(t, t.sent[0].body);
    expect((t.sqlite.query('SELECT count(*) n FROM transcript_segments').get() as { n: number }).n).toBe(0);
    expect((await importRequest(t.db, t.env, 'u1', `${id}/retry`, request('POST'))).status).toBe(409);
  });
});
