import { createFileRoute } from '@tanstack/react-router';
import { SignUp, useAuth } from '@clerk/tanstack-react-start';
import { useState } from 'react';
import { appReturnPath } from '@/lib/auth-return';
import { ArrowRight, Loader2 } from 'lucide-react';
import { AuthFrame, AuthUnavailable } from '@/components/auth/auth-frame';
import { BrandMark } from '@/components/brand-mark';

export const Route = createFileRoute('/sign-up/$')({
  head: () => ({
    meta: [
      { title: 'Sign up' },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  component: SignUpPage,
});

function SignUpPage() {
  if (!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) {
    return <AuthUnavailable action="create an account" />;
  }
  return <ConfiguredSignUpPage />;
}

function ConfiguredSignUpPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const [redirectUrl] = useState(() => typeof window === 'undefined' ? '/app' : appReturnPath(new URLSearchParams(window.location.search).get('redirect_url')));
  return (
    <AuthFrame>
      {!isLoaded ? (
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <BrandMark className="h-10 w-10" />
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="text-sm">Preparing your workspace…</span>
        </div>
      ) : isSignedIn ? (
        <AlreadySignedIn href={redirectUrl} />
      ) : (
        <SignUp forceRedirectUrl={redirectUrl} signInForceRedirectUrl={redirectUrl} />
      )}
    </AuthFrame>
  );
}

function AlreadySignedIn({ href }: { href: string }) {
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-border bg-background p-8 text-center shadow-xl shadow-black/5">
      <BrandMark className="h-10 w-10" />
      <h1 className="text-lg font-semibold">You&apos;re already signed in</h1>
      <p className="text-sm text-muted-foreground">
        Head to your dashboard to start capturing context.
      </p>
      <a
        href={href}
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
      >
        Go to your dashboard
        <ArrowRight className="h-4 w-4" />
      </a>
    </div>
  );
}
