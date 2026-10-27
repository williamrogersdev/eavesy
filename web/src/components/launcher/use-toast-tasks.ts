import { useCallback, useState } from 'react';
import { errMsg } from '@/lib/desktop/bridge';

export type ToastTone = 'info' | 'warn';
export interface Toast { message: string; tone: ToastTone }

export function useToastTasks() {
  const [toast, setToast] = useState<Toast | null>(null);

  const flash = useCallback((message: string, ms = 1600, tone: ToastTone = 'info') => {
    const next = { message, tone };
    setToast(next);
    window.setTimeout(() => setToast((t) => (t === next ? null : t)), ms);
  }, []);

  const runTask = useCallback(
    (task: () => void | Promise<void>, fallback = 'That didn’t work') => {
      void Promise.resolve()
        .then(task)
        .catch((error: unknown) => {
          flash(errMsg(error, fallback), 5000, 'warn');
        });
    },
    [flash],
  );

  return { toast, flash, runTask };
}
