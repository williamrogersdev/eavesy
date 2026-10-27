import { describe, expect, test } from 'bun:test';
import { score } from './filter';

describe('launcher score', () => {
  test('ranks each tier above the next', () => {
    const tiers = [
      score('standup', 'Standup'),
      score('stand', 'Standup notes'),
      score('notes', 'Standup notes'),
      score('ndup', 'Standup notes'),
      score('budget', 'Standup', 'we talked about the budget'),
      score('budget standup', 'Standup', 'the budget'),
      score('roadmap', 'Standup', 'the budget'),
    ];
    expect(tiers).toEqual([1000, 800, 600, 400, 150, 100, -1]);
    for (let i = 1; i < tiers.length; i++) expect(tiers[i - 1]).toBeGreaterThan(tiers[i]);
  });

  test('splits title words on dashes, underscores and slashes', () => {
    for (const title of ['Q3 — review', 'q3-review', 'q3_review', 'q3/review']) expect(score('review', title)).toBe(600);
  });

  test('needs every token for a multi-token match', () => {
    expect(score('budget roadmap', 'Standup', 'the budget')).toBe(-1);
    expect(score('budget', 'Standup')).toBe(-1);
  });

  test('an empty or whitespace-only query scores 0', () => {
    expect(score('', 'Standup')).toBe(0);
    expect(score('   ', 'Standup', 'body')).toBe(0);
  });

  test('ignores case and surrounding whitespace in the query', () => {
    expect(score('  STANDUP ', 'standup')).toBe(1000);
    expect(score('Notes', 'STANDUP NOTES')).toBe(600);
    expect(score('BUDGET', 'Standup', 'The Budget')).toBe(150);
  });
});
