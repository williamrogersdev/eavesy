'use client';

import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { cleanList, PROJECT_LIMITS } from '@/lib/projects';
import { cn } from '@/lib/utils';

/** A list of short terms: type and press Enter or comma to add, × to remove. */
export function TermInput({
  label,
  value,
  onChange,
  placeholder,
  max,
  suggestions = [],
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  max: number;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const terms = raw.split(',').map((term) => term.trim()).filter(Boolean);
    if (terms.length === 0) return;
    onChange(cleanList([...value, ...terms], max));
    setDraft('');
  };
  const offered = suggestions.filter((term) => !value.some((existing) => existing.toLowerCase() === term.toLowerCase()));
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-border bg-background px-1.5 py-1 focus-within:border-accent/60"
      >
        {value.map((term) => (
          <span key={term} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {term}
            <button
              type="button"
              onClick={() => onChange(value.filter((item) => item !== term))}
              aria-label={`Remove ${term}`}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(event) => {
            const next = event.target.value;
            if (next.endsWith(',')) add(next);
            else setDraft(next);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add(draft);
            } else if (event.key === 'Backspace' && !draft && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => add(draft)}
          maxLength={PROJECT_LIMITS.term}
          aria-label={label}
          placeholder={value.length >= max ? '' : placeholder}
          disabled={value.length >= max}
          className="h-6 min-w-[8rem] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground/70"
        />
      </div>
      {offered.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span>Suggested from recent recordings:</span>
          {offered.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => onChange(cleanList([...value, term], max))}
              className={cn('inline-flex items-center gap-0.5 rounded border border-dashed border-border px-1.5 py-0.5 font-mono hover:bg-muted hover:text-foreground')}
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
