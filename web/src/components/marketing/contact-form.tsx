'use client';

import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { isRecord } from '@/lib/json';

type Status = 'idle' | 'submitting' | 'success' | 'error';

const TOPICS = ['General', 'Sales', 'Support', 'Press', 'Security'];

export function ContactForm() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('submitting');
    setError(null);

    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json: unknown = await res.json();
      if (!res.ok || !isRecord(json) || json.ok !== true) {
        const message = isRecord(json) && typeof json.error === 'string'
          ? json.error
          : 'Something went wrong. Please try again.';
        throw new Error(message);
      }
      setStatus('success');
      form.reset();
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  if (status === 'success') {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-ev-line bg-ev-raised p-10 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ev-well text-ev-ink">
          <Check className="h-6 w-6" />
        </span>
        <h2 className="text-xl font-semibold text-ev-ink">Message sent</h2>
        <p className="max-w-sm text-sm text-ev-ink-2">
          Thanks for reaching out — we’ll get back to you at the email you provided.
        </p>
        <button
          type="button"
          onClick={() => setStatus('idle')}
          className="text-sm font-medium text-ev-slate transition hover:text-ev-slate-hover"
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      className="flex flex-col gap-5 rounded-2xl border border-ev-line bg-ev-raised p-6 sm:p-8"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name">
          <input
            name="name"
            required
            maxLength={120}
            autoComplete="name"
            className={inputClass}
            placeholder="Jane Doe"
          />
        </Field>
        <Field label="Email">
          <input
            name="email"
            type="email"
            required
            maxLength={200}
            autoComplete="email"
            className={inputClass}
            placeholder="jane@company.com"
          />
        </Field>
      </div>

      <Field label="Topic">
        <select name="topic" className={inputClass} defaultValue="General">
          {TOPICS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Message">
        <textarea
          name="message"
          required
          minLength={10}
          maxLength={5000}
          rows={6}
          className={`${inputClass} resize-y`}
          placeholder="How can we help?"
        />
      </Field>

      <input
        type="text"
        name="company"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
      />

      {error && <p className="text-sm text-ev-slate">{error}</p>}

      <button
        type="submit"
        disabled={status === 'submitting'}
        className="inline-flex items-center justify-center gap-2 rounded-full bg-ev-slate px-5 py-3 text-sm font-round font-bold text-ev-on-slate shadow-[var(--ev-e-2)] transition hover:bg-ev-slate-hover disabled:opacity-60"
      >
        {status === 'submitting' && <Loader2 className="h-4 w-4 animate-spin" />}
        {status === 'submitting' ? 'Sending…' : 'Send message'}
      </button>
    </form>
  );
}

const inputClass =
  'w-full rounded-xl border border-ev-line bg-ev-raised px-4 py-2.5 text-sm text-ev-ink placeholder:text-ev-ink-2 outline-none transition focus:border-ev-slate/40 focus:bg-ev-paper';

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium text-ev-ink">{label}</span>
      {children}
    </label>
  );
}
