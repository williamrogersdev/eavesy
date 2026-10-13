import { describe, expect, test } from 'bun:test';
import { BRIEF_FORMATS, briefFormatPrompt, isBriefFormatId } from './brief-formats';

describe('brief formats', () => {
  test('keeps format identifiers unique and recognizes only supported values', () => {
    const ids = BRIEF_FORMATS.map((format) => format.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isBriefFormatId(id)).toBe(true);
    expect(isBriefFormatId('sales')).toBe(false);
    expect(isBriefFormatId(null)).toBe(false);
  });

  test('uses the default prompt for standard and explicit guidance for specialized formats', () => {
    expect(briefFormatPrompt('standard')).toBeUndefined();
    for (const format of BRIEF_FORMATS.filter(({ id }) => id !== 'standard')) {
      expect(briefFormatPrompt(format.id)).toBe(format.prompt);
      expect(format.prompt.length).toBeGreaterThan(40);
    }
  });
});
