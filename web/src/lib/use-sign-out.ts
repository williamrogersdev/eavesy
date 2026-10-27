import { useClerk } from '@clerk/tanstack-react-start';
import { forgetAppGatePass } from '@/lib/app-gate';

type SignOut = (options: { redirectUrl: string }) => Promise<void>;

function useClerkSignOut(): SignOut {
  const { signOut } = useClerk();
  return (options) => {
    forgetAppGatePass();
    return signOut(options);
  };
}

function useRedirectSignOut(): SignOut {
  return ({ redirectUrl }) => {
    forgetAppGatePass();
    window.location.assign(redirectUrl);
    return Promise.resolve();
  };
}

export const useSignOut: () => SignOut = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
  ? useClerkSignOut
  : useRedirectSignOut;
