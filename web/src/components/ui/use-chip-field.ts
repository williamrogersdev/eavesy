'use client';

import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { addChips, hasChipSeparator, removeChip, splitChips } from './chips';

/** Past this many chips the field turns into a searchable, scrolling list. */
export const LONG_CHIP_LIST = 24;

/** The chips to show: newest first and narrowed to `query` once the list is long. */
export function visibleChips(value: readonly string[], query: string, long: boolean): string[] {
  if (!long) return [...value];
  const needle = query.replace(/\s+/g, ' ').trim().toLowerCase();
  const newestFirst = [...value].reverse();
  return needle ? newestFirst.filter((chip) => chip.toLowerCase().includes(needle)) : newestFirst;
}

/**
 * Typing, pasting and keys for a chip field. Enter, comma or Tab adds what is
 * typed, Backspace on an empty short list takes the last chip off, and a
 * pasted list becomes one chip each. On a long list the same text also
 * filters the chips, so one box both adds and finds.
 */
export function useChipField({ value, onChange, max, maxLength }: {
  value: string[];
  onChange: (next: string[]) => void;
  max: number;
  maxLength: number;
}) {
  const [draft, setDraft] = useState('');
  const full = value.length >= max;
  const long = value.length > LONG_CHIP_LIST;
  const typed = draft.replace(/\s+/g, ' ').trim().toLowerCase();
  const duplicate = !!typed && value.some((chip) => chip.toLowerCase() === typed);

  const commit = (text: string) => {
    const parts = splitChips(text);
    if (parts.length > 0 && full) return;
    setDraft('');
    if (parts.length === 0) return;
    const next = addChips(value, parts, { max, maxLength });
    if (next.length !== value.length) onChange(next);
  };

  return {
    draft,
    full,
    long,
    duplicate,
    shown: visibleChips(value, draft, long),
    commit,
    remove: (chip: string) => onChange(removeChip(value, chip)),
    clear: () => onChange([]),
    onInputChange: (text: string) => {
      if (hasChipSeparator(text)) commit(text);
      else setDraft(text);
    },
    onPaste: (event: ClipboardEvent<HTMLInputElement>) => {
      const text = event.clipboardData.getData('text');
      if (!hasChipSeparator(text)) return;
      event.preventDefault();
      commit(`${draft},${text}`);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        commit(draft);
      } else if (event.key === 'Tab' && draft.trim()) {
        event.preventDefault();
        commit(draft);
      } else if (event.key === 'Escape' && draft) {
        event.preventDefault();
        event.stopPropagation();
        setDraft('');
      } else if (event.key === 'Backspace' && !draft && value.length > 0 && !long) {
        event.preventDefault();
        onChange(value.slice(0, -1));
      }
    },
    onBlur: () => { if (!long) commit(draft); },
  };
}
