import { afterEach, describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import { createFakeEnv } from '@/server/testing/fake-env';
import { createBotBody, verifyWebhook } from './recall';
import {
  type BotEnv,
  applyStatus,
  cancelBot,
  collectBotRecording,
  handleWebhook,
  parseMeetingUrl,
  purgeAccountBots,
  reconcileBots,
  scheduleBot,
} from './service';
import { convertRecallTranscript } from './transcript';

const SECRET = `whsec_${btoa('test-signing-secret-0123456789')}`;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Call { method: string; url: string; body: unknown }

/** Routes Recall API and download calls to handlers; records each call. */
function mockRecall(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const call = { method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = Object.keys(routes).find((pattern) => `${method} ${url}`.includes(pattern));
    if (!key) return new Response('not mocked', { status: 500 });
    return routes[key](call);
  }) as typeof fetch;
  return calls;
}

function setup() {
  const t = createFakeEnv();
  t.sqlite.run("INSERT INTO users(id,created_at,updated_at,default_language) VALUES ('u1',1,1,'en'),('u2',1,1,'en')");
  t.env.AUDIO_BUCKET.put = (async (key: string, body: Uint8Array | ReadableStream) => {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    t.objects.set(key, bytes);
    return { size: bytes.length };
  }) as typeof t.env.AUDIO_BUCKET.put;
  const env = Object.assign(t.env, { RECALL_API_KEY: 'key', RECALL_WEBHOOK_SECRET: SECRET }) as BotEnv;
  const db = drizzle(t.env.DB, { schema });
  const bot = (id: string) => t.sqlite.query('SELECT * FROM meeting_bots WHERE id = ?').get(id) as Record<string, unknown>;
  return { ...t, env, db, bot };
}

async function sign(body: string, id = 'msg_1', at = Date.now()) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(SECRET.slice(6)), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const timestamp = String(Math.floor(at / 1000));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${btoa(String.fromCharCode(...mac))}` };
}

async function webhook(t: ReturnType<typeof setup>, event: string, providerBotId: string, opts: { id?: string; at?: string; eavesyBotId?: string; subCode?: string } = {}) {
  const body = JSON.stringify({
    event,
    data: {
      data: { code: event.slice(4), sub_code: opts.subCode ?? null, updated_at: opts.at ?? new Date().toISOString() },
      bot: { id: providerBotId, metadata: opts.eavesyBotId ? { eavesy_bot_id: opts.eavesyBotId } : {} },
    },
  });
  const headers = await sign(body, opts.id ?? `msg_${Math.random()}`);
  return handleWebhook(t.db, t.env, new Request('https://test/api/webhooks/recall', { method: 'POST', body, headers }));
}

async function schedule(t: ReturnType<typeof setup>, input: Record<string, unknown> = {}) {
  mockRecall({ 'POST https://us-west-2.recall.ai/api/v1/bot/': () => Response.json({ id: 'rb_1' }) });
  const response = await scheduleBot(t.db, t.env, 'u1', { meetingUrl: 'https://us02web.zoom.us/j/123456?pwd=abc', ...input });
  return { response, body: (await response.json()) as { bot: { id: string; status: string }; duplicate?: boolean } };
}

const TRANSCRIPT = [
  { participant: { id: 100, name: 'Ana Ruiz' }, language_code: 'en-US', words: [
    { text: 'We', start_timestamp: { relative: 1.0 }, end_timestamp: { relative: 1.2 } },
    { text: 'ship', start_timestamp: { relative: 1.2 }, end_timestamp: { relative: 1.5 } },
    { text: 'Friday.', start_timestamp: { relative: 1.5 }, end_timestamp: { relative: 2.0 } },
  ] },
  { participant: { id: 200, name: 'Ben Ode' }, language_code: 'en-US', words: [
    { text: 'Agreed.', start_timestamp: { relative: 3.0 }, end_timestamp: { relative: 3.4 } },
  ] },
];

function finishedBot(transcript: string, audio: string) {
  return {
    id: 'rb_1',
    status_changes: [{ code: 'done', sub_code: null, created_at: new Date().toISOString() }],
    recordings: [{
      id: 'rec_1',
      started_at: '2026-10-21T10:00:00Z',
      completed_at: '2026-10-21T10:30:00Z',
      media_shortcuts: {
        transcript: { status: { code: transcript }, data: { download_url: 'https://files.example/transcript.json' } },
        audio_mixed: { status: { code: audio }, data: { download_url: 'https://files.example/audio.mp3' } },
      },
    }],
  };
}

describe('meeting links', () => {
  test('accepts only joinable platform links over https', () => {
    expect(parseMeetingUrl('https://us02web.zoom.us/j/123?pwd=x')?.platform).toBe('zoom');
    expect(parseMeetingUrl('https://meet.google.com/abc-defg-hij')?.platform).toBe('meet');
    expect(parseMeetingUrl('https://teams.microsoft.com/l/meetup-join/19%3a')?.platform).toBe('teams');
    expect(parseMeetingUrl('http://zoom.us/j/123')).toBeNull();
    expect(parseMeetingUrl('https://zoom.us.evil.example/j/123')).toBeNull();
    expect(parseMeetingUrl('https://meet.google.com/landing')).toBeNull();
    expect(parseMeetingUrl('not a url')).toBeNull();
  });

  test('schedules with notice, joins now without, and never asks for video', () => {
    const now = Date.UTC(2026, 9, 21);
    const later = createBotBody({ meetingUrl: 'u', botName: 'n', eavesyBotId: 'bot_1', joinAt: now + 60 * 60 * 1000, now });
    expect(later.join_at).toBe(new Date(now + 60 * 60 * 1000).toISOString());
    expect(later.metadata).toEqual({ eavesy_bot_id: 'bot_1' });
    expect(later.recording_config.video_mixed_mp4).toBeNull();
    expect('join_at' in createBotBody({ meetingUrl: 'u', botName: 'n', eavesyBotId: 'b', joinAt: now + 60_000, now })).toBe(false);
  });
});

describe('webhook signatures', () => {
  test('accepts a valid signature in either header family and refuses tampering and replays', async () => {
    const body = '{"event":"bot.done"}';
    const headers = new Headers(await sign(body, 'msg_9'));
    expect(await verifyWebhook(SECRET, headers, body)).toBe('msg_9');
    const svix = new Headers();
    headers.forEach((value, key) => svix.set(key.replace('webhook-', 'svix-'), value));
    expect(await verifyWebhook(SECRET, svix, body)).toBe('msg_9');
    expect(await verifyWebhook(SECRET, headers, body.replace('done', 'fatal'))).toBeNull();
    const stale = new Headers(await sign(body, 'msg_9', Date.now() - 10 * 60 * 1000));
    expect(await verifyWebhook(SECRET, stale, body)).toBeNull();
    expect(await verifyWebhook(`whsec_${btoa('other')}`, headers, body)).toBeNull();
  });
});

describe('transcript conversion', () => {
  test('numbers speakers by first turn, keeps their names, and splits long turns', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ text: i % 50 === 49 ? 'end.' : 'word', start_timestamp: { relative: 10 + i }, end_timestamp: { relative: 10.5 + i } }));
    const out = convertRecallTranscript([...TRANSCRIPT, { participant: { id: 100, name: 'Ana Ruiz' }, language_code: 'es', words: many }]);
    expect(out.speakerNames).toEqual({ speaker_0: 'Ana Ruiz', speaker_1: 'Ben Ode' });
    expect(out.lines[0]).toMatchObject({ speakerId: 'speaker_0', text: 'We ship Friday.', startMs: 1000, endMs: 2000, language: 'en' });
    expect(out.lines.filter((line) => line.language === 'es').length).toBe(3);
    expect(out.language).toBe('es');
    expect(convertRecallTranscript('garbage').lines).toEqual([]);
    // Two different people both called "Guest" stay apart; id-less turns share one unnamed speaker.
    const guests = convertRecallTranscript([
      { participant: { id: 1, name: 'Guest' }, words: [{ text: 'One.', start_timestamp: { relative: 1 } }] },
      { participant: { id: 2, name: 'Guest' }, words: [{ text: 'Two.', start_timestamp: { relative: 2 } }] },
      { participant: { name: 'Cy' }, words: [{ text: 'Three.', start_timestamp: { relative: 3 } }] },
      { participant: {}, words: [{ text: 'Four.', start_timestamp: { relative: 4 } }] },
    ]);
    expect(guests.lines.map((line) => line.speakerId)).toEqual(['speaker_0', 'speaker_1', 'speaker_2', 'speaker_2']);
    expect(guests.speakerNames).toEqual({ speaker_0: 'Guest', speaker_1: 'Guest' });
  });
});

describe('notetaker lifecycle', () => {
  test('schedules once per meeting, records the provider id, and refuses bad links', async () => {
    const t = setup();
    const first = await schedule(t);
    expect(first.response.status).toBe(201);
    expect(first.body.bot.status).toBe('scheduled');
    expect(t.bot(first.body.bot.id).provider_bot_id).toBe('rb_1');
    const again = await schedule(t);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.bot.id).toBe(first.body.bot.id);
    expect((await scheduleBot(t.db, t.env, 'u1', { meetingUrl: 'https://example.com/x' })).status).toBe(400);
    const unconfigured = { ...t.env, RECALL_API_KEY: undefined } as BotEnv;
    expect((await scheduleBot(t.db, unconfigured, 'u1', { meetingUrl: 'https://meet.google.com/abc-defg-hij' })).status).toBe(503);
  });

  test('a timed-out create is adopted by its first webhook through our id', async () => {
    const t = setup();
    mockRecall({ 'POST https://us-west-2.recall.ai/api/v1/bot/': () => { throw new Error('timeout'); } });
    const response = await scheduleBot(t.db, t.env, 'u1', { meetingUrl: 'https://meet.google.com/abc-defg-hij' });
    expect(response.status).toBe(202);
    const { bot } = (await response.json()) as { bot: { id: string } };
    expect(t.bot(bot.id).status).toBe('scheduling');
    await webhook(t, 'bot.joining_call', 'rb_late', { eavesyBotId: bot.id });
    expect(t.bot(bot.id)).toMatchObject({ provider_bot_id: 'rb_late', status: 'joining' });
  });

  test('status only moves forward, recording creates the meeting, and deliveries are idempotent', async () => {
    const t = setup();
    const { body } = await schedule(t);
    const id = body.bot.id;
    expect((await webhook(t, 'bot.in_call_recording', 'rb_1', { id: 'm1' })).status).toBe(200);
    const meetingId = t.bot(id).meeting_id as string;
    expect(t.sqlite.query('SELECT source, status, platform FROM meetings WHERE id = ?').get(meetingId)).toEqual({ source: 'bot', status: 'recording', platform: 'zoom' });
    await webhook(t, 'bot.joining_call', 'rb_1');
    expect(t.bot(id).status).toBe('recording');
    expect(await (await webhook(t, 'bot.in_call_recording', 'rb_1', { id: 'm1' })).json()).toEqual({ ok: true, duplicate: true });
    await webhook(t, 'bot.done', 'rb_1');
    expect(t.bot(id).status).toBe('collecting');
    expect(t.sent.map((m) => m.body)).toEqual([{ kind: 'collect-bot-recording', botId: id }]);
    await webhook(t, 'bot.done', 'rb_1');
    expect(t.sent).toHaveLength(1);
    expect((t.sqlite.query('SELECT count(*) n FROM meetings').get() as { n: number }).n).toBe(1);
  });

  test('a delivery that fails partway is not recorded, so its retry still applies', async () => {
    const t = setup();
    const { body } = await schedule(t);
    t.sqlite.run('ALTER TABLE meetings RENAME TO meetings_away');
    await expect(webhook(t, 'bot.in_call_recording', 'rb_1', { id: 'retry_me' })).rejects.toThrow();
    t.sqlite.run('ALTER TABLE meetings_away RENAME TO meetings');
    expect((t.sqlite.query('SELECT count(*) n FROM provider_webhook_events').get() as { n: number }).n).toBe(0);
    expect(await (await webhook(t, 'bot.in_call_recording', 'rb_1', { id: 'retry_me' })).json()).toEqual({ ok: true });
    expect(t.bot(body.bot.id).status).toBe('recording');
  });

  test('unsigned or unknown deliveries change nothing', async () => {
    const t = setup();
    const { body } = await schedule(t);
    const forged = await handleWebhook(t.db, t.env, new Request('https://test/', { method: 'POST', body: '{"event":"bot.done"}', headers: { 'webhook-id': 'x', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,AAAA' } }));
    expect(forged.status).toBe(401);
    expect((await webhook(t, 'bot.done', 'rb_other')).status).toBe(200);
    expect(t.bot(body.bot.id).status).toBe('scheduled');
  });

  test('a bot that never recorded fails with a readable reason', async () => {
    const t = setup();
    const { body } = await schedule(t);
    await webhook(t, 'bot.fatal', 'rb_1', { subCode: 'timeout_exceeded_waiting_room' });
    expect(t.bot(body.bot.id)).toMatchObject({ status: 'collecting', status_detail: 'timeout_exceeded_waiting_room' });
    mockRecall({ 'GET https://us-west-2.recall.ai/api/v1/bot/rb_1/': () => Response.json({ id: 'rb_1', status_changes: [], recordings: [] }) });
    await collectBotRecording(t.db, t.env, body.bot.id);
    expect(t.bot(body.bot.id)).toMatchObject({ status: 'failed', status_detail: 'timeout_exceeded_waiting_room' });
    expect((t.sqlite.query('SELECT count(*) n FROM meetings').get() as { n: number }).n).toBe(0);
  });

  test('collect waits for the provider, then stores lines, names and audio and starts the summary', async () => {
    const t = setup();
    const { body } = await schedule(t);
    const id = body.bot.id;
    await webhook(t, 'bot.in_call_recording', 'rb_1');
    await webhook(t, 'bot.done', 'rb_1');
    t.sent.length = 0;

    mockRecall({ 'GET https://us-west-2.recall.ai/api/v1/bot/rb_1/': () => Response.json(finishedBot('processing', 'done')) });
    await collectBotRecording(t.db, t.env, id);
    expect(t.sent).toEqual([{ body: { kind: 'collect-bot-recording', botId: id }, delaySeconds: 60 }]);
    expect(t.bot(id).collect_attempts).toBe(1);

    t.sent.length = 0;
    const calls = mockRecall({
      'GET https://us-west-2.recall.ai/api/v1/bot/rb_1/': () => Response.json(finishedBot('done', 'done')),
      'GET https://files.example/transcript.json': () => Response.json(TRANSCRIPT),
      'GET https://files.example/audio.mp3': () => new Response(new Uint8Array([1, 2, 3])),
      'POST https://us-west-2.recall.ai/api/v1/bot/rb_1/delete_media/': () => new Response(null, { status: 204 }),
    });
    await collectBotRecording(t.db, t.env, id);
    const meetingId = t.bot(id).meeting_id as string;
    expect(t.bot(id).status).toBe('done');
    expect(t.sqlite.query('SELECT speaker_id, text FROM transcript_segments ORDER BY start_ms').all()).toEqual([
      { speaker_id: 'speaker_0', text: 'We ship Friday.' },
      { speaker_id: 'speaker_1', text: 'Agreed.' },
    ]);
    const meeting = t.sqlite.query('SELECT status, duration_sec, audio_format, audio_r2_key, speaker_names_json FROM meetings WHERE id = ?').get(meetingId) as Record<string, unknown>;
    expect(meeting).toMatchObject({ status: 'processing', duration_sec: 1800, audio_format: 'mp3' });
    expect(JSON.parse(meeting.speaker_names_json as string)).toEqual({ speaker_0: 'Ana Ruiz', speaker_1: 'Ben Ode' });
    expect(t.objects.get(meeting.audio_r2_key as string)).toEqual(new Uint8Array([1, 2, 3]));
    expect(t.sent.map((m) => m.body)).toEqual([{ kind: 'summarize', meetingId }]);
    // Download URLs are pre-signed: the API key never goes with them.
    expect(calls.some((c) => c.url.endsWith('/delete_media/'))).toBe(true);

    // A redelivered job does nothing more.
    await collectBotRecording(t.db, t.env, id);
    expect(t.sent).toHaveLength(1);
  });

  test('a failed provider transcript falls back to Whisper on the kept audio', async () => {
    const t = setup();
    const { body } = await schedule(t);
    await webhook(t, 'bot.in_call_recording', 'rb_1');
    await webhook(t, 'bot.done', 'rb_1');
    t.sent.length = 0;
    mockRecall({
      'GET https://us-west-2.recall.ai/api/v1/bot/rb_1/': () => Response.json(finishedBot('failed', 'done')),
      'GET https://files.example/audio.mp3': () => new Response(new Uint8Array([1])),
      'delete_media': () => new Response(null, { status: 204 }),
    });
    await collectBotRecording(t.db, t.env, body.bot.id);
    expect(t.sent.map((m) => m.body.kind)).toEqual(['process-recording']);
  });

  test('cancel removes a scheduled bot and asks one in a call to leave', async () => {
    const t = setup();
    const { body } = await schedule(t);
    let calls = mockRecall({ 'DELETE https://us-west-2.recall.ai/api/v1/bot/rb_1/': () => new Response(null, { status: 204 }) });
    expect((await cancelBot(t.db, t.env, 'u2', body.bot.id)).status).toBe(404);
    await cancelBot(t.db, t.env, 'u1', body.bot.id);
    expect(t.bot(body.bot.id).status).toBe('cancelled');
    expect(calls.map((c) => c.method)).toEqual(['DELETE']);

    t.sqlite.run('DELETE FROM meeting_bots');
    const second = await schedule(t);
    await webhook(t, 'bot.in_call_recording', 'rb_1');
    calls = mockRecall({ 'leave_call': () => new Response(null, { status: 204 }) });
    await cancelBot(t.db, t.env, 'u1', second.body.bot.id);
    expect(calls.map((c) => c.url.endsWith('/leave_call/'))).toEqual([true]);
    expect(t.bot(second.body.bot.id).status).toBe('recording');
  });

  test('reconcile applies a missed status and gives up on bots that never confirmed', async () => {
    const t = setup();
    const { body } = await schedule(t);
    const old = Date.now() - 4 * 60 * 60 * 1000;
    t.sqlite.run('UPDATE meeting_bots SET updated_at = ?, created_at = ?', [old, old]);
    t.sqlite.run("INSERT INTO meeting_bots (id,user_id,provider,meeting_url,platform,status,created_at,updated_at) VALUES ('bot_x','u1','recall','https://meet.google.com/abc-defg-hij','meet','scheduling',?,?)", [old, old]);
    mockRecall({ 'GET https://us-west-2.recall.ai/api/v1/bot/rb_1/': () => Response.json(finishedBot('done', 'done')) });
    await reconcileBots(t.db, t.env);
    expect(t.bot(body.bot.id).status).toBe('collecting');
    expect(t.bot('bot_x')).toMatchObject({ status: 'failed', status_detail: 'provider_unconfirmed' });
  });

  test('account purge stops active bots before forgetting them', async () => {
    const t = setup();
    await schedule(t);
    const calls = mockRecall({ 'DELETE https://us-west-2.recall.ai/api/v1/bot/rb_1/': () => new Response(null, { status: 404 }) });
    await purgeAccountBots(t.db, t.env, 'u1');
    expect(calls).toHaveLength(1);
    expect((t.sqlite.query('SELECT count(*) n FROM meeting_bots').get() as { n: number }).n).toBe(0);
  });

  test('status order ignores an older repeat of the current status', async () => {
    const t = setup();
    const { body } = await schedule(t);
    const row = t.db.select().from(schema.meetingBots);
    const [bot] = await row;
    expect(await applyStatus(t.db, t.env, bot, 'unknown_code', null, Date.now())).toBe('scheduled');
    expect(t.bot(body.bot.id).status).toBe('scheduled');
  });
});
