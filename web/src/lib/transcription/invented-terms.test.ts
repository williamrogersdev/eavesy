import { expect, test } from 'bun:test';
import { inventedTerms, likeness } from './invented-terms';

const terms = ['Repackify', 'Gaylord Boxes', '1db', 'Rust', 'convex', 'code'];

test('a term dropped in over unrelated words is invented', () => {
  expect(inventedTerms('we should check the orders tonight', 'We should check the Repackify orders tonight.', terms)).toEqual(['Repackify']);
  expect(inventedTerms('just ship it', 'Just ship it in Rust.', terms)).toEqual(['Rust']);
});

test('a term put where the heard words sound like it is a fix', () => {
  expect(inventedTerms('send it to repack of support', 'Send it to Repackify support.', terms)).toEqual([]);
  expect(inventedTerms('the re packify dashboard', 'The Repackify dashboard.', terms)).toEqual([]);
  expect(inventedTerms('order the gay lord boxes', 'Order the Gaylord Boxes.', terms)).toEqual([]);
  expect(inventedTerms('put it in one db', 'Put it in 1db.', terms)).toEqual([]);
  expect(inventedTerms('konvex works', 'Convex works.', terms)).toEqual([]);
});

test('a term already said, or said as a confirmed fix, may stay', () => {
  expect(inventedTerms('Repackify is down', 'Repackify is down.', terms)).toEqual([]);
  expect(inventedTerms('open the wrap app', 'Open the Repackify.', terms, [{ from: 'wrap app', to: 'Repackify' }])).toEqual([]);
});

test('one sound-alike allows one term, not two', () => {
  expect(inventedTerms('repack of support and the orders', 'Repackify support and the Repackify orders.', terms)).toEqual(['Repackify']);
});

test('everyday words in the dictionary are free to use', () => {
  expect(inventedTerms('fix the thing', 'Fix the code.', terms)).toEqual([]);
});

test('likeness matches the on-device speller', () => {
  expect(likeness('pallet', 'pallet')).toBe(1);
  expect(likeness('palettes', 'pallets')).toBeCloseTo(0.8, 2);
  expect(likeness('rustbased', 'rust')).toBe(0);
  expect(likeness('', 'rust')).toBe(0);
});
