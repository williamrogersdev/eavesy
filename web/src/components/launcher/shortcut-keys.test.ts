import { describe, expect, test } from 'bun:test';
import { MODIFIER_RULE, acceleratorFromEvent, conflictText, heldCaps, hotkeyErrorText, keyCaps, keysText } from './shortcut-keys';

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

  test('a key press becomes an accelerator; modifiers alone do not', () => {
    expect(acceleratorFromEvent(key('KeyK', { metaKey: true, shiftKey: true }))).toBe('Cmd+Shift+K');
    expect(acceleratorFromEvent(key('F5'))).toBe('F5');
    expect(acceleratorFromEvent(key('KeyK'))).toBe('K');
    expect(acceleratorFromEvent(key('MetaLeft', { metaKey: true }))).toBeNull();
    expect(heldCaps({ meta: true, ctrl: false, alt: true, shift: false })).toEqual(['⌘', '⌥']);
  });

  test('errors and conflicts read as one plain sentence', () => {
    expect(hotkeyErrorText({ kind: 'needsModifier' }, 'K')).toBe(MODIFIER_RULE);
    expect(hotkeyErrorText({ kind: 'taken', by: 'dictation' }, 'Cmd+K')).toBe('Already used for Talk.');
    expect(hotkeyErrorText({ kind: 'taken', by: 'other' }, 'Cmd+K')).toBe('Another app is using ⌘K. Pick another.');
    expect(conflictText({ kind: 'system', name: 'Spotlight' }, 'Cmd+Space')).toMatch(/^⌘Space is used by Spotlight\./);
    expect(conflictText({ kind: 'common', name: 'Copy' }, 'Cmd+C')).toMatch(/^⌘C is Copy in most apps\./);
  });
});
