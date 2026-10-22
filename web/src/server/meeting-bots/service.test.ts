import { describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import { createFakeEnv } from '@/server/testing/fake-env';
import { attributeSpeakers, parseSpeakerSpans, type MeetingBotControl } from './control';
import {
  type BotEnv,
  BOT_SILENT_AFTER_MS,
  BOT_START_TIMEOUT_MS,
  applyStatus,
  cancelBot,
  claimBotStart,
  collectBotRecording,
  failBotStart,
  handleBotEvent,
  handleBotSegment,
  parseMeetingUrl,
  purgeAccountBots,
  scheduleBot,
  watchBot,
} from './service';

/** Records calls to the meeting-bot Worker. */
function fakeControl(fail = false) {
  const calls: string[] = [];
  const control: MeetingBotControl = {
    schedule: async (id, joinAt) => { calls.push(`schedule ${id} ${joinAt}`); if (fail) throw new Error('unreachable'); },
    leave: async (id) => { calls.push(`leave ${id}`); return true; },
    stop: async (id) => { calls.push(`stop ${id}`); },
  };
  return { control, calls };
}

function setup(fail = false) {
  const t = createFakeEnv();
  t.sqlite.run("INSERT INTO users(id,created_at,updated_at,default_language) VALUES ('u1',1,1,'en'),('u2',1,1,'en')");
  t.env.AUDIO_BUCKET.put = (async (key: string, body: Uint8Array | string) => {
    const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(body);
    t.objects.set(key, bytes);
    return { size: bytes.length };
  }) as typeof t.env.AUDIO_BUCKET.put;
  const { control, calls } = fakeControl(fail);
  const env = Object.assign(t.env, { MEETING_BOTS: control }) as BotEnv;
  const db = drizzle(t.env.DB, { schema });
  const bot = (id: string) => t.sqlite.query('SELECT * FROM meeting_bots WHERE id = ?').get(id) as Record<string, unknown>;
  return { ...t, env, db, bot, calls };
}

async function schedule(t: ReturnType<typeof setup>, input: Record<string, unknown> = {}, user = 'u1') {
  const response = await scheduleBot(t.db, t.env, user, { meetingUrl: 'https://meet.google.com/abc-defg-hij', ...input });
  return { response, body: await response.json() as { bot?: { id: string; status: string }; error?: string; duplicate?: boolean } };
}

async function event(t: ReturnType<typeof setup>, botId: string, body: Record<string, unknown>) {
  const request = new Request(`http://eavesy.internal/bots/${botId}/events`, { method: 'POST', body: JSON.stringify({ at: Date.now(), ...body }) });
  return handleBotEvent(t.db, t.env, botId, request);
}

async function segment(t: ReturnType<typeof setup>, botId: string, idx: number, startMs: number) {
  const request = new Request(`http://eavesy.internal/bots/${botId}/segments/${idx}`, {
    method: 'PUT',
    headers: { 'x-segment-start-ms': String(startMs), 'x-segment-duration-ms': '60000', 'x-segment-active-ms': '30000' },
    body: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]),
  });
  return handleBotSegment(t.db, t.env, botId, String(idx), request);
}

/** A bot scheduled, started and recording. */
async function recordingBot(t: ReturnType<typeof setup>) {
  const { body } = await schedule(t);
  const id = body.bot!.id;
  expect(await claimBotStart(t.db, id)).toMatchObject({ meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'meet' });
  await event(t, id, { code: 'joining_call' });
  await event(t, id, { code: 'in_call_recording' });
  return id;
}

describe('meeting links', () => {
  test('recognises Meet, Teams and Zoom over HTTPS only', () => {
    expect(parseMeetingUrl('https://meet.google.com/abc-defg-hij')?.platform).toBe('meet');
    expect(parseMeetingUrl('https://teams.microsoft.com/l/meetup-join/19%3a…')?.platform).toBe('teams');
    expect(parseMeetingUrl('https://us02web.zoom.us/j/123456789')?.platform).toBe('zoom');
    expect(parseMeetingUrl('http://meet.google.com/abc-defg-hij')).toBeNull();
    expect(parseMeetingUrl('https://evil.example/meet.google.com')).toBeNull();
  });
});

describe('scheduling', () => {
  test('writes the row, asks the bot Worker to start it, and dedupes a second click', async () => {
    const t = setup();
    const joinAt = Date.now() + 60 * 60 * 1_000;
    const { response, body } = await schedule(t, { joinAt });
    expect(response.status).toBe(201);
    expect(body.bot!.status).toBe('scheduled');
    expect(t.bot(body.bot!.id)).toMatchObject({ provider: 'eavesy', provider_bot_id: body.bot!.id });
    expect(t.calls).toEqual([`schedule ${body.bot!.id} ${joinAt}`]);
    const again = await schedule(t, { joinAt });
    expect(again.body).toMatchObject({ duplicate: true, bot: { id: body.bot!.id } });
    expect(t.calls).toHaveLength(1);
  });

  test('turns Zoom away by name, and says when the bot service is missing or down', async () => {
    const t = setup();
    const zoom = await schedule(t, { meetingUrl: 'https://zoom.us/j/123456789' });
    expect(zoom.response.status).toBe(400);
    expect(zoom.body.error).toContain("can't join Zoom calls yet");

    const missing = await scheduleBot(t.db, { MEETING_BOTS: undefined }, 'u1', { meetingUrl: 'https://meet.google.com/abc-defg-hij' });
    expect(missing.status).toBe(503);

    const down = setup(true);
    const failed = await schedule(down);
    expect(failed.response.status).toBe(503);
    const row = down.sqlite.query('SELECT status, status_detail FROM meeting_bots').get();
    expect(row).toEqual({ status: 'failed', status_detail: 'provider_unavailable' });
  });
});

describe('starting', () => {
  test('a start is claimed once, and never after a cancel', async () => {
    const t = setup();
    const { body } = await schedule(t);
    const id = body.bot!.id;
    expect(await claimBotStart(t.db, id)).not.toBeNull();
    expect(await claimBotStart(t.db, id)).toBeNull();

    const other = (await schedule(t, { meetingUrl: 'https://meet.google.com/xyz-abcd-efg' })).body.bot!.id;
    await cancelBot(t.db, t.env, 'u1', other);
    expect(t.bot(other)).toMatchObject({ status: 'cancelled', status_detail: 'cancelled_by_user' });
    expect(t.calls).toContain(`stop ${other}`);
    expect(await claimBotStart(t.db, other)).toBeNull();
  });

  test('a container that cannot start fails the bot at once', async () => {
    const t = setup();
    const { body } = await schedule(t);
    const id = body.bot!.id;
    await failBotStart(t.db, id); // not claimed yet: nothing changes
    expect(t.bot(id).status).toBe('scheduled');
    await claimBotStart(t.db, id);
    await failBotStart(t.db, id);
    expect(t.bot(id)).toMatchObject({ status: 'failed', status_detail: 'start_failed' });
  });

  test('a bot asked for now can start before scheduling recorded it', async () => {
    const t = setup();
    t.sqlite.run("INSERT INTO meeting_bots (id,user_id,provider,provider_bot_id,meeting_url,platform,status,created_at,updated_at) VALUES ('bot_n','u1','eavesy','bot_n','https://meet.google.com/abc-defg-hij','meet','scheduling',1,1)");
    expect(await claimBotStart(t.db, 'bot_n')).not.toBeNull();
    expect(t.bot('bot_n')).toMatchObject({ status: 'scheduled', status_detail: 'launching' });
  });
});

describe('reports from the bot', () => {
  test('status only moves forward, and recording creates the meeting', async () => {
    const t = setup();
    const id = await recordingBot(t);
    expect(t.bot(id).status).toBe('recording');
    expect(t.bot(id).meeting_id).toBeTruthy();
    await event(t, id, { code: 'in_waiting_room' });
    expect(t.bot(id).status).toBe('recording');
    const meeting = t.sqlite.query('SELECT source, status, client_session_id FROM meetings').get();
    expect(meeting).toEqual({ source: 'bot', status: 'recording', client_session_id: `bot:${id}` });
  });

  test('segments are stored once and transcribed live', async () => {
    const t = setup();
    const id = await recordingBot(t);
    expect((await segment(t, id, 0, 0)).status).toBe(202);
    expect((await segment(t, id, 0, 0)).status).toBe(200);
    expect(t.sent.filter((m) => m.body.kind === 'transcribe-segment')).toHaveLength(1);
    const row = t.sqlite.query('SELECT idx, track, offset_ms, duration_ms, active_ms FROM meeting_segments').get();
    expect(row).toEqual({ idx: 0, track: 'mixed', offset_ms: 0, duration_ms: 60_000, active_ms: 30_000 });
    expect([...t.objects.keys()].some((k) => k.endsWith('/segments/00000.wav'))).toBe(true);
  });

  test('segments before the call or with bad metadata are refused', async () => {
    const t = setup();
    const { body } = await schedule(t);
    expect((await segment(t, body.bot!.id, 0, 0)).status).toBe(409);
    const bad = new Request('http://eavesy.internal/x', { method: 'PUT', body: new Uint8Array([1]) });
    expect((await handleBotSegment(t.db, t.env, body.bot!.id, 'x', bad)).status).toBe(400);
  });

  test('done queues collection; old deliveries are ignored', async () => {
    const t = setup();
    const id = await recordingBot(t);
    await event(t, id, { code: 'call_ended', subCode: 'call_ended_by_host' });
    await event(t, id, { code: 'done' });
    expect(t.bot(id)).toMatchObject({ status: 'collecting', status_detail: 'call_ended_by_host' });
    expect(t.sent.at(-1)).toMatchObject({ body: { kind: 'collect-bot-recording', botId: id } });
    const before = t.sent.length;
    await event(t, id, { code: 'done' });
    expect(t.sent.length).toBe(before);
  });
});

describe('collection', () => {
  test('waits for transcription, names the speakers, then summarizes', async () => {
    const t = setup();
    const id = await recordingBot(t);
    await segment(t, id, 0, 0);
    await segment(t, id, 1, 60_000);
    await event(t, id, { code: 'speakers', participants: ['Ana', 'Ben'], speakers: [['Ana', 0, 30_000], ['Ben', 30_000, 90_000]] });
    await event(t, id, { code: 'call_ended', subCode: 'call_ended_by_host' });
    await event(t, id, { code: 'done' });

    t.sqlite.run("UPDATE meeting_segments SET transcribe_status = 'complete' WHERE idx = 0");
    await collectBotRecording(t.db, t.env, id);
    expect(t.sent.at(-1)).toMatchObject({ body: { kind: 'collect-bot-recording' }, delaySeconds: 60 });

    t.sqlite.run("UPDATE meeting_segments SET transcribe_status = 'complete'");
    const meetingId = t.bot(id).meeting_id as string;
    for (const [n, start, end] of [[0, 1_000, 20_000], [1, 35_000, 80_000]]) {
      t.sqlite.run('INSERT INTO transcript_segments(id, meeting_id, start_ms, end_ms, text, is_edited, is_final) VALUES (?, ?, ?, ?, ?, 0, 1)', [`l${n}`, meetingId, start, end, 'hello']);
    }
    await collectBotRecording(t.db, t.env, id);
    const speakers = t.sqlite.query('SELECT speaker_id FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms').all(meetingId);
    expect(speakers).toEqual([{ speaker_id: 'speaker_0' }, { speaker_id: 'speaker_1' }]);
    const meeting = t.sqlite.query('SELECT status, duration_sec, speaker_names_json FROM meetings').get() as Record<string, unknown>;
    expect(meeting).toMatchObject({ status: 'processing', duration_sec: 120 });
    expect(JSON.parse(meeting.speaker_names_json as string)).toEqual({ speaker_0: 'Ana', speaker_1: 'Ben' });
    expect(t.sent.at(-1)).toMatchObject({ body: { kind: 'summarize', meetingId } });
    expect(t.bot(id)).toMatchObject({ status: 'done', status_detail: 'call_ended_by_host' });
  });

  test('a bot that never got in fails with its reason', async () => {
    const t = setup();
    const { body } = await schedule(t);
    const id = body.bot!.id;
    await claimBotStart(t.db, id);
    await event(t, id, { code: 'in_waiting_room' });
    await event(t, id, { code: 'call_ended', subCode: 'timeout_exceeded_waiting_room' });
    await event(t, id, { code: 'done' });
    await collectBotRecording(t.db, t.env, id);
    expect(t.bot(id)).toMatchObject({ status: 'failed', status_detail: 'timeout_exceeded_waiting_room' });
  });

  test('a Recall bot from before is retired', async () => {
    const t = setup();
    t.sqlite.run("INSERT INTO meeting_bots (id,user_id,provider,meeting_url,platform,status,created_at,updated_at) VALUES ('bot_r','u1','recall','https://meet.google.com/abc-defg-hij','meet','collecting',1,1)");
    await collectBotRecording(t.db, t.env, 'bot_r');
    expect(t.bot('bot_r')).toMatchObject({ status: 'failed', status_detail: 'provider_retired' });
  });
});

describe('the watchdog', () => {
  test('a container that never reports fails, and a scheduled bot is left alone', async () => {
    const t = setup();
    const { body } = await schedule(t);
    const id = body.bot!.id;
    expect(await watchBot(t.db, t.env, id, false)).toBe('done');
    await claimBotStart(t.db, id);
    expect(await watchBot(t.db, t.env, id, true)).toBe('watch');
    expect(await watchBot(t.db, t.env, id, true, Date.now() + BOT_START_TIMEOUT_MS + 1)).toBe('stop');
    expect(t.bot(id)).toMatchObject({ status: 'failed', status_detail: 'bot_never_reported' });
  });

  test('a bot that went quiet or died keeps what arrived', async () => {
    const t = setup();
    const id = await recordingBot(t);
    await segment(t, id, 0, 0);
    expect(await watchBot(t.db, t.env, id, true)).toBe('watch');
    expect(await watchBot(t.db, t.env, id, true, Date.now() + BOT_SILENT_AFTER_MS + 1)).toBe('stop');
    expect(t.bot(id)).toMatchObject({ status: 'collecting', status_detail: 'lost_track' });
    expect(t.sent.at(-1)).toMatchObject({ body: { kind: 'collect-bot-recording', botId: id } });

    const u = setup();
    const dead = await recordingBot(u);
    expect(await watchBot(u.db, u.env, dead, false)).toBe('done');
    expect(u.bot(dead)).toMatchObject({ status: 'failed', status_detail: 'bot_error' });
    expect(u.sqlite.query('SELECT status FROM meetings').get()).toEqual({ status: 'failed' });
  });

  test('a finished bot whose container lingers is stopped', async () => {
    const t = setup();
    const id = await recordingBot(t);
    await applyStatus(t.db, t.env, t.bot(id) as never, 'done', null, Date.now());
    expect(await watchBot(t.db, t.env, id, true)).toBe('done');
    expect(await watchBot(t.db, t.env, id, true, Date.now() + 61_000)).toBe('stop');
  });
});

describe('leaving and account deletion', () => {
  test('"make it leave" reaches the bot and keeps the recording', async () => {
    const t = setup();
    const id = await recordingBot(t);
    const response = await cancelBot(t.db, t.env, 'u1', id);
    expect(response.status).toBe(200);
    expect(t.calls).toContain(`leave ${id}`);
    expect(t.bot(id)).toMatchObject({ status: 'recording', status_detail: 'leave_requested' });
    expect((await cancelBot(t.db, t.env, 'u2', id)).status).toBe(404);
  });

  test('deleting an account stops its bots and forgets them', async () => {
    const t = setup();
    const id = await recordingBot(t);
    await purgeAccountBots(t.db, t.env, 'u1');
    expect(t.calls).toContain(`stop ${id}`);
    expect(t.sqlite.query('SELECT COUNT(*) AS n FROM meeting_bots').get()).toEqual({ n: 0 });
  });
});

describe('speaker attribution', () => {
  test('each line goes to whoever spoke most of it, numbered by first appearance', () => {
    const spans = parseSpeakerSpans([['Ben', 0, 1_000], ['Ana', 900, 5_000], [' ', 0, 9], ['bad'], ['Ben', 6_000, 7_000]]);
    expect(spans).toHaveLength(3);
    const { assignments, speakerNames } = attributeSpeakers(
      [{ id: 'a', startMs: 0, endMs: 800 }, { id: 'b', startMs: 1_000, endMs: 4_000 }, { id: 'c', startMs: 6_100, endMs: 6_900 }, { id: 'd', startMs: 9_000, endMs: 9_500 }],
      spans,
    );
    expect(Object.fromEntries(assignments)).toEqual({ a: 'speaker_0', b: 'speaker_1', c: 'speaker_0' });
    expect(speakerNames).toEqual({ speaker_0: 'Ben', speaker_1: 'Ana' });
  });

  test('non-finite times are dropped', () => {
    expect(parseSpeakerSpans([['Ana', Number.NaN, 5], ['Ben', 0, Number.POSITIVE_INFINITY], ['Cy', 1, 2]])).toEqual([['Cy', 1, 2]]);
  });

  test('a four-hour call with tens of thousands of spans is attributed to the right people', () => {
    const spans = parseSpeakerSpans(Array.from({ length: 40_000 }, (_, i) => [i % 2 ? 'Ana' : 'Ben', i * 360, i * 360 + 300]));
    const lines = Array.from({ length: 4_000 }, (_, i) => ({ id: `l${i}`, startMs: i * 3_600, endMs: i * 3_600 + 200 }));
    const { assignments } = attributeSpeakers(lines, spans);
    expect(assignments.get('l1')).toBe('speaker_0'); // 3600 ms falls in span 10, Ben's
    expect(assignments.size).toBe(4_000);
  });

  test('a long early span still reaches a later line among many short ones', () => {
    const spans = parseSpeakerSpans([['Ana', 0, 600_000], ...Array.from({ length: 1_000 }, (_, i) => ['Ben', i * 100, i * 100 + 50])]);
    const { assignments } = attributeSpeakers([{ id: 'late', startMs: 500_000, endMs: 505_000 }], spans);
    expect(assignments.get('late')).toBe('speaker_0');
  });
});
