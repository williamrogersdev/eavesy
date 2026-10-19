'use client';

import { Download, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { appButton } from '@/components/ui/app-page';
import { useSignOut } from '@/lib/use-sign-out';
import { cn } from '@/lib/utils';

export function AccountData({ email }: { email?: string }) {
  const signOut = useSignOut();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expected = email ?? 'DELETE';
  const matches = typed.trim().toLowerCase() === expected.toLowerCase();

  const deleteAccount = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: typed.trim() }),
      });
      if (!res.ok) throw new Error('Could not delete your account. Nothing was removed; please try again.');
      await signOut({ redirectUrl: '/?account=deleted' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete your account.');
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm">Export everything</p>
          <p className="text-xs text-ev-ink-2">
            Transcripts, briefs, notes, dictations and templates as one zip. Audio and video download from
            each recording.
          </p>
        </div>
        <a
          href="/api/account/export"
          download
          className={appButton('secondary', 'sm')}
        >
          <Download className="h-3.5 w-3.5" /> Export
        </a>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm">Delete account</p>
          <p className="text-xs text-ev-ink-2">
            Permanently deletes your recordings, transcripts and settings from Eavesy and signs out your Mac.
            Files on your Mac stay where they are.
          </p>
        </div>
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className={cn(appButton('secondary', 'sm'), 'text-ev-warn-ink')}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        ) : null}
      </div>

      {confirming ? (
        <div className="flex flex-col gap-2 rounded-[var(--ev-r-pop)] border border-ev-warn-ink bg-ev-warn-soft p-3">
          <label htmlFor="confirm-delete" className="text-xs text-ev-ink">
            This can’t be undone. Type <span className="font-round font-semibold">{expected}</span> to confirm.
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="confirm-delete"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="h-8 min-w-0 flex-1 rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-2.5 text-sm outline-none focus:border-ev-warn-ink"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  setTyped('');
                  setError(null);
                }}
                className={appButton('ghost', 'sm')}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!matches || deleting}
                onClick={() => void deleteAccount()}
                className={appButton('danger', 'sm')}
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Delete forever
              </button>
            </div>
          </div>
          {error ? <p role="alert" className="text-xs text-ev-warn-ink">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
