import { describe, expect, test } from 'bun:test';
import { narrowByKind } from './kind-filter';

const meeting = (id: string) => ({ kind: 'meeting' as const, id });
const dictation = (id: string) => ({ kind: 'dictation' as const, id });

describe('narrowByKind', () => {
  test('mixed results narrow to the chosen kind and count each kind', () => {
    const items = [meeting('a'), dictation('b'), meeting('c')];
    const { counts, mixed, shown } = narrowByKind(items, 'meeting');
    expect(mixed).toBe(true);
    expect(counts).toEqual({ all: 3, meeting: 2, dictation: 1 });
    expect(shown.map((i) => i.id)).toEqual(['a', 'c']);
  });

  test('all keeps every result in order', () => {
    const items = [dictation('a'), meeting('b')];
    expect(narrowByKind(items, 'all').shown).toEqual(items);
  });

  test('a choice left over from another search never hides results of one kind', () => {
    const items = [dictation('a'), dictation('b')];
    const { mixed, shown } = narrowByKind(items, 'meeting');
    expect(mixed).toBe(false);
    expect(shown).toEqual(items);
  });
});
