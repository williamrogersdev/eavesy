import { describe, expect, test } from 'bun:test';
import { changeOutcome, needsRewrite, PLAIN, toneRow } from './hud-writing';

const professionalForAi = { style: 'professional', forAgents: true } as const;

describe('toneRow', () => {
  test('shows the tone the server said, and the words are in it when the model applied it', () => {
    const row = toneRow({ ...professionalForAi, projectId: null, applied: true }, PLAIN, null);
    expect(row).toEqual({ picked: professionalForAi, from: professionalForAi });
  });
  test('a tone the model did not apply is still the setting, but the words count as plain', () => {
    const row = toneRow({ ...professionalForAi, projectId: 'p1', applied: false }, PLAIN, null);
    expect(row).toEqual({ picked: professionalForAi, from: PLAIN });
  });
  test('without a word from the server, the saved choice stands in and the words count as plain', () => {
    expect(toneRow(null, professionalForAi, null)).toEqual({ picked: professionalForAi, from: PLAIN });
    expect(toneRow(undefined, null, null)).toEqual({ picked: PLAIN, from: PLAIN });
  });
  test('a change shows what was picked and keeps the tone the words started in', () => {
    const change = { from: professionalForAi, pick: 'concise', forAgents: false } as const;
    expect(toneRow({ ...professionalForAi, projectId: null, applied: true }, PLAIN, change))
      .toEqual({ picked: { style: 'concise', forAgents: false }, from: professionalForAi });
  });
});

describe('needsRewrite', () => {
  const row = { picked: { style: 'concise', forAgents: false } as const, from: professionalForAi };
  test('picking what is picked does nothing', () => {
    expect(needsRewrite({ style: 'concise', forAgents: false }, row)).toBe('none');
  });
  test('picking the tone the words started in puts them back without the server', () => {
    expect(needsRewrite(professionalForAi, row)).toBe('restore');
  });
  test('anything else is a rewrite', () => {
    expect(needsRewrite({ style: 'friendly', forAgents: true }, row)).toBe('rewrite');
    expect(needsRewrite(PLAIN, row)).toBe('rewrite');
  });
});

describe('changeOutcome', () => {
  test('not kept: the row goes back and says so', () => {
    expect(changeOutcome(false, false)).toEqual({ revert: true, say: 'Couldn’t change the tone. Try again?' });
  });
  test('kept but not rewritten: the choice stays, the words stay, and it says which', () => {
    expect(changeOutcome(true, false)).toEqual({ revert: false, say: 'Kept for next time, but this one couldn’t be rewritten' });
  });
  test('both done: nothing to say', () => {
    expect(changeOutcome(true, true)).toEqual({ revert: false, say: null });
  });
});
