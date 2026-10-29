import { describe, expect, test } from 'bun:test';
import { settingsMatch } from './settings-search';

const connections = { id: 'connections' as const, label: 'Connections', hint: 'Claude Code, Claude, ChatGPT and other AI tools.' };
const shortcuts = { id: 'shortcuts' as const, label: 'Shortcuts', hint: 'Make Eavesy work the way you do.' };

describe('settingsMatch', () => {
  test('finds a page by a word it holds but doesn’t show in its name', () => {
    expect(settingsMatch('mcp', connections)).toBe(true);
    expect(settingsMatch('hotkey', shortcuts)).toBe(true);
    expect(settingsMatch('mcp', shortcuts)).toBe(false);
  });

  test('agent notifications have their own page, not Connections', () => {
    const agents = { id: 'agents' as const, label: 'Agent notifications', hint: 'What your Claude Code sessions and other agents tell you.' };
    expect(settingsMatch('notifications', agents)).toBe(true);
    expect(settingsMatch('session finishes', agents)).toBe(true);
    expect(settingsMatch('send_to_human', agents)).toBe(true);
    expect(settingsMatch('notifications', connections)).toBe(false);
    expect(settingsMatch('session finishes', connections)).toBe(false);
  });

  test('matches the start of a word, not the middle', () => {
    expect(settingsMatch('hot', shortcuts)).toBe(true);
    expect(settingsMatch('otkey', shortcuts)).toBe(false);
  });

  test('ignores case and needs every word', () => {
    expect(settingsMatch('Claude CODE', connections)).toBe(true);
    expect(settingsMatch('claude hotkey', connections)).toBe(false);
  });
});
