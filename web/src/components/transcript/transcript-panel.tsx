'use client';

import { Check, Copy, FileText, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

export type TranscriptStatus = 'none' | 'pending' | 'processing' | 'complete' | 'failed';

export function TranscriptPanel({
  title = 'Transcript',
  status,
  transcript,
  error,
}: {
  title?: string;
  status: TranscriptStatus;
  transcript?: string | null;
  error?: string | null;
}) {
  const hasText = status === 'complete' && !!transcript?.trim();
  const markdown = hasText ? `# ${title}\n\n${transcript!.trim()}\n` : '';

  return (
    <section className="rounded-[var(--ev-r-pop)] border border-ev-line bg-ev-paper">
      <header className="flex items-center justify-between gap-2 border-b border-ev-line px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FileText className="h-4 w-4 text-ev-ink-2" />
          {title}
        </div>
        {hasText ? (
          <div className="flex items-center gap-1.5">
            <CopyButton getText={() => transcript!.trim()} label="Copy" />
            <CopyButton getText={() => markdown} label="Markdown" />
          </div>
        ) : null}
      </header>

      <div className="px-4 py-3 text-sm">
        {status === 'processing' || status === 'pending' ? (
          <p className="flex items-center gap-2 text-ev-ink-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Transcribing…
          </p>
        ) : status === 'failed' ? (
          <p className="text-ev-ink-2">
            Transcription failed{error ? `: ${error}` : ''}.
          </p>
        ) : status === 'none' || !transcript?.trim() ? (
          <p className="text-ev-ink-2">No transcript available.</p>
        ) : (
          <p className="whitespace-pre-wrap leading-relaxed text-ev-ink">{transcript.trim()}</p>
        )}
      </div>
    </section>
  );
}

export function CopyButton({
  getText,
  label = 'Copy',
  className,
}: {
  getText: () => string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(getText());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  return (
    <button
      type="button"
      onClick={() => {
        void handleCopy();
      }}
      className={cn(
        'flex items-center gap-1.5 rounded-[var(--ev-r-ctl)] border border-ev-line px-2 py-1 text-xs font-medium text-ev-ink-2 hover:bg-[var(--ev-hover)]',
        className,
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : label}
    </button>
  );
}
