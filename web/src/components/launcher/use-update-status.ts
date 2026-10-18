'use client';

import { useEffect, useState } from 'react';
import { getAppInfo, onUpdateStatus, type UpdateStatus } from '@/lib/desktop/bridge';

/**
 * The latest update check, kept current by the background check's
 * `launcher:update-status` events. Null outside the desktop app.
 */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let alive = true;
    let fromEvent = false;
    let stop: (() => void) | undefined;
    // An event is always newer than the snapshot, so the snapshot never overwrites one.
    void getAppInfo()
      .then((info) => { if (alive && info && !fromEvent) setStatus(info.update); })
      .catch(() => {});
    void onUpdateStatus((next) => { fromEvent = true; if (alive) setStatus(next); })
      .then((unlisten) => { if (alive) stop = unlisten; else unlisten(); })
      .catch(() => {});
    return () => { alive = false; stop?.(); };
  }, []);
  return status;
}
