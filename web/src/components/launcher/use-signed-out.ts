import { useEffect, useState } from 'react';
import { getSyncStatus, onSyncStatus } from '@/lib/desktop/bridge';
import { type RunTask } from './types';

export function useSignedOut(desktop: boolean, runTask: RunTask) {
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    runTask(async () => {
      const stopListening = await onSyncStatus((status) => setSignedOut(status.signedOut));
      const initial = await getSyncStatus();
      if (!disposed && initial) setSignedOut(initial.signedOut);
      if (disposed) stopListening();
      else unlisten = stopListening;
    }, 'Couldn’t watch sync status');
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop, runTask]);

  return signedOut;
}
