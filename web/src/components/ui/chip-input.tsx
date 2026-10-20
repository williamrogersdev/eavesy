'use client';

import { Check, Copy, Plus, Search, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { addChips } from './chips';
import { useChipField } from './use-chip-field';

function Chip({ chip, onRemove }: { chip: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-ev-well pl-2.5 pr-1 text-[13px] text-ev-ink">
      <span className="truncate">{chip}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${chip}`}
        className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-ev-ink-3 transition hover:bg-[var(--ev-hover)] hover:text-ev-ink"
      >
        <X className="h-3 w-3" strokeWidth={2.25} />
      </button>
    </span>
  );
}

const footButton = 'inline-flex items-center gap-1 rounded px-1 text-ev-ink-2 transition hover:text-ev-ink';

/**
 * Words and short phrases as chips. Enter, comma or Tab adds what you typed,
 * Backspace on an empty field removes the last chip, and a pasted list is
 * split on commas and line breaks. A long list scrolls, newest first, and
 * the box doubles as a search over it.
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
  const field = useChipField({ value, onChange, max, maxLength });
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const taken = new Set(value.map((chip) => chip.toLowerCase()));
  const offered = field.full ? [] : suggestions.filter((term) => !taken.has(term.toLowerCase()));
  const remove = (chip: string) => {
    field.remove(chip);
    input.current?.focus();
  };

  const box = (
    <input
      ref={input}
      id={id}
      value={field.draft}
      aria-label={label}
      maxLength={maxLength}
      placeholder={
        field.long
          ? field.full ? `Search ${value.length} words` : `Add a word, or search ${value.length}`
          : field.full ? 'Limit reached' : value.length === 0 ? placeholder : 'Add another…'
      }
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => field.onInputChange(event.target.value)}
      onPaste={field.onPaste}
      onKeyDown={field.onKeyDown}
      onBlur={field.onBlur}
      style={{ outline: 'none' }}
      className="h-7 min-w-[9rem] flex-1 bg-transparent px-1 text-sm text-ev-ink outline-none placeholder:text-ev-ink-3"
    />
  );

  const footer = (hint || showCount || field.long || field.duplicate) ? (
    <div className="flex items-start justify-between gap-3 text-[11.5px] text-ev-ink-2">
      <span>{field.duplicate && !field.long ? `“${field.draft.trim()}” is already in the list.` : hint}</span>
      <span className="flex shrink-0 items-center gap-2.5">
        {field.long ? (
          <>
            <button
              type="button"
              className={footButton}
              onClick={() => {
                void navigator.clipboard?.writeText(value.join('\n')).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }, () => undefined);
              }}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy all'}
            </button>
            {confirmClear ? (
              <span className="inline-flex items-center gap-1.5">
                <button type="button" className={cn(footButton, 'text-ev-warn-ink')} onClick={() => { field.clear(); setConfirmClear(false); }}>
                  Remove all {value.length}
                </button>
                <button type="button" className={footButton} onClick={() => setConfirmClear(false)}>Keep</button>
              </span>
            ) : (
              <button type="button" className={footButton} onClick={() => setConfirmClear(true)}>Clear</button>
            )}
          </>
        ) : null}
        {showCount ? (
          <span className={cn('tabular-nums', field.full && 'text-ev-warn-ink')} aria-live="polite">
            {value.length}/{max}
          </span>
        ) : null}
      </span>
    </div>
  ) : null;

  return (
    <div className={cn('flex w-full flex-col gap-1.5', className)}>
      {field.long ? (
        <div className="flex w-full flex-col overflow-hidden rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper transition-colors focus-within:border-ev-coat">
          <div className="flex items-center gap-1.5 border-b border-ev-line px-2 py-1.5">
            {field.full ? <Search className="h-3.5 w-3.5 shrink-0 text-ev-ink-3" /> : <Plus className="h-3.5 w-3.5 shrink-0 text-ev-ink-3" />}
            {box}
            {field.draft ? (
              <span className="shrink-0 text-[11.5px] text-ev-ink-3">
                {field.duplicate ? 'Already added' : field.full ? `${field.shown.length} found` : `${field.shown.length} found · Enter adds it`}
              </span>
            ) : null}
          </div>
          <div className="flex max-h-52 flex-wrap content-start gap-1.5 overflow-y-auto px-2 py-2">
            {field.shown.length ? (
              field.shown.map((chip) => <Chip key={chip} chip={chip} onRemove={() => remove(chip)} />)
            ) : (
              <span className="px-1 py-1 text-[12.5px] text-ev-ink-3">No word matches “{field.draft.trim()}”.</span>
            )}
          </div>
        </div>
      ) : (
        <div
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              event.preventDefault();
              input.current?.focus();
            }
          }}
          className="flex min-h-10 w-full cursor-text flex-wrap items-center gap-1.5 rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-2 py-1.5 transition-colors focus-within:border-ev-coat"
        >
          {field.shown.map((chip) => <Chip key={chip} chip={chip} onRemove={() => remove(chip)} />)}
          {box}
        </div>
      )}
      {footer}
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
