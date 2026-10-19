import { describe, expect, test } from 'bun:test';
import { parseTranslation, translateSystemPrompt, translateUserMessage } from './translate';

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
