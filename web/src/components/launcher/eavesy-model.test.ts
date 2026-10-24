import { describe, expect, test } from 'bun:test';
import type { AssistantCard } from '@/lib/desktop/bridge';
import { acceptLabel, modeIsLoud, modeLabel, secondsLeft, toolLabel } from './eavesy-model';

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
