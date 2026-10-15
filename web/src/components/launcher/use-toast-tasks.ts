import { useCallback, useState } from 'react';
import { errMsg } from '@/lib/desktop/bridge';

export function useToastTasks() {
  const [toast, setToast] = useState<string | null>(null);

  const flash = useCallback((msg: string, ms = 1600) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), ms);
  }, []);

  const runTask = useCallback(
    (task: () => void | Promise<void>, fallback = 'That action could not be completed') => {
      void Promise.resolve()
        .then(task)
        .catch((error: unknown) => {
          flash(errMsg(error, fallback), 5000);
        });
    },
    [flash],
  );

  return { toast, flash, runTask };
}
