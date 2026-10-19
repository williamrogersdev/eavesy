import { appReturnPath } from '@/lib/auth-return';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { SignIn, useAuth } from '@clerk/tanstack-react-start';
import { ArrowRight, Loader2 } from 'lucide-react';
import { AuthFrame, AuthUnavailable } from '@/components/auth/auth-frame';
import { BrandMark } from '@/components/brand-mark';

export const Route = createFileRoute('/sign-in/$')({
  head: () => ({
    meta: [
      { title: 'Sign in' },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  component: SignInPage,
});

function useRedirectUrl(): string {
  const [url] = useState(() => {
    if (typeof window === 'undefined') return '/app';
    const raw = new URLSearchParams(window.location.search).get('redirect_url');
    return appReturnPath(raw);
  });
  return url;
}

function SignInPage() {
  if (!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) {
    return <AuthUnavailable action="sign in" />;
  }
  return <ConfiguredSignInPage />;
}

function ConfiguredSignInPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const redirectUrl = useRedirectUrl();
  return (
    <AuthFrame>
      {!isLoaded ? (
        <div className="flex flex-col items-center gap-3 text-ev-ink-2">
          <BrandMark size={40} />
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="text-sm">Preparing secure sign-in…</span>
        </div>
      ) : isSignedIn ? (
        <AlreadySignedIn href={redirectUrl} />
      ) : (
        <SignIn forceRedirectUrl={redirectUrl} signUpForceRedirectUrl={redirectUrl} />
      )}
    </AuthFrame>
  );
}

function AlreadySignedIn({ href }: { href: string }) {
  const pairing = href.includes('pair=') || href.startsWith('/connect/mac');
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-ev-line bg-ev-paper p-8 text-center shadow-[var(--ev-e-2)]">
      <BrandMark size={40} />
      <h1 className="text-lg font-semibold">You&apos;re already signed in</h1>
      <p className="text-sm text-ev-ink-2">
        {pairing
          ? 'Continue to approve the Mac that’s waiting to pair.'
          : 'Head to your dashboard to start capturing context.'}
      </p>
      <a
        href={href}
        className="inline-flex items-center gap-2 rounded-full bg-ev-slate px-5 py-2.5 font-round text-sm font-bold text-ev-on-slate shadow-[var(--ev-e-2)] hover:bg-ev-slate-hover"
      >
        {pairing ? 'Continue pairing' : 'Go to your dashboard'}
        <ArrowRight className="h-4 w-4" />
      </a>
    </div>
  );
}
