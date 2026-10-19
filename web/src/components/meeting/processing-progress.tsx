'use client';

import { Check } from 'lucide-react';
import { Mascot } from '@/components/launcher/ui';

export function ProcessingProgress({
  hasTranscript,
  hasBrief,
}: {
  hasTranscript: boolean;
  hasBrief: boolean;
}) {
  const steps = [
    { label: 'Recording saved', done: true, active: false },
    { label: 'Creating transcript', done: hasTranscript, active: !hasTranscript },
    { label: 'Building your brief', done: hasBrief, active: hasTranscript && !hasBrief },
  ];
  return (
    <div role="status" aria-label="Recording processing progress" className="flex items-start gap-3 rounded-[var(--ev-r-panel)] bg-ev-well px-4 py-3">
      <Mascot size={36} state="thinking" />
      <div className="min-w-0 flex-1">
      <p className="font-round text-sm font-bold text-ev-ink">Your recording is safe. I&apos;m writing it down.</p>
      <ol className="mt-2 grid gap-1.5 sm:grid-cols-3">
        {steps.map((step) => (
          <li key={step.label} className={step.done || step.active ? 'flex items-center gap-2 text-xs text-ev-ink' : 'flex items-center gap-2 text-xs text-ev-ink-3'}>
            {step.done ? (
              <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-ev-leaf text-ev-paper"><Check className="h-2.5 w-2.5" strokeWidth={3} /></span>
            ) : step.active ? (
              <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-ev-slate-soft border-t-ev-slate" />
            ) : (
              <span className="h-4 w-4 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--ev-line-strong)]" />
            )}
            {step.label}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-ev-ink-2">You can leave this page. It keeps going without you.</p>
      </div>
    </div>
  );
}
