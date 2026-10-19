import { describe, expect, test } from 'bun:test';
import { MAX_ONBOARDING_PROJECTS, newProjectNames } from './onboarding';

describe('newProjectNames', () => {
  test('tidies names and skips blanks and repeats, including existing projects', () => {
    expect(newProjectNames(['  Acme   redesign ', 'acme redesign', '', 'Thesis', 'Inbox'], ['inbox'])).toEqual([
      'Acme redesign',
      'Thesis',
    ]);
  });

  test('stops at the onboarding limit', () => {
    const names = Array.from({ length: MAX_ONBOARDING_PROJECTS + 3 }, (_, i) => `Project ${i}`);
    expect(newProjectNames(names, [])).toHaveLength(MAX_ONBOARDING_PROJECTS);
  });
});
