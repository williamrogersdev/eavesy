import { describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import { createFakeEnv } from '@/server/testing/fake-env';
import {
  AgentInboxError,
  askTimeoutSec,
  cleanText,
  createMessage,
  LISTENING_MS,
  macListening,
  MAX_PENDING,
  parseAsk,
  parseSend,
  pollForDevice,
  resolveForDevice,
  sourceLabel,
  waitForAnswer,
} from './agent-inbox';

function setup() {
  const t = createFakeEnv();
  t.sqlite.run("INSERT INTO users(id,created_at,updated_at) VALUES ('u1',1,1),('u2',1,1)");
  return { ...t, db: drizzle(t.env.DB, { schema }) };
}

const ask = (userId = 'u1', ttlMs = 60_000) => ({
  userId,
  mcpTokenId: 't1',
  source: 'ChatGPT',
  kind: 'ask' as const,
  text: 'Ship it behind a flag?',
  spoken: 'Flag or no flag?',
  choices: ['flag', 'no flag'],
  ttlMs,
});

describe('agent text', () => {
  test('control characters go, newlines stay, long text is clipped', () => {
    expect(cleanText('  hi\u0007 there\nnext\u001b[31m  ', 100)).toBe('hi there\nnext[31m');
    expect(cleanText('x'.repeat(10), 5)).toBe('xxxx…');
    expect(cleanText(42, 10)).toBe('');
  });

  test('a connection name is one short line, with a fallback', () => {
    expect(sourceLabel('Chat\nGPT\u0000')).toBe('Chat GPT');
    expect(sourceLabel('')).toBe('An agent');
    expect(sourceLabel('x'.repeat(100)).length).toBe(40);
  });

  test('the wait is clamped to what a held call allows', () => {
    expect(askTimeoutSec(undefined)).toBe(120);
    expect(askTimeoutSec(5)).toBe(30);
    expect(askTimeoutSec(10_000)).toBe(600);
    expect(askTimeoutSec('90')).toBe(90);
  });

  test('arguments are checked', () => {
    expect(() => parseSend({})).toThrow(AgentInboxError);
    expect(parseSend({ text: 'Done.', spoken: 'All\ndone' })).toEqual({ text: 'Done.', spoken: 'All done' });
    expect(() => parseAsk({ question: 'Which?', choices: 'a' })).toThrow('choices must be a list');
    expect(() => parseAsk({ question: 'Which?', choices: ['1', '2', '3', '4', '5', '6', '7'] })).toThrow('at most 6');
    expect(parseAsk({ question: 'Which?', choices: ['a', 'a', ' ', 'b'] }).choices).toEqual(['a', 'b']);
  });
});

describe('delivering to a Mac', () => {
  test('a Mac that polled is listening, for a while', async () => {
    const t = setup();
    expect(await macListening(t.db, 'u1', 1_000)).toBe(false);
    await pollForDevice(t.db, 'u1', 'mac-a', 1_000);
    expect(await macListening(t.db, 'u1', 1_000 + LISTENING_MS - 1)).toBe(true);
    expect(await macListening(t.db, 'u1', 1_000 + LISTENING_MS + 1)).toBe(false);
    expect(await macListening(t.db, 'u2', 1_000)).toBe(false);
  });

  test('each message goes to one Mac, and only the owner\'s', async () => {
    const t = setup();
    const id = await createMessage(t.db, ask(), 1_000);
    await createMessage(t.db, { ...ask(), kind: 'send', choices: [] }, 1_001);
    expect((await pollForDevice(t.db, 'u2', 'mac-other', 1_100)).items).toEqual([]);

    const first = await pollForDevice(t.db, 'u1', 'mac-a', 1_100);
    expect(first.items.map((item) => item.kind)).toEqual(['ask', 'send']);
    expect(first.items[0]).toMatchObject({ id, source: 'ChatGPT', spoken: 'Flag or no flag?', choices: ['flag', 'no flag'] });
    expect(first.waiting).toEqual([id]);

    expect((await pollForDevice(t.db, 'u1', 'mac-b', 1_200)).items).toEqual([]);
    const again = await pollForDevice(t.db, 'u1', 'mac-a', 1_200);
    expect(again.items).toEqual([]);
    expect(again.waiting).toEqual([id]);
  });

  test('an answer goes back to the ask, once, from the Mac that showed it', async () => {
    const t = setup();
    const id = await createMessage(t.db, ask(), 1_000);
    await pollForDevice(t.db, 'u1', 'mac-a', 1_000);
    expect(await resolveForDevice(t.db, 'u1', 'mac-b', id, { status: 'answered', text: 'no' }, 1_100)).toBe(false);
    expect(await resolveForDevice(t.db, 'u2', 'mac-a', id, { status: 'answered', text: 'no' }, 1_100)).toBe(false);
    expect(await resolveForDevice(t.db, 'u1', 'mac-a', id, { status: 'answered', text: 'no flag' }, 1_100)).toBe(true);
    expect(await resolveForDevice(t.db, 'u1', 'mac-a', id, { status: 'dismissed' }, 1_200)).toBe(false);
    expect(await waitForAnswer(t.db, id, 0)).toEqual({ status: 'answered', text: 'no flag' });
    expect((await pollForDevice(t.db, 'u1', 'mac-a', 1_300)).waiting).toEqual([]);
  });

  test('an ask nobody answers times out and leaves the Mac', async () => {
    const t = setup();
    const id = await createMessage(t.db, ask('u1', 10_000), 1_000);
    await pollForDevice(t.db, 'u1', 'mac-a', 1_000);
    let clock = 1_000;
    const result = await waitForAnswer(t.db, id, 5_000, { now: () => clock, sleep: async (ms) => { clock += ms; }, everyMs: 1_000 });
    expect(result).toEqual({ status: 'timeout' });
    expect(clock).toBe(5_000);
    expect((await pollForDevice(t.db, 'u1', 'mac-a', 5_100)).waiting).toEqual([]);
    expect(await resolveForDevice(t.db, 'u1', 'mac-a', id, { status: 'answered', text: 'late' }, 5_200)).toBe(false);
  });

  test('a dismissal is returned while waiting', async () => {
    const t = setup();
    const id = await createMessage(t.db, ask(), 1_000);
    await pollForDevice(t.db, 'u1', 'mac-a', 1_000);
    let polls = 0;
    const result = await waitForAnswer(t.db, id, Number.MAX_SAFE_INTEGER, {
      sleep: async () => {
        polls += 1;
        if (polls === 2) await resolveForDevice(t.db, 'u1', 'mac-a', id, { status: 'dismissed' }, 1_100);
        if (polls > 5) throw new Error('never saw the dismissal');
      },
    });
    expect(result).toEqual({ status: 'dismissed' });
  });

  test('expired messages are never delivered', async () => {
    const t = setup();
    await createMessage(t.db, ask('u1', 1_000), 1_000);
    expect((await pollForDevice(t.db, 'u1', 'mac-a', 2_001)).items).toEqual([]);
  });

  test('a looping agent can only pile up so many', async () => {
    const t = setup();
    for (let i = 0; i < MAX_PENDING; i += 1) await createMessage(t.db, ask(), 1_000);
    await expect(createMessage(t.db, ask(), 1_000)).rejects.toThrow('Too many messages');
    await expect(createMessage(t.db, ask('u2'), 1_000)).resolves.toBeString();
  });
});
