import { describe, expect, test } from 'bun:test';
import { nemotronPrompt, nemotronRequest, nemotronTurns } from './nemotron';
import { cpErrors, parseReference, wordErrors, words } from './score';

describe('word error rate', () => {
  test('ignores case, punctuation and how numbers are written', () => {
    expect(words("At 3:00, we'll send five-ish Docs.")).toEqual(['at', 'three', 'zero', 'well', 'send', 'five', 'ish', 'docs']);
    expect(words('before 5 and 42')).toEqual(['before', 'five', 'and', 'forty', 'two']);
    expect(wordErrors(words('ship it before five'), words('Ship it before 5.')).errors).toBe(0);
  });

  test('counts substitutions, deletions and insertions', () => {
    expect(wordErrors(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])).toEqual({
      errors: 2,
      refWords: 4,
      hypWords: 5,
      substitutions: 1,
      deletions: 0,
      insertions: 1,
    });
    expect(wordErrors(['a', 'b'], []).deletions).toBe(2);
    expect(wordErrors([], ['thank', 'you']).insertions).toBe(2);
    expect(wordErrors(['the', 'cat', 'sat'], ['cat', 'sat', 'down'])).toMatchObject({ errors: 2, substitutions: 0, deletions: 1, insertions: 1 });
  });

  test('reads thousands separators as one number', () => {
    expect(words('1,000 people')).toEqual(['1000', 'people']);
  });

  test('counts errors across a long recording', () => {
    const ref = Array.from({ length: 6_000 }, (_, i) => `w${i % 97}`);
    const hyp = ref.map((word, i) => (i % 50 === 0 ? 'x' : word));
    expect(wordErrors(ref, hyp)).toMatchObject({ errors: 120, substitutions: 120 });
  });
});

describe('speaker-attributed word error rate', () => {
  const ref = [
    { speaker: 'you', text: 'shall we start' },
    { speaker: 'them', text: 'yes please' },
    { speaker: 'you', text: 'great' },
  ];

  test('pairs speakers whatever the recognizer called them', () => {
    const hyp = [
      { speaker: 'spk:1', text: 'shall we start' },
      { speaker: 'spk:0', text: 'yes please' },
      { speaker: 'spk:1', text: 'great' },
    ];
    expect(cpErrors(ref, hyp)).toMatchObject({ errors: 0, refWords: 6, refSpeakers: 2, hypSpeakers: 2 });
  });

  test('charges words given to the wrong speaker', () => {
    const merged = [{ speaker: 'spk:0', text: 'shall we start yes please great' }];
    const cp = cpErrors(ref, merged);
    expect(cp).toMatchObject({ errors: 4, insertions: 2, deletions: 2 });
    expect(wordErrors(['shall', 'we', 'start', 'yes', 'please', 'great'], words(merged[0].text)).errors).toBe(0);
  });

  test('counts an extra recognized speaker as insertions', () => {
    const hyp = [
      { speaker: 'spk:0', text: 'shall we start great' },
      { speaker: 'spk:1', text: 'yes please' },
      { speaker: 'spk:2', text: 'hmm' },
    ];
    expect(cpErrors(ref, hyp)).toMatchObject({ errors: 1, insertions: 1, hypSpeakers: 3 });
  });
});

describe('reference files', () => {
  test('reads speaker labels only when every line has one', () => {
    expect(parseReference('Maya: Let us look.\n\nSam: The checklist: later.\n')).toEqual([
      { speaker: 'Maya', text: 'Let us look.' },
      { speaker: 'Sam', text: 'The checklist: later.' },
    ]);
    expect(parseReference('Agenda: launch\nwe talked about pricing')).toEqual([
      { speaker: null, text: 'Agenda: launch' },
      { speaker: null, text: 'we talked about pricing' },
    ]);
  });
});

describe('Nemotron 3.5 Transcribe', () => {
  test('asks for speaker tags and adds context terms', () => {
    expect(nemotronPrompt()).toContain('<spk:0>');
    expect(nemotronPrompt(['Eavesy', 'Vectorize'])).toEndWith('Context terms: Eavesy, Vectorize.');
    const body = nemotronRequest(new Uint8Array([1, 2, 3]));
    expect(body.messages[0].content[1]).toEqual({ type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,AQID' } });
    expect(body).toMatchObject({ temperature: 0, skip_special_tokens: false, chat_template_kwargs: { enable_thinking: false } });
  });

  test('splits the transcript into turns at speaker tags', () => {
    const response = {
      choices: [{ message: { content: 'Hello. <spk:0> Shall we start?<spk:1>Yes, please. <|im_end|>' } }],
    };
    expect(nemotronTurns(response)).toEqual([
      { speaker: null, text: 'Hello.' },
      { speaker: 'spk:0', text: 'Shall we start?' },
      { speaker: 'spk:1', text: 'Yes, please.' },
    ]);
  });

  test('reads content given as parts and drops reasoning, closed or not', () => {
    expect(nemotronTurns({ choices: [{ message: { content: [{ type: 'text', text: '<spk:2> Hi' }] } }] })).toEqual([
      { speaker: 'spk:2', text: 'Hi' },
    ]);
    expect(nemotronTurns({ choices: [{ message: { content: '<think>hmm</think><spk:0> Hi' } }] })).toEqual([
      { speaker: 'spk:0', text: 'Hi' },
    ]);
    expect(nemotronTurns({ choices: [{ message: { content: '<spk:0> Hi <think>still going' } }] })).toEqual([
      { speaker: 'spk:0', text: 'Hi' },
    ]);
  });

  test('rejects a missing, empty or cut-off transcript instead of scoring it', () => {
    expect(() => nemotronTurns({ error: 'overloaded' })).toThrow('no transcript');
    expect(() => nemotronTurns({ choices: [{ message: { content: '  ' } }] })).toThrow('no transcript');
    expect(() => nemotronTurns({ choices: [{ finish_reason: 'length', message: { content: '<spk:0> Hi' } }] })).toThrow('cut off');
    expect(() => nemotronTurns({ choices: [{ message: { content: '<think>thinking</think><spk:0> <|im_end|>' } }] })).toThrow('after removing');
  });
});
