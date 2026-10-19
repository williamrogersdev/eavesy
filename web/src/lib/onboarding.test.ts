import { describe, expect, test } from 'bun:test';
import { MAX_ONBOARDING_PROJECTS, newProjectNames, takeProjectDraft } from './onboarding';

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

describe('takeProjectDraft', () => {
  test('names before the last comma become projects and the rest stays a draft', () => {
    expect(takeProjectDraft([], 'Acme, Th')).toEqual({ projects: ['Acme'], draft: 'Th' });
    expect(takeProjectDraft(['Acme'], 'Thesis,')).toEqual({ projects: ['Acme', 'Thesis'], draft: '' });
    expect(takeProjectDraft(['Acme'], 'Thes')).toEqual({ projects: ['Acme'], draft: 'Thes' });
  });

  test('finishing takes a pasted list whole, tidied and capped', () => {
    expect(takeProjectDraft(['Acme'], ' acme ,, Thesis ,  Side   gig', true)).toEqual({
      projects: ['Acme', 'Thesis', 'Side gig'],
      draft: '',
    });
    const many = Array.from({ length: 12 }, (_, i) => `P${i}`).join(',');
    expect(takeProjectDraft([], many, true).projects).toHaveLength(MAX_ONBOARDING_PROJECTS);
  });
});
