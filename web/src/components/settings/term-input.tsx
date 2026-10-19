'use client';

import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cleanList, PROJECT_LIMITS } from '@/lib/projects';
import { cn } from '@/lib/utils';
import { addTerms, keyDraft, typeDraft } from './term-list';

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
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);
  const update = (next: string[] | null) => {
    if (!next) return;
    latest.current = next;
    onChange(next);
  };
  const offered = suggestions.filter((term) => !value.some((existing) => existing.toLowerCase() === term.toLowerCase()));
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="flex min-h-9 flex-wrap items-center gap-1 rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-1.5 py-1 focus-within:border-ev-slate"
      >
        {value.map((term) => (
          <span key={term} className="inline-flex items-center gap-1 rounded bg-ev-well px-1.5 py-0.5 font-mono text-xs">
            {term}
            <button
              type="button"
              onClick={() => update(latest.current.filter((item) => item !== term))}
              aria-label={`Remove ${term}`}
              className="text-ev-ink-2 hover:text-ev-ink"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(event) => {
            const next = typeDraft(latest.current, event.target.value, max);
            update(next.list);
            setDraft(next.draft);
          }}
          onKeyDown={(event) => {
            const next = keyDraft(latest.current, draft, event.key, max);
            if (next.handled) event.preventDefault();
            update(next.list);
            setDraft(next.draft);
          }}
          onBlur={() => {
            const next = addTerms(latest.current, draft, max);
            if (!next) return;
            update(next);
            setDraft('');
          }}
          maxLength={PROJECT_LIMITS.term}
          aria-label={label}
          placeholder={value.length >= max ? '' : placeholder}
          disabled={value.length >= max}
          className="h-6 min-w-[8rem] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-ev-ink-2"
        />
      </div>
      {offered.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 text-xs text-ev-ink-2">
          <span>Suggested from recent recordings:</span>
          {offered.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => update(cleanList([...latest.current, term], max))}
              className={cn('inline-flex items-center gap-0.5 rounded border border-dashed border-ev-line px-1.5 py-0.5 font-mono hover:bg-[var(--ev-hover)] hover:text-ev-ink')}
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
