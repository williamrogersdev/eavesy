import { describe, expect, test } from 'bun:test';
import cases from './live-edit-cases.json';
import { mergeTranscript } from './live-edit';

describe('live transcript corrections', () => {
  for (const fixture of cases) test(fixture.name, () => {
    expect(mergeTranscript(fixture, fixture.incoming)).toBe(fixture.expected);
  });
  test('large replacement bounds diff work and keeps the user correction', () => {
    const source = 'old '.repeat(2000);
    expect(mergeTranscript({ source, text: 'My replacement' }, 'new '.repeat(2000))).toBe('My replacement');
  });
});

test('long captures retain an early correction and append new speech', () => {
  const tail = ' A stable sentence.'.repeat(2000);
  const source = `Wrong name.${tail}`;
  expect(mergeTranscript({ source, text: `Right name.${tail}` }, `${source} A final sentence.`))
    .toBe(`Right name.${tail} A final sentence.`);
});
