'use client';

import { ArrowLeft, Radio } from 'lucide-react';
import { useState } from 'react';

export function ContextView({
  onBack,
  onStart,
}: {
  onBack: () => void;
  onStart: (contextBlurb?: string) => void;
}) {
  const [context, setContext] = useState('');
  const start = () => onStart(context.trim() || undefined);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1 text-muted-foreground hover:bg-[var(--lr-hover)] hover:text-foreground"
          aria-label="Back"
          title="Back (esc)"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-sm font-semibold text-foreground">New meeting recording</h2>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center px-8 py-6">
        <label htmlFor="meeting-context" className="text-sm font-medium text-foreground">
          Help Eavesy understand the meeting
        </label>
        <p className="mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
          Optional: add participant names, the project, or the outcome you care about. This becomes
          private ground truth for the summary when speaker labels are unavailable.
        </p>
        <textarea
          id="meeting-context"
          value={context}
          onChange={(event) => setContext(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              start();
            }
          }}
          autoFocus
          rows={4}
          maxLength={1000}
          placeholder="Example: Weekly product review with Maya and Alex. Focus on launch blockers and owners."
          className="mt-4 resize-none rounded-lg border border-border bg-transparent p-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-[var(--lr-brand)]"
        />
        <div className="mt-4 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">⌘↵ to start · {context.length}/1000</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onStart()}
              className="rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-[var(--lr-hover)]"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={start}
              className="inline-flex items-center gap-2 rounded-md bg-[var(--lr-brand)] px-4 py-2 text-xs font-semibold text-white"
            >
              <Radio className="h-3.5 w-3.5" /> Start recording
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
