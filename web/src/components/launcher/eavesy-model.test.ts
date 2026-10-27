import { describe, expect, test } from 'bun:test';
import type { AssistantCard } from '@/lib/desktop/bridge';
import { acceptLabel, activityLine, modeIsLoud, modeLabel, ruleChangeLine, rulesWaitingLine, secondsLeft, sortVoices, toolLabel } from './eavesy-model';

const card = (rows: string[]): AssistantCard => ({
  id: 'c', requester: 'You', tool: 'machine.clean', title: 'Remove 2 worktrees', warning: null, expires_ms: 60_000,
  rows: rows.map((id) => ({ id, label: id })),
});

describe('eavesy model', () => {
  test('the mode chip says what is in force and for how long', () => {
    expect(modeLabel({ effective: 'ask', until_ms: 5 }, 0)).toBe('Ask');
    expect(modeLabel({ effective: 'bypass', until_ms: null }, 0)).toBe('Bypass');
    expect(modeLabel({ effective: 'bypass', until_ms: 42 * 60_000 }, 0)).toBe('Bypass · 42m');
    expect(modeLabel({ effective: 'auto', until_ms: 3 * 3_600_000 }, 0)).toBe('Auto · 3h');
    expect(modeLabel({ effective: 'bypass', until_ms: 10 }, 0)).toBe('Bypass · 1m');
    expect(modeIsLoud('ask')).toBe(false);
    expect(modeIsLoud('bypass')).toBe(true);
  });

  test('the allow button counts the ticked rows', () => {
    const two = card(['a', 'b']);
    expect(acceptLabel(two, new Set(['a', 'b']))).toBe('Allow these 2');
    expect(acceptLabel(two, new Set(['b']))).toBe('Allow 1 of 2');
    expect(acceptLabel(card(['a']), new Set(['a']))).toBe('Allow');
    expect(secondsLeft(two, 59_000)).toBe(1);
    expect(secondsLeft(two, 70_000)).toBe(0);
  });

  test('tools get plain names', () => {
    expect(toolLabel('machine_overview')).toBe('Looked at this Mac');
    expect(toolLabel('something_new')).toBe('something_new');
  });
});

describe('assistant settings', () => {
  test('voices in your language come first', () => {
    const voices = [{ name: 'Thomas', locale: 'fr_FR' }, { name: 'Samantha', locale: 'en_US' }, { name: 'Daniel', locale: 'en_GB' }];
    expect(sortVoices(voices, 'en-AU').map((voice) => voice.name)).toEqual(['Daniel', 'Samantha', 'Thomas']);
    expect(sortVoices(voices, 'fr').map((voice) => voice.name)).toEqual(['Thomas', 'Daniel', 'Samantha']);
  });

  test('activity says how each action ended', () => {
    const base = { at_ms: 0, requester: 'You', tool: 'machine.clean', summary: 'Clean up 2' };
    expect(toolLabel(base.tool)).toBe('Clean-up');
    expect(activityLine({ ...base, decision: 'accepted', outcome: 'removed 2' })).toBe('Accepted: removed 2');
    expect(activityLine({ ...base, decision: 'card' })).toBe('Asked first');
    expect(activityLine({ ...base, decision: 'something new' })).toBe('something new');
  });

  test('rule changes read as one line each, and the thread says when any wait', () => {
    const rule = { kind: 'remove_worktrees' as const, under: '/Users/w/Developer' };
    expect(ruleChangeLine({ kind: 'add', rule, text: 'Remove finished worktrees under ~/Developer' })).toBe('Added: Remove finished worktrees under ~/Developer');
    expect(ruleChangeLine({ kind: 'remove', rule, text: 'X' })).toBe('Removed: X');
    expect(ruleChangeLine({ kind: 'invalid', line: 9, text: 'Delete it all', reason: 'no' })).toBe('Line 9: Delete it all');
    expect(rulesWaitingLine(0)).toBeNull();
    expect(rulesWaitingLine(1)).toBe('A rule change is waiting for you');
    expect(rulesWaitingLine(3)).toBe('3 rule changes are waiting for you');
  });
});
