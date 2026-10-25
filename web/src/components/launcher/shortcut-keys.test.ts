import { describe, expect, test } from 'bun:test';
import { prettyAccel } from '@/lib/launcher/accel';
import {
  MODIFIER_RULE,
  acceleratorFromEvent,
  conflictText,
  fnChordFromEvent,
  heldCaps,
  hotkeyErrorText,
  isFnChord,
  keyCaps,
  keysText,
  mayBeFnChord,
  savedConflictText,
} from './shortcut-keys';

const key = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
});

describe('shortcut keys', () => {
  test('caps spell fn, modifiers and unbound', () => {
    expect(keyCaps('Cmd+Shift+Space')).toEqual(['⌘', '⇧', 'Space']);
    expect(keyCaps('Fn')).toEqual(['fn']);
    expect(keyCaps('')).toEqual([]);
    expect(keysText('Alt+d')).toBe('⌥D');
  });

  test('fn held with a key reads as fn, then the rest', () => {
    expect(keyCaps('Fn+Space')).toEqual(['fn', 'Space']);
    expect(keyCaps('Fn+Shift+K')).toEqual(['fn', '⇧', 'K']);
    expect(keysText('Fn+Space')).toBe('fn Space');
    expect(keysText('Fn+Alt+Space')).toBe('fn ⌥Space');
    expect(keysText('Fn')).toBe('fn');
    expect(prettyAccel('Fn+Space')).toBe('fn Space');
    expect(prettyAccel('Fn')).toBe('fn');
    expect(isFnChord('Fn+Space')).toBe(true);
    expect(isFnChord('fn+k')).toBe(true);
    expect(isFnChord('Fn')).toBe(false);
    expect(isFnChord('Alt+Space')).toBe(false);
  });

  test('a key press becomes an accelerator; modifiers alone do not', () => {
    expect(acceleratorFromEvent(key('KeyK', { metaKey: true, shiftKey: true }))).toBe('Cmd+Shift+K');
    expect(acceleratorFromEvent(key('F5'))).toBe('F5');
    expect(acceleratorFromEvent(key('KeyK'))).toBe('K');
    expect(acceleratorFromEvent(key('MetaLeft', { metaKey: true }))).toBeNull();
    expect(heldCaps({ meta: true, ctrl: false, alt: true, shift: false })).toEqual(['⌘', '⌥']);
  });

  test('fn chords only on letters, digits and Space', () => {
    expect(fnChordFromEvent(key('Space'))).toBe('Fn+Space');
    expect(fnChordFromEvent(key('KeyK', { ctrlKey: true, shiftKey: true }))).toBe('Fn+Ctrl+Shift+K');
    expect(fnChordFromEvent(key('Digit7'))).toBe('Fn+7');
    // These carry fn on their own, or turn into other keys under it.
    for (const code of ['ArrowUp', 'F5', 'Enter', 'Backspace', 'Home', 'Tab']) {
      expect(fnChordFromEvent(key(code))).toBeNull();
      expect(mayBeFnChord(key(code))).toBe(false);
    }
    expect(mayBeFnChord(key('Space'))).toBe(true);
  });

  test('errors and conflicts read as one plain sentence', () => {
    expect(MODIFIER_RULE).toBe('Use ⌘, ⌃, ⌥ or fn with a key, or fn on its own.');
    expect(hotkeyErrorText({ kind: 'needsModifier' }, 'K')).toBe(MODIFIER_RULE);
    expect(hotkeyErrorText({ kind: 'taken', by: 'dictation' }, 'Cmd+K')).toBe('Already used for Talk.');
    expect(hotkeyErrorText({ kind: 'taken', by: 'other' }, 'Cmd+K')).toBe('Another app is using ⌘K. Pick another.');
    expect(hotkeyErrorText({ kind: 'accessibility' }, 'Fn+Space')).toBe('fn Space needs Accessibility for Eavesy.');
    expect(conflictText({ kind: 'system', name: 'Spotlight' }, 'Cmd+Space')).toMatch(/^⌘Space is used by Spotlight\./);
    expect(conflictText({ kind: 'common', name: 'Copy' }, 'Cmd+C')).toMatch(/^⌘C is Copy in most apps\./);
    expect(conflictText({ kind: 'app', name: 'Raycast' }, 'Alt+Space')).toBe('⌥Space is also Raycast’s shortcut. Only one of them will get it.');
    expect(conflictText({ kind: 'globe', name: 'Emoji & Symbols' }, 'Fn+E')).toBe('fn E opens Emoji & Symbols in macOS. Eavesy would take it over.');
    expect(savedConflictText({ kind: 'app', name: 'ChatGPT' }, 'Alt+Space')).toMatch(/^⌥Space is also ChatGPT’s shortcut, so it may not reach Eavesy\./);
  });
});
