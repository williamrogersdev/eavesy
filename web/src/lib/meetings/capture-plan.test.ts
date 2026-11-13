import { describe, expect, test } from 'bun:test';
import { cleanNotetakerName, effectiveMode, legacyRecordChoice, notetakerName, notetakerToggle, wantsNotetaker } from './capture-plan';

describe('capture plan', () => {
  test('a meeting’s own choice wins over the account default', () => {
    expect(effectiveMode(null, 'notetaker')).toBe('notetaker');
    expect(effectiveMode('skip', 'notetaker')).toBe('skip');
    expect(wantsNotetaker('both')).toBe(true);
    expect(wantsNotetaker('mac')).toBe(false);
  });

  test('older Mac apps stay out of Notetaker meetings and follow their own setting otherwise', () => {
    expect(legacyRecordChoice(null, 'mac')).toBeNull();
    expect(legacyRecordChoice(null, 'notetaker')).toBe('skip');
    expect(legacyRecordChoice(null, 'both')).toBeNull();
    expect(legacyRecordChoice('mac', 'notetaker')).toBe('record');
    expect(legacyRecordChoice('both', 'mac')).toBe('record');
    expect(legacyRecordChoice('skip', 'mac')).toBe('skip');
  });

  test('a Notetaker plan on a call the bot can’t join (Zoom, no link) falls to the Mac', () => {
    expect(effectiveMode(null, 'notetaker', false)).toBe('mac');
    expect(effectiveMode('both', 'mac', false)).toBe('mac');
    expect(effectiveMode('skip', 'notetaker', false)).toBe('skip');
    expect(legacyRecordChoice(null, 'notetaker', false)).toBe('record');
    expect(legacyRecordChoice(null, 'both', false)).toBeNull();
  });

  test('the Notetaker is named after its owner unless they chose a name', () => {
    expect(notetakerName(null, 'William Rogers')).toBe("William Rogers' Notetaker");
    expect(notetakerName(null, ' Sam ')).toBe("Sam's Notetaker");
    expect(notetakerName(null, null)).toBe('Eavesy Notetaker');
    expect(notetakerName('  Will’s   notes ', 'William Rogers')).toBe('Will’s notes');
    expect(cleanNotetakerName('\u0007  ')).toBeNull();
    expect(cleanNotetakerName('x'.repeat(100))).toHaveLength(60);
  });
});

describe('notetakerToggle', () => {
  test('sends the Notetaker to a meeting it was not going to', () => {
    expect(notetakerToggle('mac', 'mac')).toBe('notetaker');
    expect(notetakerToggle('skip', 'both')).toBe('notetaker');
  });
  test('taking it back returns to a default that does not send it', () => {
    expect(notetakerToggle('notetaker', 'mac')).toBeNull();
    expect(notetakerToggle('both', 'mac')).toBeNull();
  });
  test('taking it back from a Notetaker default leaves the Mac recording', () => {
    expect(notetakerToggle('notetaker', 'notetaker')).toBe('mac');
    expect(notetakerToggle('both', 'both')).toBe('mac');
  });
});
