'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';

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
    <div role="status" aria-label="Recording processing progress" className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
      <p className="text-sm font-medium">Your recording is safe. Eavesy is finishing the useful part.</p>
      <ol className="mt-2 grid gap-1.5 sm:grid-cols-3">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-2 text-xs text-muted-foreground">
            {step.done ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-accent" />
            ) : step.active ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
            ) : (
              <span className="h-4 w-4 shrink-0 rounded-full border border-border" />
            )}
            {step.label}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-muted-foreground">You can leave this page; processing continues automatically.</p>
    </div>
  );
}
