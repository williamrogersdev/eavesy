import { describe, expect, test } from 'bun:test';
import { isLearnableSpelling, isPlainWords, learnCorrections, learnedReason } from './learning';

describe('human correction learning', () => {
  test('learns separate local substitutions and split words', () => {
    expect(learnCorrections('Send this to re packify and open a pool request tomorrow.', 'Send this to Repackify and open a pull request tomorrow.'))
      .toEqual([{ from: 're packify', to: 'Repackify' }]);
    expect(learnCorrections('Ask Yvesy about the order for gay lord boxes and the new site built by Ann today', 'Ask Eavesy about the order for Gaylord Boxes and the new site built by Ann today'))
      .toEqual([{ from: 'Yvesy', to: 'Eavesy' }, { from: 'gay lord boxes', to: 'Gaylord Boxes' }]);
  });
  test('does not learn capitalization, ordinary words, grammar or rewrites', () => {
    expect(learnCorrections('use eavesy today', 'use Eavesy today')).toEqual([]);
    expect(learnCorrections('I keep it and ship it before. Is it full', 'I kept it and shipped it beforehand. Seems it uber')).toEqual([]);
  });
  test('learnable spellings look like mis-heard names or terms', () => {
    for (const [from, to] of [['Yvesy', 'Eavesy'], ['gay lord boxes', 'Gaylord Boxes'], ['next js', 'Next.js'], ['curry', 'Currie'], ['repack if I', 'Repackify'], ['Jon', 'John'],
      // A letter missing inside a name, not a new ending: these were wrongly skipped before.
      ['Eavsy', 'Eavesy'], ['Repackfy', 'Repackify']]) {
      expect(isLearnableSpelling(from, to)).toBe(true);
    }
    for (const [from, to] of [['eavesy', 'Eavesy'], ['keep', 'kept'], ['seem', 'seems'], ['ship', 'shipped'], ['fall', 'full'],
      ['before', 'beforehand'], ['great', 'rate it'], ['over', 'uber'], ['Keep', 'Kept'], ['Ship', 'Shipped'], ['Is', 'Seems'], ['Seem', 'Seems'], ['Before', 'Beforehand']]) {
      expect(isLearnableSpelling(from, to)).toBe(false);
    }
  });
  test('does not turn deletions, numeric edits, negation, or rewrites into rules', () => {
    for (const [a, b] of [ ['um hello there', 'hello there'], ['Pay 15 dollars', 'Pay 50 dollars'],
      ['Do not send it', 'Do send it'], ['I will send this today', 'Please hold the entire shipment until Friday'] ]) {
      expect(learnCorrections(a, b)).toEqual([]);
    }
  });
  test('sentence rewrites seen in pasted text are never suggested', () => {
    // Yeah, So, Where, Then, Okay, Friday, 10 and Its all used to come back as suggestions:
    // the edited word starts a sentence, so it is capitalised, and it is a short edit away.
    for (const [from, to] of [['Yeah', 'Yes'], ['Can', 'Could'], ['So', 'Also'], ['Where', 'Were'], ['Then', 'When'],
      ['Okay', 'OK'], ['Friday', 'Monday'], ['Hey', 'Hi'], ['Thanks', 'Thank'], ['Notes', 'Note'], ['10', '10am'], ['Its', "It's"]]) {
      expect({ from, to, learnable: isLearnableSpelling(from, to) }).toEqual({ from, to, learnable: false });
    }
    expect(learnCorrections('Yeah we should ship this Friday. Can you check?', 'Yes we should ship this Monday. Could you check?')).toEqual([]);
    expect(learnCorrections('So I think the tests pass.', 'Also I think the tests pass.')).toEqual([]);
    expect(learnCorrections('Where all set for the meeting at 10.', 'Were all set for the meeting at 10am.')).toEqual([]);
  });
  test('names, products and jargon still are, even next to everyday words', () => {
    expect(learnCorrections('Yeah ask cloud to open the pr in eavsy.', 'Yes ask Claude to open the pr in Eavesy.'))
      .toEqual([{ from: 'cloud', to: 'Claude' }, { from: 'eavsy', to: 'Eavesy' }]);
    for (const to of ['Claude', 'Next.js', 'C++', 'Gaylord Boxes', 'PostHog', 'John', 'D1']) expect({ to, plain: isPlainWords(to) }).toEqual({ to, plain: false });
    for (const to of ['Yes', 'Monday', 'OK', 'Thank you', '10am', 'I']) expect({ to, plain: isPlainWords(to) }).toEqual({ to, plain: true });
    // Plurals and possessives: only of everyday words, never of a name that ends in s.
    for (const to of ['Notes', "Team's", 'Fixes']) expect({ to, plain: isPlainWords(to) }).toEqual({ to, plain: true });
    for (const to of ['Kubes', 'Atlas', 'Claude Code', 'VS Code', 'Repackify’s']) expect({ to, plain: isPlainWords(to) }).toEqual({ to, plain: false });
  });
  test('a learned entry says what the user changed and how often', () => {
    const now = new Date(2026, 9, 29, 12).getTime();
    expect(learnedReason({ from: 'Eavsy', to: 'Eavesy', seen: 3, updatedAt: now - 86_400_000 }, now))
      .toBe('You changed “Eavsy” to “Eavesy” 3 times, most recently yesterday.');
    expect(learnedReason({ from: 'post hog', to: 'PostHog', seen: 1, updatedAt: now }, now)).toBe('You changed “post hog” to “PostHog” once, today.');
    expect(learnedReason({ from: 'cube cuddle', to: 'kubectl', seen: 2, updatedAt: new Date(2026, 9, 2).getTime() }, now))
      .toBe('You changed “cube cuddle” to “kubectl” twice, most recently on Oct 2.');
  });
});
