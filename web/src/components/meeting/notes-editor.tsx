'use client';

import { Check } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Section } from './layout';

export function NotesEditor({ meetingId, initial }: { meetingId: string; initial: string }) {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const seeded = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!seeded.current && initial) {
      setValue(initial);
      seeded.current = true;
    }
  }, [initial]);

  const save = useCallback(
    async (md: string) => {
      setStatus('saving');
      try {
        const response = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ meetingId, contentMd: md }),
        });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        setStatus('saved');
        window.setTimeout(() => setStatus('idle'), 1500);
      } catch {
        setStatus('error');
      }
    },
    [meetingId],
  );

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    seeded.current = true;
    const v = e.target.value;
    setValue(v);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(v), 800);
  }

  return (
    <Section
      title="Your notes"
      action={
        status === 'saving' ? (
          <span className="text-xs text-ev-ink-3">Saving…</span>
        ) : status === 'saved' ? (
          <span className="inline-flex items-center gap-1 text-xs text-ev-leaf">
            <Check className="h-3 w-3" /> Saved
          </span>
        ) : status === 'error' ? (
          <button type="button" onClick={() => void save(value)} className="text-xs font-medium text-ev-warn-ink hover:underline">
            Not saved · Retry
          </button>
        ) : null
      }
    >
      <textarea
        value={value}
        onChange={onChange}
        onBlur={() => {
          if (timer.current) window.clearTimeout(timer.current);
          void save(value);
        }}
        rows={5}
        placeholder="Jot anything down. It's saved with this recording and included in Copy for AI and exports."
        className="w-full resize-y rounded-[var(--ev-r-ctl)] bg-ev-well p-3 text-sm leading-relaxed text-ev-ink outline-none placeholder:text-ev-ink-3 focus:bg-ev-paper focus:shadow-[var(--ev-focus)]"
      />
    </Section>
  );
}
