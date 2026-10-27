'use client';

import { Check, Clipboard, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { copyText } from '@/lib/desktop/bridge';
import { cn } from '@/lib/utils';
import { type MeetingData } from './types';
import { buildContextMd } from './format';

export function CopyContextButton({ data }: { data: MeetingData }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const md = buildContextMd(data);
  const hasUsefulContext = Boolean(
    data.meeting.summaryOverrideMd?.trim() ||
      data.meeting.transcriptOverrideMd?.trim() ||
      data.summary ||
      data.segments.length,
  );
  const processing = ['recording', 'queued', 'uploading', 'processing'].includes(
    data.meeting.status,
  );
  const ready = !processing && hasUsefulContext;
  const unavailableLabel = processing ? 'Brief processing…' : 'No brief to copy';
  return (
    <button
      type="button"
      disabled={!ready}
      onClick={() => {
        setFailed(false);
        void copyText(md)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
            void fetch(`/api/meetings/${data.meeting.id}/copy`, { method: 'POST' }).catch(
              () => undefined,
            );
          })
          .catch(() => setFailed(true));
      }}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 font-round text-[13px] font-bold transition',
        failed
          ? 'bg-ev-warn-soft text-ev-warn-ink'
          : 'bg-ev-coat text-ev-on-coat shadow-[var(--ev-e-2)] hover:bg-ev-coat-hover disabled:cursor-not-allowed disabled:bg-ev-well disabled:text-ev-ink-3 disabled:shadow-none',
      )}
      title={ready
        ? 'Copy summary, notes & transcript as Markdown — paste into Claude or any AI'
        : processing
          ? 'Your AI-ready brief will be copyable when processing finishes'
          : 'No transcript or brief is available to copy'}
    >
      {!ready && processing ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : copied ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Clipboard className="h-3.5 w-3.5" />
      )}
      {!ready
        ? unavailableLabel
        : failed
          ? 'Copy failed'
          : copied
            ? 'Copied'
            : 'Copy for AI'}
    </button>
  );
}

export function CopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        setFailed(false);
        void copyText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => setFailed(true));
      }}
      className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 font-round text-xs font-semibold text-ev-ink-2 hover:bg-[var(--ev-hover)] hover:text-ev-ink"
    >
      {copied ? <Check className="h-3 w-3" /> : <Clipboard className="h-3 w-3" />}
      {failed ? 'Copy failed' : copied ? 'Copied' : label}
    </button>
  );
}
