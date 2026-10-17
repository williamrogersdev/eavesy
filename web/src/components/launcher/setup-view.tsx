'use client';

import { Check, Globe, Loader2 } from 'lucide-react';
import { type ReactNode } from 'react';
import { type Permissions, type PrivacyPane } from '@/lib/desktop/bridge';
import { PermissionRow } from '@/components/launcher/permission-row';
import { cn } from '@/lib/utils';
import type { SetupPermissionKind } from './use-setup-permissions';

export function SetupView({
  paired,
  connecting,
  permissions,
  checking,
  onConnect,
  onCancelConnect,
  onRequest,
  onOpenSettings,
  onFinish,
}: {
  paired: boolean;
  connecting: boolean;
  permissions: Permissions | null;
  checking: SetupPermissionKind | null;
  onConnect: () => void;
  onCancelConnect: () => void;
  onRequest: (kind: 'mic' | 'screen') => void;
  onOpenSettings: (pane: PrivacyPane) => void;
  onFinish: () => void;
}) {
  const micReady = permissions?.mic === true;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-4">
        <h2 className="text-[15px] font-semibold text-foreground">Set up Eavesy</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Two quick steps, then you&apos;re recording.</p>

        <SetupSection step={1} title="Sign in" complete={paired}>
          {paired ? (
            <p className="text-xs text-muted-foreground">Signed in. Transcripts and summaries sync to your account.</p>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Turns recordings into transcripts and summaries you can search anywhere.
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={onConnect}
                  disabled={connecting}
                  className="inline-flex h-8 items-center gap-2 rounded-lg bg-[var(--lr-brand)] px-3 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 active:brightness-95 disabled:opacity-70"
                >
                  {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
                  {connecting ? 'Finish in your browser…' : 'Sign in with browser'}
                </button>
                {connecting && (
                  <button type="button" onClick={onCancelConnect} className="h-8 rounded-lg px-2 text-xs text-muted-foreground hover:bg-[var(--lr-hover)] hover:text-foreground">
                    Cancel
                  </button>
                )}
              </div>
            </>
          )}
        </SetupSection>

        <SetupSection step={2} title="Allow the microphone" complete={micReady}>
          <div className="-mx-2 grid">
            <PermissionRow
              label="Microphone"
              hint="Needed for voice notes and dictation."
              settingsHint="Turn on Eavesy under Microphone in System Settings. This page updates on its own."
              granted={permissions?.mic}
              answered={permissions?.micAsked}
              checking={checking === 'mic'}
              onRequest={() => onRequest('mic')}
              onOpenSettings={() => onOpenSettings('microphone')}
            />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">Screen Recording and pasting into other apps can be turned on later in Settings.</p>
        </SetupSection>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2.5">
        <span className="min-w-0 text-[11px] leading-snug text-muted-foreground">
          Eavesy lives in your menu bar. Recordings stay in ~/Eavesy.
        </span>
        {paired && micReady ? (
          <span className="inline-flex h-8 shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-500">
            <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> All set
          </span>
        ) : (
          <button
            type="button"
            onClick={onFinish}
            disabled={!micReady}
            title={micReady ? 'Use Eavesy without an account. Recordings stay on this Mac.' : 'Allow the microphone first'}
            className="h-8 shrink-0 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-[var(--lr-hover)] hover:text-foreground disabled:opacity-40"
          >
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
}

function SetupSection({
  step,
  title,
  complete,
  children,
}: {
  step: number;
  title: string;
  complete: boolean;
  children: ReactNode;
}) {
  return (
    <section className="mt-4 flex gap-3">
      <span
        className={cn(
          'mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold',
          complete ? 'bg-emerald-500 text-white' : 'border border-border text-muted-foreground',
        )}
        aria-hidden="true"
      >
        {complete ? <Check className="h-3 w-3" strokeWidth={3} /> : step}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-medium leading-5 text-foreground">{title}</h3>
        <div className="mt-1">{children}</div>
      </div>
    </section>
  );
}
