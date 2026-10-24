import { describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import { createFakeEnv } from '@/server/testing/fake-env';
import {
  AgentInboxError,
  askTimeoutSec,
  cleanText,
  createMessage,
  HELD_MS,
  LISTENING_MS,
  macEnabled,
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
    expect(cleanText('pay\u202Eevil\u200B me\uFEFF\u00AD\u2060', 100)).toBe('payevil me');
    expect(cleanText('👩\u200D💻', 10)).toBe('👩\u200D💻');
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
    expect(await macEnabled(t.db, 'u1')).toBe(false);
    await pollForDevice(t.db, 'u1', 'mac-a', 1_000);
    expect(await macListening(t.db, 'u1', 1_000 + LISTENING_MS - 1)).toBe(true);
    expect(await macListening(t.db, 'u1', 1_000 + LISTENING_MS + 1)).toBe(false);
    expect(await macEnabled(t.db, 'u1')).toBe(true);
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
    // A Mac that restarted gets its own waiting ask again, not the delivered message.
    const again = await pollForDevice(t.db, 'u1', 'mac-a', 1_200);
    expect(again.items.map((item) => item.id)).toEqual([id]);
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

  test('an answer that lands as the wait runs out still wins', async () => {
    const t = setup();
    const id = await createMessage(t.db, ask('u1', 10_000), 1_000);
    await pollForDevice(t.db, 'u1', 'mac-a', 1_000);
    let clock = 1_000;
    const result = await waitForAnswer(t.db, id, 3_000, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        // The answer arrives in the last nap, right before the ask would close.
        if (clock >= 3_000) await resolveForDevice(t.db, 'u1', 'mac-a', id, { status: 'answered', text: 'just in time' }, clock);
      },
      everyMs: 1_000,
    });
    expect(result).toEqual({ status: 'answered', text: 'just in time' });
    const row = t.sqlite.query('SELECT status FROM agent_messages').get() as { status: string };
    expect(row.status).toBe('answered');
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

  test('an ask held by a Mac that went quiet goes to one that polls', async () => {
    const t = setup();
    const id = await createMessage(t.db, ask('u1', 10 * 60_000), 1_000);
    expect((await pollForDevice(t.db, 'u1', 'mac-a', 1_000)).waiting).toEqual([id]);
    expect((await pollForDevice(t.db, 'u1', 'mac-b', 2_000)).items).toEqual([]);
    const later = 1_000 + LISTENING_MS + 1;
    // Its call is still held.
    t.sqlite.run('UPDATE agent_messages SET held_at = ?', [later]);
    expect((await pollForDevice(t.db, 'u1', 'mac-b', later)).items.map((item) => item.id)).toEqual([id]);
    expect(await resolveForDevice(t.db, 'u1', 'mac-a', id, { status: 'answered', text: 'old' }, later)).toBe(false);
  });

  test('an ask whose call was cut off leaves the Mac and takes no answer', async () => {
    const t = setup();
    const id = await createMessage(t.db, ask('u1', 10 * 60_000), 1_000);
    expect((await pollForDevice(t.db, 'u1', 'mac-a', 1_000)).waiting).toEqual([id]);
    const gone = 1_000 + HELD_MS + 1;
    expect((await pollForDevice(t.db, 'u1', 'mac-a', gone)).waiting).toEqual([]);
    expect(await resolveForDevice(t.db, 'u1', 'mac-a', id, { status: 'answered', text: 'late' }, gone)).toBe(false);
  });

  test('a held call keeps its ask alive and reads less often after a minute', async () => {
    const t = setup();
    const id = await createMessage(t.db, ask('u1', 10 * 60_000), 0);
    await pollForDevice(t.db, 'u1', 'mac-a', 0);
    let clock = 0;
    const naps: number[] = [];
    const result = await waitForAnswer(t.db, id, 90_000, { now: () => clock, sleep: async (ms) => { naps.push(ms); clock += ms; }, everyMs: 1_000 });
    expect(result).toEqual({ status: 'timeout' });
    expect(naps.slice(0, 3)).toEqual([1_000, 1_000, 1_000]);
    expect(naps.at(-2)).toBe(2_000);
    const held = t.sqlite.query('SELECT held_at FROM agent_messages').get() as { held_at: number };
    expect(held.held_at).toBeGreaterThan(90_000 - HELD_MS);
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
