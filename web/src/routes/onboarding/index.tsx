import { createFileRoute } from '@tanstack/react-router';
import { ArrowRight, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { Bubble, Mascot } from '@/components/launcher/ui';
import { SpokenLanguages } from '@/components/settings/spoken-languages';
import { AppAlert } from '@/components/ui/app-page';
import { appReturnPath } from '@/lib/auth-return';
import { isRecord, optionalString } from '@/lib/json';
import { useRouter } from '@/lib/next-compat/navigation';
import { MAX_ONBOARDING_PROJECTS, takeProjectDraft } from '@/lib/onboarding';
import { languagesFromLocales } from '@/lib/transcription/language';

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
  const [displayName, setDisplayName] = useState('');
  const [projects, setProjects] = useState<string[]>([]);
  const [projectDraft, setProjectDraft] = useState('');
  const [spoken, setSpoken] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fromBrowser = languagesFromLocales(navigator.languages.length ? navigator.languages : [navigator.language]);
    setSpoken(fromBrowser.length > 0 ? fromBrowser.slice(0, 2) : ['en']);
    let cancelled = false;
    void fetch('/api/me')
      .then(async (response): Promise<unknown> => (response.ok ? response.json() : null))
      .then((me) => {
        if (cancelled || !isRecord(me)) return;
        setDisplayName(optionalString(me.displayName) ?? '');
      })
      .catch(() => setError('We could not load your account details. You can still continue.'));
    return () => {
      cancelled = true;
    };
  }, []);

  const editProjects = (draft: string, finish = false) => {
    const next = takeProjectDraft(projects, draft, finish);
    setProjects(next.projects);
    setProjectDraft(next.draft);
  };

  async function finishSetup(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const response = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: displayName.trim(),
          spokenLanguages: spoken,
          projects: takeProjectDraft(projects, projectDraft, true).projects,
        }),
      });
      if (!response.ok) throw new Error('Could not finish setup. Please try again.');
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
          <p className="font-round text-sm font-bold text-ev-slate">One-minute setup</p>
          <h1 className="mt-2 font-round text-3xl font-extrabold tracking-tight">Make the workspace yours</h1>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-ev-ink-2">
            Three quick things so your first recording comes out right. You can change them later in Settings.
          </p>
        </div>

        <form onSubmit={(event) => void finishSetup(event)} className="mt-8 space-y-6">
          {error ? <AppAlert>{error}</AppAlert> : null}

          <div className="space-y-1.5">
            <label htmlFor="onboarding-name" className="text-sm font-medium">What should we call you?</label>
            <input
              id="onboarding-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              autoFocus
              autoComplete="name"
              placeholder="Jane Doe"
              className="h-11 w-full rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-3 text-sm outline-none focus:border-ev-slate focus:shadow-[var(--ev-focus)]"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="onboarding-projects" className="text-sm font-medium">
              What are you working on? <span className="font-normal text-ev-ink-2">(optional)</span>
            </label>
            <p className="text-xs leading-relaxed text-ev-ink-2">
              A client, a product, a class. Each becomes a project: recordings get filed under it and Eavesy learns its names and terms.
            </p>
            <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-2 py-1.5 focus-within:border-ev-slate focus-within:shadow-[var(--ev-focus)]">
              {projects.map((project) => (
                <span key={project} className="ev-chip bg-ev-slate-soft text-ev-slate shadow-none">
                  {project}
                  <button
                    type="button"
                    onClick={() => setProjects((current) => current.filter((item) => item !== project))}
                    aria-label={`Remove ${project}`}
                    className="-mr-1 grid h-4 w-4 place-items-center rounded-full hover:bg-ev-hover"
                  >
                    <X size={11} strokeWidth={2} aria-hidden />
                  </button>
                </span>
              ))}
              {projects.length < MAX_ONBOARDING_PROJECTS ? (
                <input
                  id="onboarding-projects"
                  value={projectDraft}
                  onChange={(event) => editProjects(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && projectDraft.trim()) {
                      event.preventDefault();
                      editProjects(projectDraft, true);
                    }
                    if (event.key === 'Backspace' && !projectDraft && projects.length > 0) {
                      setProjects((current) => current.slice(0, -1));
                    }
                  }}
                  onBlur={() => editProjects(projectDraft, true)}
                  placeholder={projects.length === 0 ? 'Acme redesign, Thesis…' : 'Add another'}
                  className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 text-sm outline-none focus-visible:outline-none!"
                />
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="onboarding-languages" className="text-sm font-medium">Which languages do you speak in recordings?</label>
            <p className="text-xs leading-relaxed text-ev-ink-2">
              Eavesy picks up whichever one is spoken, line by line, even when a conversation switches between them.
            </p>
            <SpokenLanguages id="onboarding-languages" value={spoken} onChange={setSpoken} className="pt-1" />
          </div>

          <button
            type="submit"
            disabled={saving || !displayName.trim()}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-action px-4 font-round text-sm font-bold text-ev-on-slate shadow-[var(--ev-e-2)] hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-50"
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
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ev-slate-soft font-round text-xs font-extrabold text-ev-slate">{index + 1}</span>
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
