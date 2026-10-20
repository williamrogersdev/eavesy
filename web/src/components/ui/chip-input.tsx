'use client';

import { Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { addChips, hasChipSeparator, removeChip, splitChips } from './chips';

/**
 * Words and short phrases as chips. Enter, comma or Tab adds what you typed,
 * Backspace on an empty field removes the last chip, and a pasted list is
 * split on commas and line breaks.
 */
export function ChipInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  max,
  maxLength = 60,
  hint,
  showCount = true,
  suggestions = [],
  suggestionsLabel = 'Suggestions:',
  className,
}: {
  id?: string;
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  max: number;
  maxLength?: number;
  hint?: string;
  showCount?: boolean;
  suggestions?: string[];
  suggestionsLabel?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const full = value.length >= max;

  const commit = (text: string) => {
    const parts = splitChips(text);
    if (parts.length > 0 && full) return;
    setDraft('');
    if (parts.length === 0) return;
    const next = addChips(value, parts, { max, maxLength });
    if (next.length !== value.length) onChange(next);
  };

  const taken = new Set(value.map((chip) => chip.toLowerCase()));
  const offered = full ? [] : suggestions.filter((term) => !taken.has(term.toLowerCase()));

  return (
    <div className={cn('flex w-full flex-col gap-1.5', className)}>
      <div
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            input.current?.focus();
          }
        }}
        className="flex min-h-10 w-full cursor-text flex-wrap items-center gap-1.5 rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-2 py-1.5 transition-colors focus-within:border-ev-coat"
      >
        {value.map((chip) => (
          <span
            key={chip}
            className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-ev-well pl-2.5 pr-1 text-[13px] text-ev-ink"
          >
            <span className="truncate">{chip}</span>
            <button
              type="button"
              onClick={() => {
                onChange(removeChip(value, chip));
                input.current?.focus();
              }}
              aria-label={`Remove ${chip}`}
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-ev-ink-3 transition hover:bg-[var(--ev-hover)] hover:text-ev-ink"
            >
              <X className="h-3 w-3" strokeWidth={2.25} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          id={id}
          value={draft}
          aria-label={label}
          maxLength={maxLength}
          placeholder={full ? 'Limit reached' : value.length === 0 ? placeholder : 'Add another…'}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            const text = event.target.value;
            if (hasChipSeparator(text)) commit(text);
            else setDraft(text);
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            if (!hasChipSeparator(text)) return;
            event.preventDefault();
            commit(`${draft},${text}`);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              commit(draft);
            } else if (event.key === 'Tab' && draft.trim()) {
              event.preventDefault();
              commit(draft);
            } else if (event.key === 'Backspace' && !draft && value.length > 0) {
              event.preventDefault();
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => commit(draft)}
          style={{ outline: 'none' }}
          className="h-7 min-w-[9rem] flex-1 bg-transparent px-1 text-sm text-ev-ink outline-none placeholder:text-ev-ink-3"
        />
      </div>
      {hint || showCount ? (
        <div className="flex items-start justify-between gap-3 text-[11.5px] text-ev-ink-2">
          <span>{hint}</span>
          {showCount ? (
            <span className={cn('shrink-0 tabular-nums', full && 'text-ev-warn-ink')} aria-live="polite">
              {value.length}/{max}
            </span>
          ) : null}
        </div>
      ) : null}
      {offered.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ev-ink-2">
          <span>{suggestionsLabel}</span>
          {offered.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => onChange(addChips(value, [term], { max, maxLength }))}
              className="inline-flex h-6 items-center gap-0.5 rounded-full border border-dashed border-ev-line-strong px-2 text-[12px] text-ev-ink-2 transition hover:bg-[var(--ev-hover)] hover:text-ev-ink"
            >
              <Plus className="h-3 w-3" />
              {term}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
