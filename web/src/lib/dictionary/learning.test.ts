import { describe, expect, test } from 'bun:test';
import { learnCorrections } from './learning';

describe('human correction learning', () => {
  test('learns separate local substitutions and split words', () => {
    expect(learnCorrections('Send this to re packify and open a pool request tomorrow.', 'Send this to Repackify and open a pull request tomorrow.'))
      .toEqual([{ from: 're packify', to: 'Repackify' }, { from: 'pool', to: 'pull' }]);
  });
  test('learns capitalization', () => {
    expect(learnCorrections('use eavesy today', 'use Eavesy today')).toEqual([{ from: 'eavesy', to: 'Eavesy' }]);
  });
  test('does not turn deletions, numeric edits, negation, or rewrites into rules', () => {
    for (const [a, b] of [ ['um hello there', 'hello there'], ['Pay 15 dollars', 'Pay 50 dollars'],
      ['Do not send it', 'Do send it'], ['I will send this today', 'Please hold the entire shipment until Friday'] ]) {
      expect(learnCorrections(a, b)).toEqual([]);
    }
  });
});
