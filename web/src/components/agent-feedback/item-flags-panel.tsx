'use client';

import { Check, Flag, X } from 'lucide-react';
import { useMemo } from 'react';
import { useAgentFeedback } from '@/components/launcher/use-agent-feedback';
import { FEEDBACK_KIND_LABELS } from '@/lib/agent-feedback';
import { relativeTime } from '@/lib/drops/client';
import { appButton } from '@/components/ui/app-page';

/**
 * On a recording's or capture's page: what agents flagged in it over MCP
 * (a typo, a passage that didn't make sense), with Dismiss and Mark fixed.
 * Quiet, and nothing at all when there is nothing. Agent text is shown only as text.
 */
export function ItemFlagsPanel({ itemId }: { itemId: string }) {
  const feedback = useAgentFeedback(true);
  const items = useMemo(
    () => feedback.items.filter((item) => item.targetType !== 'prompt' && item.targetId === itemId),
    [feedback.items, itemId],
  );
  // A failed Dismiss or Mark fixed puts the report back: say so where it can be seen, not inside the closed list.
  const error = feedback.error ? <p role="alert" className="text-xs text-ev-warn-ink">{feedback.error}</p> : null;
  if (!items.length) return error;
  return (
    <>
    {error}
    <details className="group rounded-[var(--ev-r-pop)] bg-ev-well px-3.5 py-2 text-sm text-ev-ink-2">
      <summary className="flex cursor-default list-none items-center gap-1.5 text-xs hover:text-ev-ink [&::-webkit-details-marker]:hidden">
        <Flag className="h-3 w-3" aria-hidden />
        {items.length === 1 ? 'Flagged by an agent' : `Flagged by agents ${items.length} times`}
      </summary>
      <ul className="mt-2 flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.id} className="border-l-2 border-ev-line-strong pl-3">
            <p className="text-xs text-ev-ink-3">
              <span className="font-semibold text-ev-ink-2">{FEEDBACK_KIND_LABELS[item.kind]}</span> · {item.source} · {relativeTime(item.createdAt)}
            </p>
            {item.excerpt ? <q className="mt-0.5 block italic text-ev-ink [overflow-wrap:anywhere]">{item.excerpt}</q> : null}
            <p className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{item.explanation}</p>
            {item.suggestedRewrite ? (
              <p className="mt-0.5 whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">Suggested: {item.suggestedRewrite}</p>
            ) : null}
            <div className="mt-1.5 flex gap-2">
              <button type="button" className={appButton('ghost', 'sm')} onClick={() => void feedback.dismiss([item.id])} aria-label={`Dismiss ${item.source}’s report`}>
                <X className="h-3.5 w-3.5" aria-hidden /> Dismiss
              </button>
              <button type="button" className={appButton('ghost', 'sm')} onClick={() => void feedback.markFixed([item.id])} aria-label={`Mark ${item.source}’s report fixed`}>
                <Check className="h-3.5 w-3.5" aria-hidden /> Mark fixed
              </button>
            </div>
          </li>
        ))}
      </ul>
    </details>
    </>
  );
}
