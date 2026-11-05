import { describe, expect, test } from 'bun:test';
import { cleanNotetakerName, effectiveMode, legacyRecordChoice, notetakerName, wantsNotetaker } from './capture-plan';

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

  test('the Notetaker is named after its owner unless they chose a name', () => {
    expect(notetakerName(null, 'William Rogers')).toBe("William Rogers' Notetaker");
    expect(notetakerName(null, ' Sam ')).toBe("Sam's Notetaker");
    expect(notetakerName(null, null)).toBe('Eavesy Notetaker');
    expect(notetakerName('  Will’s   notes ', 'William Rogers')).toBe('Will’s notes');
    expect(cleanNotetakerName('\u0007  ')).toBeNull();
    expect(cleanNotetakerName('x'.repeat(100))).toHaveLength(60);
  });
});
