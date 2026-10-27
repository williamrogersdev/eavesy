import { describe, expect, test } from 'bun:test';
import { prettyAccel } from './accel';

describe('prettyAccel', () => {
  test('maps modifier aliases to their symbols', () => {
    for (const cmd of ['cmd', 'command', 'super', 'meta']) expect(prettyAccel(`${cmd}+k`)).toBe('⌘K');
    expect(prettyAccel('shift+k')).toBe('⇧K');
    for (const alt of ['alt', 'option']) expect(prettyAccel(`${alt}+k`)).toBe('⌥K');
    for (const ctrl of ['ctrl', 'control']) expect(prettyAccel(`${ctrl}+k`)).toBe('⌃K');
    expect(prettyAccel('cmd+shift+k')).toBe('⌘⇧K');
  });

  test('uppercases a single-letter key and keeps longer key names as typed', () => {
    expect(prettyAccel('k')).toBe('K');
    expect(prettyAccel('cmd+space')).toBe('⌘space');
    expect(prettyAccel('alt+Space')).toBe('⌥Space');
    expect(prettyAccel('cmd+1')).toBe('⌘1');
  });

  test('trims whitespace and matches modifiers case-insensitively', () => {
    expect(prettyAccel(' CMD + Shift +d ')).toBe('⌘⇧D');
    expect(prettyAccel('Command+OPTION+Control+x')).toBe('⌘⌥⌃X');
  });

  test('keeps fn as a word, separated from the rest', () => {
    expect(prettyAccel('fn')).toBe('fn');
    expect(prettyAccel('Fn+Space')).toBe('fn Space');
    expect(prettyAccel('fn+shift+a')).toBe('fn ⇧A');
  });
});
