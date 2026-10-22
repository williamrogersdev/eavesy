import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import { createFakeEnv } from '@/server/testing/fake-env';
import type { MeetingBotControl } from './control';
import { CANARY_CHECK_AFTER_SECONDS, CANARY_USER_ID, canaryVerdict, checkCanary, failCanaryCheck, startCanaries } from './canary';
import { type BotEnv, CANARY_STAY_MS, claimBotStart, handleBotEvent, handleBotSegment, watchBot } from './service';

const MEET = 'https://meet.google.com/abc-defg-hij';
const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0';

function setup(config: Record<string, string> = { CANARY_MEET_URL: MEET, CANARY_TEAMS_URL: TEAMS }, failSchedule = false) {
  const t = createFakeEnv();
  const calls: string[] = [];
  const control: MeetingBotControl = {
    schedule: async (id) => { calls.push(`schedule ${id}`); if (failSchedule) throw new Error('unreachable'); },
    leave: async (id) => { calls.push(`leave ${id}`); return true; },
    stop: async (id) => { calls.push(`stop ${id}`); },
  };
  const env = Object.assign(t.env, { MEETING_BOTS: control }, config) as BotEnv;
  const db = drizzle(t.env.DB, { schema });
  const bot = (id: string) => t.sqlite.query('SELECT * FROM meeting_bots WHERE id = ?').get(id) as Record<string, unknown>;
  const event = (id: string, body: Record<string, unknown>) =>
    handleBotEvent(db, env, id, new Request(`http://eavesy.internal/bots/${id}/events`, { method: 'POST', body: JSON.stringify({ at: Date.now(), ...body }) }));
  return { ...t, env, db, bot, calls, event };
}

let errors: string[] = [];
let errorSpy: ReturnType<typeof spyOn>;
const realFetch = globalThis.fetch;
beforeEach(() => {
  errors = [];
  errorSpy = spyOn(console, 'error').mockImplementation((line: unknown) => { errors.push(String(line)); });
  spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  errorSpy.mockRestore();
  globalThis.fetch = realFetch;
});
const alerts = () => errors.map((e) => JSON.parse(e) as Record<string, unknown>).filter((e) => e.alert === 'meeting_bot_canary');

/** A canary started, claimed, in the call. */
async function inCall(t: ReturnType<typeof setup>) {
  const [id] = await startCanaries(t.db, t.env);
  await claimBotStart(t.db, id);
  await t.event(id, { code: 'joining_call' });
  await t.event(id, { code: 'in_call_recording' });
  return id;
}

describe('starting canaries', () => {
  test('does nothing when no test meeting is configured', async () => {
    const t = setup({});
    expect(await startCanaries(t.db, t.env)).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(t.sqlite.query('SELECT count(*) AS n FROM meeting_bots').get()).toEqual({ n: 0 });
    expect(t.sqlite.query('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 });
  });

  test('sends a canary bot to each test meeting, owned by the system account, and queues its check', async () => {
    const t = setup();
    const ids = await startCanaries(t.db, t.env);
    expect(ids).toHaveLength(2);
    expect(t.calls).toEqual(ids.map((id) => `schedule ${id}`));
    expect(ids.map((id) => [t.bot(id).platform, t.bot(id).canary, t.bot(id).user_id, t.bot(id).status])).toEqual([
      ['meet', 1, CANARY_USER_ID, 'scheduled'],
      ['teams', 1, CANARY_USER_ID, 'scheduled'],
    ]);
    expect(t.sent).toEqual(ids.map((botId) => ({ body: { kind: 'check-canary', botId }, delaySeconds: CANARY_CHECK_AFTER_SECONDS })));
    // A second day reuses the account.
    await startCanaries(t.db, t.env);
    expect(t.sqlite.query('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1 });
  });

  test('alerts on a link the bot cannot join, or a bot Worker it cannot reach', async () => {
    const t = setup({ CANARY_MEET_URL: 'https://example.com/not-a-meeting' });
    expect(await startCanaries(t.db, t.env)).toEqual([]);
    expect(alerts()).toEqual([expect.objectContaining({ platform: 'meet', reason: 'invalid_url' })]);

    const down = setup({ CANARY_TEAMS_URL: TEAMS }, true);
    errors = [];
    expect(await startCanaries(down.db, down.env)).toEqual([]);
    expect(alerts()).toEqual([expect.objectContaining({ platform: 'teams', reason: 'schedule_failed' })]);
    const id = alerts()[0].botId as string;
    expect(down.bot(id)).toMatchObject({ status: 'failed', status_detail: 'provider_unavailable' });
    expect(down.calls).toEqual([`schedule ${id}`, `stop ${id}`]);
    // Its queued check knows it was already alerted on.
    errors = [];
    await checkCanary(down.db, down.env, id);
    expect(alerts()).toEqual([]);
  });

  test('alerts when links are set but the meeting-bot Worker is not bound', async () => {
    const t = setup();
    delete (t.env as { MEETING_BOTS?: unknown }).MEETING_BOTS;
    expect(await startCanaries(t.db, t.env)).toEqual([]);
    expect(alerts().map((a) => [a.platform, a.reason])).toEqual([['meet', 'schedule_failed'], ['teams', 'schedule_failed']]);
  });

  test('a bot that started though scheduling reported an error is left to its check', async () => {
    const t = setup({ CANARY_MEET_URL: MEET });
    t.env.MEETING_BOTS!.schedule = async (id) => {
      await claimBotStart(t.db, id);
      throw new Error('timed out after starting');
    };
    expect(await startCanaries(t.db, t.env)).toHaveLength(1);
    expect(alerts()).toEqual([]);
    expect(t.sent.map((m) => m.body.kind)).toEqual(['check-canary']);
  });

  test('a database error on one platform still starts and checks the other', async () => {
    const t = setup();
    t.env.PROCESSING_QUEUE.send = (async (body: { botId: string }) => {
      if (t.bot(body.botId).platform === 'meet') throw new Error('queue down');
      t.sent.push({ body: body as never });
    }) as typeof t.env.PROCESSING_QUEUE.send;
    const ids = await startCanaries(t.db, t.env);
    expect(ids.map((id) => t.bot(id).platform)).toEqual(['teams']);
    expect(alerts()).toEqual([expect.objectContaining({ platform: 'meet', reason: 'schedule_failed' })]);
  });
});

describe('a canary in the call', () => {
  test('makes no meeting, drops its audio, and counts the names it reads without keeping them', async () => {
    const t = setup({ CANARY_MEET_URL: MEET });
    const id = await inCall(t);
    expect(t.bot(id)).toMatchObject({ status: 'recording', meeting_id: null, canary_names: 0 });
    const segment = await handleBotSegment(t.db, t.env, id, '0', new Request(`http://eavesy.internal/bots/${id}/segments/0`, {
      method: 'PUT',
      headers: { 'x-segment-start-ms': '0', 'x-segment-duration-ms': '60000' },
      body: new Uint8Array([1, 2, 3]),
    }));
    expect(segment.status).toBe(202);
    await t.event(id, { code: 'heartbeat', participants: ['Ana', 'Ben'], speakers: [['Ana', 0, 1000], ['Cy', 0, 500]] });
    await t.event(id, { code: 'heartbeat', participants: ['Ana'], speakers: [] });
    expect(t.bot(id).canary_names).toBe(3);
    expect(t.sqlite.query('SELECT count(*) AS n FROM meetings').get()).toEqual({ n: 0 });
    expect(t.objects.size).toBe(0);
    expect(t.sent.filter((m) => m.body.kind !== 'check-canary')).toEqual([]);
  });

  test('is told to leave after a couple of minutes, and finishes without collection', async () => {
    const t = setup({ CANARY_MEET_URL: MEET });
    const id = await inCall(t);
    const joinedAt = t.bot(id).status_at as number;
    expect(await watchBot(t.db, t.env, id, true, joinedAt + CANARY_STAY_MS - 1)).toBe('watch');
    expect(await watchBot(t.db, t.env, id, true, joinedAt + CANARY_STAY_MS)).toBe('stop');
    await t.event(id, { code: 'call_ended', subCode: 'left_on_request' });
    await t.event(id, { code: 'done' });
    expect(t.bot(id).status).toBe('done');
    expect(t.sent.map((m) => m.body.kind)).toEqual(['check-canary']);
  });

  test('a canary whose container dies is failed without touching any meeting', async () => {
    const t = setup({ CANARY_MEET_URL: MEET });
    const id = await inCall(t);
    expect(await watchBot(t.db, t.env, id, false)).toBe('done');
    expect(t.bot(id)).toMatchObject({ status: 'failed', status_detail: 'bot_error', meeting_id: null });
  });

  test('names read before it got in are ignored', async () => {
    const t = setup({ CANARY_MEET_URL: MEET });
    const [id] = await startCanaries(t.db, t.env);
    await t.event(id, { code: 'heartbeat', participants: ['Ana'] });
    expect(t.bot(id).canary_names).toBeNull();
  });
});

describe('checking a canary', () => {
  test('a bot that got in and read names passes quietly', async () => {
    const t = setup({ CANARY_MEET_URL: MEET });
    const id = await inCall(t);
    await t.event(id, { code: 'heartbeat', participants: ['Ana'] });
    await t.event(id, { code: 'call_ended' });
    await t.event(id, { code: 'done' });
    await checkCanary(t.db, t.env, id);
    expect(alerts()).toEqual([]);
    expect(t.calls.filter((c) => c.startsWith('stop'))).toEqual([]);
  });

  test('a bot stuck outside the call is stopped, failed, and alerted on, with an email when set up', async () => {
    const t = setup({ CANARY_MEET_URL: MEET, CANARY_ALERT_EMAIL: 'ops@example.com', RESEND_API_KEY: 're_test', EMAIL_FROM: 'Eavesy <a@example.com>' });
    const emails: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      emails.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: 'email_1' });
    }) as typeof fetch;
    const [id] = await startCanaries(t.db, t.env);
    await claimBotStart(t.db, id);
    await t.event(id, { code: 'joining_call' });
    await t.event(id, { code: 'in_waiting_room' });
    await checkCanary(t.db, t.env, id);
    expect(t.calls).toContain(`stop ${id}`);
    expect(t.bot(id)).toMatchObject({ status: 'failed', status_detail: 'canary_timeout' });
    expect(alerts()).toEqual([expect.objectContaining({ platform: 'meet', reason: 'did_not_join', botId: id, status: 'waiting_room' })]);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ to: ['ops@example.com'], subject: 'Eavesy notetaker canary failed on Google Meet' });
    expect(JSON.stringify(emails[0])).not.toContain('abc-defg-hij');
  });

  test('a bot in the call with no names yet is looked at again once, then alerted on', async () => {
    const t = setup({ CANARY_MEET_URL: MEET });
    const id = await inCall(t);
    await checkCanary(t.db, t.env, id);
    expect(alerts()).toEqual([]);
    expect(t.sent.at(-1)).toMatchObject({ body: { kind: 'check-canary', botId: id, check: 2 } });
    await checkCanary(t.db, t.env, id, 2);
    expect(t.calls).toContain(`stop ${id}`);
    expect(alerts()).toEqual([expect.objectContaining({ reason: 'no_speakers', botId: id })]);
  });

  test('no email without a recipient, and ordinary bots are never judged', async () => {
    const t = setup({ CANARY_MEET_URL: MEET, RESEND_API_KEY: 're_test', EMAIL_FROM: 'a@example.com' });
    globalThis.fetch = (() => { throw new Error('no email expected'); }) as unknown as typeof fetch;
    const [id] = await startCanaries(t.db, t.env);
    await checkCanary(t.db, t.env, id, 2);
    expect(alerts()).toHaveLength(1);
    t.sqlite.run("UPDATE meeting_bots SET canary = 0, status = 'recording', status_detail = NULL WHERE id = ?", [id]);
    errors = [];
    const calls = [...t.calls];
    const sent = t.sent.length;
    await checkCanary(t.db, t.env, id, 2);
    await failCanaryCheck(t.db, t.env, id, 'boom');
    expect(alerts()).toEqual([]);
    expect(t.calls).toEqual(calls);
    expect(t.sent).toHaveLength(sent);
    expect(t.bot(id)).toMatchObject({ status: 'recording', status_detail: null });
  });

  test('a check that runs out of retries stops the bot and still alerts', async () => {
    const t = setup({ CANARY_MEET_URL: MEET });
    const id = await inCall(t);
    await failCanaryCheck(t.db, t.env, id, 'D1 unavailable');
    expect(t.calls).toContain(`stop ${id}`);
    expect(t.bot(id)).toMatchObject({ status: 'failed', status_detail: 'canary_check_failed' });
    expect(alerts()).toEqual([expect.objectContaining({ reason: 'check_failed', botId: id, platform: 'meet' })]);
  });

  test('verdicts', () => {
    expect(canaryVerdict({ status: 'failed', canaryNames: null })).toBe('did_not_join');
    expect(canaryVerdict({ status: 'recording', canaryNames: 0 })).toBe('pending');
    expect(canaryVerdict({ status: 'done', canaryNames: 0 })).toBe('no_speakers');
    expect(canaryVerdict({ status: 'done', canaryNames: 2 })).toBe('passed');
  });
});
