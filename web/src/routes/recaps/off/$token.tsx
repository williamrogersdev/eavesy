import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { Link } from '@/components/ui/app-link';
import { appButton } from '@/components/ui/app-page';

/**
 * The "Turn them off" link in a recap. Opening it changes nothing (mail
 * scanners open links); the button turns recaps off without signing in.
 */
export const Route = createFileRoute('/recaps/off/$token')({
  head: () => ({ meta: [{ title: 'Turn off email notes · Eavesy' }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: RecapsOffPage,
});

function RecapsOffPage() {
  const { token } = Route.useParams();
  const [phase, setPhase] = useState<'ready' | 'working' | 'done' | 'error'>('ready');

  const turnOff = async () => {
    setPhase('working');
    try {
      const response = await fetch('/api/email/recaps-off', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      setPhase(response.ok ? 'done' : 'error');
    } catch {
      setPhase('error');
    }
  };

  return (
    <main className="ev mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-5 bg-ev-paper px-4 py-10 text-center text-ev-ink">
      <BrandMark size={40} />
      {phase === 'done' ? (
        <>
          <h1 className="font-round text-[22px] font-extrabold">Email notes are off</h1>
          <p className="text-sm text-ev-ink-2">You won’t get an email after your meetings. Turn them back on any time in <Link href="/app/settings#email" className="underline">Settings → Email</Link>.</p>
        </>
      ) : (
        <>
          <h1 className="font-round text-[22px] font-extrabold">Stop emailing me notes?</h1>
          <p className="text-sm text-ev-ink-2">Eavesy emails you the notes after every meeting. You can still read them in the app.</p>
          {phase === 'error' ? (
            <p role="alert" className="text-sm text-ev-warn-ink">That didn’t work. The link may be out of date: turn them off in <Link href="/app/settings#email" className="underline">Settings → Email</Link>.</p>
          ) : null}
          <button type="button" className={appButton('primary')} disabled={phase === 'working'} onClick={() => void turnOff()}>
            {phase === 'working' ? 'Turning off…' : 'Turn off email notes'}
          </button>
        </>
      )}
    </main>
  );
}
