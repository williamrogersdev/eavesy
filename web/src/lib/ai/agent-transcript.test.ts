import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { polishDictation, restyledIsValid } from './agent-transcript';

function fakeClient(reply: string | Error) {
  const calls: { system: string; content: string }[] = [];
  const client = {
    messages: {
      create: async (request: { system: string; messages: { content: string }[] }) => {
        calls.push({ system: request.system, content: request.messages[0].content });
        if (reply instanceof Error) throw reply;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const said = 'Um, so, like, can you, uh, can you move the the standup to Thursday and tell Priya';

describe('polishDictation', () => {
  test('uses the model cleanup and spells words from the context', async () => {
    const { client, calls } = fakeClient('Can you move the standup to Thursday and tell Priya?');
    const result = await polishDictation(client, { text: said, context: 'Words: Priya, Eavesy' });
    expect(result).toEqual({ text: 'Can you move the standup to Thursday and tell Priya?', polished: true });
    expect(calls[0].system).toContain('typed at their cursor');
    expect(calls[0].system).toContain('Words: Priya, Eavesy');
    expect(calls[0].system).not.toContain('[unclear]');
    expect(calls[0].content).toContain(said);
  });

  test('keeps the plain cleanup when the model answers instead of cleaning', async () => {
    const { client } = fakeClient('Sure! I have rescheduled the meeting to Thursday for you and notified everyone.');
    const result = await polishDictation(client, { text: said, context: null });
    expect(result.polished).toBe(false);
    expect(result.text).toBe('So, like, can you, can you move the standup to Thursday and tell Priya');
  });

  test('keeps the plain cleanup when the model fails or there is no key', async () => {
    const failing = fakeClient(new Error('overloaded'));
    expect((await polishDictation(failing.client, { text: said, context: null })).polished).toBe(false);
    expect((await polishDictation(null, { text: said, context: null })).text).toStartWith('So, like');
  });

  test('pastes a few words as said without asking the model', async () => {
    const { client, calls } = fakeClient('unused');
    expect(await polishDictation(client, { text: '  Okay, ship it. ', context: null })).toEqual({
      text: 'Okay, ship it.',
      polished: false,
    });
    expect(calls).toHaveLength(0);
  });
});

test('short dictations use learned context and keep confirmed spellings', async () => {
  const { client, calls } = fakeClient('Open a pull request.');
  const result = await polishDictation(client, { text: 'Open a pool request.', context: 'Human correction: pool -> pull', hasCorrections: true, corrections: [{ from: 'pool', to: 'pull' }] });
  expect(calls).toHaveLength(1);
  expect(result.text).toBe('Open a pull request.');
  const wrong = fakeClient('The information was transcribed and typed in the saved transcript.');
  const text = 'The information was transcribed and kept in the saved transcript.';
  expect(await polishDictation(wrong.client, { text, context: null, confirmedSpellings: ['kept'] })).toEqual({ text, polished: false });
});

describe('dictation styles', () => {
  const ramble = 'Okay so the fucking login page keeps breaking, um, can you fix the redirect in auth dot ts and, like, make sure it goes back to the dashboard, and add a test for it';

  test('formatting for agents restructures the request as a prompt', async () => {
    const reply = 'Fix the redirect in `auth.ts`: the login page keeps breaking.\n\n## Requirements\n1. Make sure login goes back to the dashboard.\n2. Add a test for the redirect.';
    const { client, calls } = fakeClient(reply);
    const result = await polishDictation(client, { text: ramble, context: null, forAgents: true });
    expect(result).toEqual({ text: reply, polished: true });
    expect(calls[0].system).toContain('message for an AI agent');
    expect(calls[0].system).toContain("keep the speaker's own voice");
    expect(calls[0].system).toContain('Add facts, requirements');
  });

  test('a tone combines with formatting for agents', async () => {
    const { client, calls } = fakeClient('Fix the login redirect in `auth.ts` so it returns to the dashboard, and add a test.');
    await polishDictation(client, { text: ramble, context: null, style: 'concise', forAgents: true });
    expect(calls[0].system).toContain('message for an AI agent');
    expect(calls[0].system).toContain('Tone: concise');
  });

  test('a tone alone rewrites as a typed message', async () => {
    const { client, calls } = fakeClient('Could you fix the login redirect in `auth.ts` so it goes back to the dashboard, and add a test for it?');
    await polishDictation(client, { text: ramble, context: null, style: 'professional' });
    expect(calls[0].system).toContain('reads as a message the speaker typed');
    expect(calls[0].system).toContain('Tone: professional');
    expect(calls[0].system).not.toContain('message for an AI agent');
  });

  test('a clean style drops swearing even when the model fails', async () => {
    const failing = fakeClient(new Error('overloaded'));
    const result = await polishDictation(failing.client, { text: ramble, context: null, style: 'friendly' });
    expect(result.polished).toBe(false);
    expect(result.text).not.toMatch(/fuck/i);
    expect(result.text).toContain('login page keeps breaking');
  });

  test('formatting for agents drops swearing in the fallback too', async () => {
    const failing = fakeClient(new Error('overloaded'));
    expect((await polishDictation(failing.client, { text: ramble, context: null, forAgents: true })).text).not.toMatch(/fuck/i);
  });

  test('the natural style keeps the speaker’s words when the model fails', async () => {
    const failing = fakeClient(new Error('overloaded'));
    expect((await polishDictation(failing.client, { text: ramble, context: null })).text).toContain('fucking');
  });

  test('a clean style strips swearing the model left in', async () => {
    const { client } = fakeClient('The fucking login page keeps breaking. Fix the redirect in `auth.ts` so it goes back to the dashboard, and add a test for it.');
    const result = await polishDictation(client, { text: ramble, context: null, style: 'professional' });
    expect(result.polished).toBe(true);
    expect(result.text).not.toMatch(/fuck/i);
  });

  test('a restyle that answers instead of rewriting is rejected', async () => {
    const { client } = fakeClient('Great news! I have already shipped a patch, everything should work perfectly now.');
    expect((await polishDictation(client, { text: ramble, context: null, style: 'professional' })).polished).toBe(false);
  });
});

describe('restyledIsValid', () => {
  const said = [{ speaker: null, text: 'can you move the standup to thursday and tell priya about the launch plan' }];
  test('accepts rewording that keeps what was said', () => {
    expect(restyledIsValid(said, 'Could you move the standup to Thursday and let Priya know about the launch plan?')).toBe(true);
  });
  test('rejects an on-topic answer that invents numbers', () => {
    expect(restyledIsValid(said, 'I moved the standup to Thursday at 10 and told Priya the launch plan is set for March 3.')).toBe(false);
    expect(restyledIsValid([{ speaker: null, text: 'it failed three times on build 42' }], 'The build 42 failed 3 times.')).toBe(true);
  });
  test('rejects empty, padded or unrelated output', () => {
    expect(restyledIsValid(said, '')).toBe(false);
    expect(restyledIsValid(said, 'Sure, rescheduled everything already, nothing further needed from anyone here.')).toBe(false);
  });
});
