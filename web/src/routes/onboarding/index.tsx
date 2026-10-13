import { createFileRoute } from '@tanstack/react-router';
import { ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { AppAlert } from '@/components/ui/app-page';
import { appReturnPath } from '@/lib/auth-return';
import { isRecord, optionalString } from '@/lib/json';
import { useRouter } from '@/lib/next-compat/navigation';

const ROLES = [
  'Founder / CEO',
  'Product',
  'Engineering',
  'Design',
  'Sales',
  'Marketing',
  'Operations',
  'Consultant',
  'Student',
  'Other',
];

const NEXT_STEPS = [
  'Record a short explanation in your browser',
  'Review the brief that opens automatically',
  'Copy the finished brief into any AI agent',
];

export const Route = createFileRoute('/onboarding/')({
  component: OnboardingPage,
});

function OnboardingPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [role, setRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/me')
      .then(async (response): Promise<unknown> => (response.ok ? response.json() : null))
      .then((me) => {
        if (cancelled || !isRecord(me)) return;
        setEmail(optionalString(me.email) ?? '');
        setDisplayName(optionalString(me.displayName) ?? '');
        setCompanyName(optionalString(me.companyName) ?? '');
        setRole(optionalString(me.role) ?? '');
      })
      .catch(() => setError('We could not load your account details. You can still continue.'));
    return () => {
      cancelled = true;
    };
  }, []);

  async function finishSetup(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const profileResponse = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: displayName.trim(),
          companyName: companyName.trim() || null,
          role: role || null,
        }),
      });
      if (!profileResponse.ok) throw new Error('Could not save your profile. Please try again.');

      const completeResponse = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'free' }),
      });
      if (!completeResponse.ok) throw new Error('Could not finish setup. Please try again.');
      const returnTo = new URLSearchParams(window.location.search).get('redirect_url');
      await router.push(appReturnPath(returnTo, '/app/record?first=1'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.');
      setSaving(false);
    }
  }

  return (
    <div className="grid w-full max-w-4xl overflow-hidden rounded-3xl border border-border bg-background shadow-2xl shadow-black/10 lg:grid-cols-[1fr_0.9fr]">
      <section className="p-6 sm:p-9 lg:p-12">
        <div className="flex items-center gap-2.5 font-semibold tracking-tight">
          <BrandMark className="h-8 w-8" /> Eavesy
        </div>
        <div className="mt-10">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">One-minute setup</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em]">Make the workspace yours</h1>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            Add a name for your recordings. The optional details help Eavesy choose better defaults later.
          </p>
        </div>

        <form onSubmit={(event) => void finishSetup(event)} className="mt-8 space-y-5">
          {error ? <AppAlert>{error}</AppAlert> : null}

          {email ? (
            <div className="space-y-1.5">
              <label htmlFor="onboarding-email" className="text-sm font-medium">Email</label>
              <input
                id="onboarding-email"
                value={email}
                readOnly
                autoComplete="email"
                className="h-11 w-full cursor-default rounded-xl border border-border bg-muted/45 px-3 text-sm text-muted-foreground"
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor="onboarding-name" className="text-sm font-medium">Your name</label>
            <input
              id="onboarding-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              autoFocus
              autoComplete="name"
              placeholder="Jane Doe"
              className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-accent/50"
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="onboarding-company" className="text-sm font-medium">
                Company <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <input
                id="onboarding-company"
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                autoComplete="organization"
                placeholder="Acme Inc."
                className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-accent/50"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="onboarding-role" className="text-sm font-medium">
                Role <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <select
                id="onboarding-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                autoComplete="organization-title"
                className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-accent/50"
              >
                <option value="">Select a role</option>
                {ROLES.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </div>
          </div>

          <button
            type="submit"
            disabled={saving || !displayName.trim()}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-action px-4 text-sm font-semibold text-white shadow-sm shadow-action/20 hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating your workspace…</> : <>Open your workspace <ArrowRight className="h-4 w-4" /></>}
          </button>
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            You&apos;ll start on the free plan. No card required.
          </p>
        </form>
      </section>

      <aside className="theme-dark relative hidden overflow-hidden border-l border-white/10 p-10 lg:flex lg:flex-col lg:justify-center">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-dot-grid text-white/[0.05]" />
        <div aria-hidden className="pointer-events-none absolute -right-36 top-1/4 h-80 w-80 rounded-full bg-accent/20 blur-[100px]" />
        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">What happens next</p>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight text-white">Your first useful brief is minutes away.</h2>
          <ul className="mt-7 space-y-5">
            {NEXT_STEPS.map((item, index) => (
              <li key={item} className="flex gap-3 text-sm leading-relaxed text-white/70">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white">{index + 1}</span>
                {item}
              </li>
            ))}
          </ul>
          <div className="mt-8 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-xs text-white/55">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-accent" />
            Capture starts only when you choose to record.
          </div>
        </div>
      </aside>
    </div>
  );
}
