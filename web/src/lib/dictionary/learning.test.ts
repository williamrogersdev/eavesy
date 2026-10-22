import { describe, expect, test } from 'bun:test';
import { isLearnableSpelling, learnCorrections } from './learning';

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
    for (const [from, to] of [['Yvesy', 'Eavesy'], ['gay lord boxes', 'Gaylord Boxes'], ['next js', 'Next.js'], ['curry', 'Currie'], ['repack if I', 'Repackify'], ['Jon', 'John']]) {
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
});
