'use client';

import { cn } from '@/lib/utils';
import { type Action } from './types';

export function ActionsMenu({
  actions,
  selected,
  query,
  inputRef,
  onQuery,
  onHover,
  onRun,
  onKeyDown,
}: {
  actions: Action[];
  selected: number;
  query: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onQuery: (v: string) => void;
  onHover: (i: number) => void;
  onRun: (a: Action) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={() => onQuery('')} />
      <div className="launcher-panel absolute right-3 top-14 z-30 w-72 overflow-hidden rounded-xl border border-border">
        <div className="launcher-actions max-h-72 overflow-y-auto p-1.5">
          {actions.length === 0 && (
            <p className="px-2 py-3 text-[13px] text-muted-foreground">
              No actions.
            </p>
          )}
          {actions.map((a, i) => (
            <button
              key={a.id}
              type="button"
              onMouseMove={() => onHover(i)}
              onClick={() => onRun(a)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px]',
                i === selected ? 'bg-[var(--lr-selected)]' : '',
                a.destructive ? 'text-danger' : 'text-foreground',
              )}
            >
              <span className={a.destructive ? 'text-danger' : 'text-muted-foreground'}>
                {a.icon}
              </span>
              <span className="flex-1 truncate">{a.label}</span>
              {a.hint && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {a.hint}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="border-t border-border px-2 py-1.5">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search actions…"
            spellCheck={false}
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
    </>
  );
}
