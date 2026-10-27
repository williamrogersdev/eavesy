import { afterEach, describe, expect, test } from 'bun:test';
import { parseTranslation, TRANSLATE_BATCH, translateLines, translateSystemPrompt, translateUserMessage } from './translate';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const lines = [
  { id: 'a', text: 'Hola a todos' },
  { id: 'b', text: 'Empezamos\ncon el presupuesto' },
];

describe('translate', () => {
  test('numbers lines on one row each', () => {
    expect(translateUserMessage(lines)).toBe('0\tHola a todos\n1\tEmpezamos con el presupuesto');
    expect(translateSystemPrompt('en')).toContain('into English');
  });

  test('pairs numbered replies back to line ids and drops junk', () => {
    const reply = 'Here you go: {"lines":[{"n":1,"text":" Let\'s start with the budget "},{"n":0,"text":"Hi everyone"},{"n":7,"text":"x"},{"n":0}]}';
    expect(parseTranslation(reply, lines)).toEqual(
      new Map([
        ['b', "Let's start with the budget"],
        ['a', 'Hi everyone'],
      ]),
    );
    expect(parseTranslation('not json', lines).size).toBe(0);
  });
});

describe('translateLines', () => {
  const many = Array.from({ length: TRANSLATE_BATCH + 1 }, (_, i) => ({ id: `l${i}`, text: `línea ${i}` }));
  const reply = (body: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 });

  test('keeps the batches that worked when another fails', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? new Response('down', { status: 500 }) : reply('{"lines":[{"n":0,"text":"line 60"}]}');
    }) as unknown as typeof fetch;
    const out = await translateLines({ lines: many, to: 'en', openRouter: { apiKey: 'k' } });
    expect(calls).toBe(2);
    expect([...out]).toEqual([['l60', 'line 60']]);
  });

  test('fails when every batch fails', async () => {
    globalThis.fetch = (async () => new Response('down', { status: 500 })) as unknown as typeof fetch;
    expect(translateLines({ lines: many, to: 'en', openRouter: { apiKey: 'k' } })).rejects.toThrow();
  });
});
