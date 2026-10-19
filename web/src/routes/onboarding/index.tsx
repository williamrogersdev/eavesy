import { createFileRoute } from '@tanstack/react-router';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { Bubble, Mascot } from '@/components/launcher/ui';
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
        body: JSON.stringify({}),
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
    <div className="grid w-full max-w-4xl overflow-hidden rounded-[24px] bg-ev-raised shadow-[0_0_0_1px_var(--ev-line),var(--ev-e-3)] lg:grid-cols-[1fr_0.9fr]">
      <section className="p-6 sm:p-9 lg:p-12">
        <div className="flex items-center gap-2 font-round text-[16px] font-extrabold">
          <BrandMark size={32} /> Eavesy
        </div>
        <div className="mt-10">
          <p className="font-round text-sm font-bold text-ev-coat">One-minute setup</p>
          <h1 className="mt-2 font-round text-3xl font-extrabold tracking-tight">Make the workspace yours</h1>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-ev-ink-2">
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
                className="h-11 w-full cursor-default rounded-[var(--ev-r-ctl)] bg-ev-well px-3 text-sm text-ev-ink-2"
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
              className="h-11 w-full rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-3 text-sm outline-none focus:border-ev-coat focus:shadow-[var(--ev-focus)]"
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="onboarding-company" className="text-sm font-medium">
                Company <span className="font-normal text-ev-ink-2">(optional)</span>
              </label>
              <input
                id="onboarding-company"
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                autoComplete="organization"
                placeholder="Acme Inc."
                className="h-11 w-full rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-3 text-sm outline-none focus:border-ev-coat focus:shadow-[var(--ev-focus)]"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="onboarding-role" className="text-sm font-medium">
                Role <span className="font-normal text-ev-ink-2">(optional)</span>
              </label>
              <select
                id="onboarding-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                autoComplete="organization-title"
                className="h-11 w-full rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-3 text-sm outline-none focus:border-ev-coat focus:shadow-[var(--ev-focus)]"
              >
                <option value="">Select a role</option>
                {ROLES.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </div>
          </div>

          <button
            type="submit"
            disabled={saving || !displayName.trim()}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-action px-4 font-round text-sm font-bold text-ev-on-coat shadow-[var(--ev-e-2)] hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating your workspace…</> : <>Open your workspace <ArrowRight className="h-4 w-4" /></>}
          </button>
          <p className="text-center text-xs leading-relaxed text-ev-ink-2">
            No card required.
          </p>
        </form>
      </section>

      <aside className="relative hidden overflow-hidden border-l border-ev-line bg-ev-well p-10 lg:flex lg:flex-col lg:justify-center">
        <div className="relative">
          <div className="flex items-end gap-3">
            <Mascot size={72} state="happy" />
            <Bubble tail="left" className="mb-4">Nearly there. Then I&apos;ll start writing things down.</Bubble>
          </div>
          <h2 className="mt-8 font-round text-2xl font-extrabold text-ev-ink">What happens next</h2>
          <ol className="mt-6 space-y-5">
            {NEXT_STEPS.map((item, index) => (
              <li key={item} className="flex gap-3 text-sm leading-relaxed text-ev-ink-2">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ev-coat-soft font-round text-xs font-extrabold text-ev-coat">{index + 1}</span>
                {item}
              </li>
            ))}
          </ol>
          <p className="mt-8 flex items-center gap-2 rounded-[var(--ev-r-pop)] bg-ev-raised p-3 text-xs text-ev-ink-2 shadow-[var(--ev-e-2)]">
            <Mascot size={18} state="sleeping" />
            Eavesy only listens while you&apos;re recording.
          </p>
        </div>
      </aside>
    </div>
  );
}
