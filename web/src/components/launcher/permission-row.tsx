'use client';

import { Check, Loader2, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

export function PermissionRow({
  label,
  optional,
  hint,
  settingsHint,
  granted,
  answered,
  checking,
  onRequest,
  onOpenSettings,
  onRelaunch,
}: {
  label: string;
  optional?: boolean;
  hint: string;
  settingsHint: string;
  granted: boolean | undefined;
  answered?: boolean;
  checking: boolean;
  onRequest?: () => void;
  onOpenSettings: () => void;
  onRelaunch?: () => void;
}) {
  const [asked, setAsked] = useState(false);
  const canAsk = !!onRequest && !asked && !answered;
  const inSettings = !granted && !canAsk;
  const act = () => {
    setAsked(true);
    if (canAsk) onRequest?.();
    else onOpenSettings();
  };
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-foreground">
          {label}
          {optional && <span className="ml-1.5 font-normal text-muted-foreground">Optional</span>}
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {inSettings && (asked || answered) ? settingsHint : hint}
        </p>
      </div>
      {granted ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-500">
          <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Allowed
        </span>
      ) : (
        <div className="flex shrink-0 items-center gap-1.5">
          {asked && onRelaunch && (
            <button
              type="button"
              onClick={onRelaunch}
              title="macOS applies Screen Recording after Eavesy restarts"
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition hover:bg-[var(--lr-hover)] hover:text-foreground"
            >
              <RotateCw className="h-3 w-3" /> Reopen Eavesy
            </button>
          )}
          <button
            type="button"
            onClick={act}
            disabled={checking || granted === undefined}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition disabled:opacity-50',
              optional
                ? 'border border-border text-foreground hover:bg-[var(--lr-hover)]'
                : 'bg-foreground text-background hover:opacity-90',
            )}
          >
            {checking && <Loader2 className="h-3 w-3 animate-spin" />}
            {canAsk ? 'Allow' : 'Open Settings'}
          </button>
        </div>
      )}
    </div>
  );
}
