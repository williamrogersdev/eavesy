'use client';

import { Check } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** A short confirmation that fades on its own, so saving never moves the page. */
export function useSaveToast(duration = 1800) {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((next = 'Saved') => {
    if (timer.current) clearTimeout(timer.current);
    setText(next);
    timer.current = setTimeout(() => setText(null), duration);
  }, [duration]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return { text, show };
}

export function SaveToast({ text }: { text: string | null }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 transition duration-200',
        text ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
      )}
    >
      {text ? (
        <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ev-raised px-3.5 font-round text-[13px] font-semibold text-ev-ink shadow-[0_0_0_0.5px_var(--ev-line-strong),var(--ev-e-2)]">
          <Check className="h-3.5 w-3.5 text-ev-leaf" strokeWidth={2.25} />
          {text}
        </span>
      ) : null}
    </div>
  );
}
