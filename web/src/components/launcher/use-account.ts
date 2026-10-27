import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelPairing, disconnectAccount, errMsg, getAccountInfo, hidePanel, pairDevice } from '@/lib/desktop/bridge';
import type { AccountState } from './settings-view';
import type { Flash, RunTask } from './types';

/**
 * The account this Mac is signed in to (undefined while it's being looked up),
 * with the one sign-in, cancel and sign-out the panel uses. Desktop only.
 */
export function useAccount({ flash, runTask, afterSignIn }: {
  flash: Flash;
  runTask: RunTask;
  /** Runs once a sign-in attempt ends, whatever its outcome. */
  afterSignIn?: () => Promise<void> | void;
}) {
  const [account, setAccount] = useState<AccountState>(undefined);
  const [connecting, setConnecting] = useState(false);
  const connectingRef = useRef(false);
  const after = useRef(afterSignIn);
  after.current = afterSignIn;

  const refresh = useCallback(async () => {
    setAccount(await getAccountInfo());
  }, []);

  useEffect(() => { runTask(refresh); }, [refresh, runTask]);

  const connect = useCallback(() => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    runTask(async () => {
      try {
        await hidePanel();
        await pairDevice();
        flash('Account connected');
      } catch (error) {
        const message = errMsg(error, 'Couldn’t connect your account');
        if (!/cancelled/i.test(message)) flash(message, 6000, 'warn');
      } finally {
        connectingRef.current = false;
        setConnecting(false);
        await refresh();
        await after.current?.();
      }
    }, 'Couldn’t connect your account');
  }, [flash, refresh, runTask]);

  const cancelConnect = useCallback(() => {
    runTask(cancelPairing, 'Couldn’t cancel sign-in');
  }, [runTask]);

  const disconnect = useCallback(() => {
    runTask(async () => {
      await disconnectAccount();
      await refresh();
      flash('Signed out on this Mac');
    }, 'Couldn’t sign out');
  }, [flash, refresh, runTask]);

  return { account, connecting, connect, cancelConnect, disconnect, refresh };
}
