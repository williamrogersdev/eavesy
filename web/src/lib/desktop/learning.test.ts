import { describe, expect, test } from 'bun:test';
import { learnedLabel } from './learning';

describe('learnedLabel', () => {
  test('names the learned word', () => {
    expect(learnedLabel({ status: 'saved', learned: 1, words: [{ from: 'pool', to: 'pull' }] })).toBe('Added “pull”');
  });
  test('counts the rest when several words were learned', () => {
    expect(learnedLabel({ status: 'saved', learned: 3, words: [{ from: 'cube', to: 'Kubernetes' }, { from: 'a', to: 'b' }, { from: 'c', to: 'd' }] })).toBe('Added “Kubernetes” +2');
  });
  test('falls back to a count when the server sends no words', () => {
    expect(learnedLabel({ status: 'saved', learned: 2 })).toBe('Learned 2 corrections');
  });
  test('a fix seen once is only suggested', () => {
    expect(learnedLabel({ status: 'saved', learned: 1, words: [{ from: 'SEO', to: 'SEU', pending: true }] })).toBe('Suggested “SEU”');
    expect(learnedLabel({ status: 'saved', learned: 2, words: [{ from: 'a', to: 'Bee', pending: true }, { from: 'c', to: 'Dee', pending: false }] })).toBe('Added “Bee” +1');
  });
  test('says nothing when nothing new was saved', () => {
    expect(learnedLabel({ status: 'saved', learned: 0, words: [] })).toBeNull();
    expect(learnedLabel({ status: 'watching' })).toBeNull();
    expect(learnedLabel({ status: 'failed', message: 'offline' })).toBeNull();
  });
});
