'use client';

import type { Toast } from './use-toast-tasks';
import { Mascot } from './ui';

/** The quiet pill above the composer: confirmations, and errors with nothing to click. */
export function LauncherToast({ toast }: { toast: Toast | null }) {
  if (!toast) return null;
  return (
    <div className="ev-toast" role="status" data-tone={toast.tone}>
      <Mascot size={16} state={toast.tone === 'warn' ? 'confused' : 'happy'} />
      {toast.message}
    </div>
  );
}
