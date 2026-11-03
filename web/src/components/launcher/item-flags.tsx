'use client';

import { Check, Flag, X } from 'lucide-react';
import { FEEDBACK_KIND_LABELS, type AgentFeedback } from '@/lib/agent-feedback';
import { relativeTime } from '@/lib/drops/client';
import { Button } from './ui';

/**
 * On a capture in the history: what agents flagged in it over MCP. One quiet
 * line until it's opened; agent text is only ever shown as text.
 */
export function ItemFlags({ items, onDismiss, onFixed }: {
  items: readonly AgentFeedback[];
  onDismiss: (ids: string[]) => void;
  onFixed: (ids: string[]) => void;
}) {
  if (!items.length) return null;
  return (
    <details className="ev-item-flags">
      <summary className="ev-sub">
        <Flag size={11} strokeWidth={1.75} aria-hidden />
        {items.length === 1 ? 'Flagged by an agent' : `Flagged by agents ${items.length} times`}
      </summary>
      {items.map((item) => (
        <div key={item.id} className="ev-item-flag">
          <span className="ev-sub ev-item-flag-text">
            <span className="ev-item-flag-kind">{FEEDBACK_KIND_LABELS[item.kind]}</span> · {item.source} · {relativeTime(item.createdAt)}
          </span>
          {item.excerpt && <q className="ev-body ev-item-flag-quote">{item.excerpt}</q>}
          <span className="ev-sub ev-item-flag-text">{item.explanation}</span>
          {item.suggestedRewrite && <span className="ev-sub ev-item-flag-text">Suggested: {item.suggestedRewrite}</span>}
          <span className="ev-item-flag-actions">
            <Button variant="ghost" size="sm" icon={X} onClick={() => onDismiss([item.id])} aria-label={`Dismiss ${item.source}’s report`}>Dismiss</Button>
            <Button variant="ghost" size="sm" icon={Check} onClick={() => onFixed([item.id])} aria-label={`Mark ${item.source}’s report fixed`}>Mark fixed</Button>
          </span>
        </div>
      ))}
    </details>
  );
}
