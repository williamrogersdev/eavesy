import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { polishDictation } from './agent-transcript';

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

  test('accepts a long dictation cleaned into paragraphs and a list', async () => {
    const long =
      'okay so a few things um first fix the login bug then uh update the onboarding screens and third send the release notes to the team before Friday also the deck needs new screenshots';
    const { client, calls } = fakeClient(
      'Okay, a few things:\n\n1. Fix the login bug.\n2. Update the onboarding screens.\n3. Send the release notes to the team before Friday.\n\nAlso, the deck needs new screenshots.',
    );
    const result = await polishDictation(client, { text: long, context: null });
    expect(result.polished).toBe(true);
    expect(result.text).toContain('\n2. Update the onboarding screens.');
    expect(calls[0].system).toContain('no markdown');
    expect(calls[0].system).not.toContain('in backticks');
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
