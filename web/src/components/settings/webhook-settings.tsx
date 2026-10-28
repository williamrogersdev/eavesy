'use client';

import { useEffect, useState } from 'react';
import { AppAlert, appButton } from '@/components/ui/app-page';
import { isRecord } from '@/lib/json';

const EVENTS = [
  { id: 'recording.completed', label: 'Recording finished' },
  { id: 'dictation.created', label: 'Dictation saved' },
  { id: 'capture.created', label: 'Note or capture saved' },
] as const;

interface Webhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  disabledReason: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  addedWithKey: boolean;
}

function parseWebhook(value: unknown): Webhook | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.url !== 'string') return null;
  return {
    id: value.id,
    url: value.url,
    events: Array.isArray(value.events) ? value.events.filter((event): event is string => typeof event === 'string') : [],
    enabled: value.enabled === true,
    disabledReason: typeof value.disabled_reason === 'string' ? value.disabled_reason : null,
    lastSuccessAt: typeof value.last_success_at === 'string' ? value.last_success_at : null,
    lastError: typeof value.last_error === 'string' ? value.last_error : null,
    addedWithKey: typeof value.created_by_key_id === 'string',
  };
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(isRecord(data) && typeof data.error === 'string' ? data.error : `Server returned ${response.status}`);
  return data;
}

function statusLine(webhook: Webhook): string {
  if (!webhook.enabled) return webhook.disabledReason ?? 'Off';
  if (webhook.lastError) return `Last delivery failed: ${webhook.lastError}`;
  if (webhook.lastSuccessAt) return `Last delivered ${new Date(webhook.lastSuccessAt).toLocaleString()}`;
  return 'Nothing sent yet';
}

/** Settings → Webhooks: URLs Eavesy POSTs signed events to when something new arrives. */
export function WebhookSettings() {
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(EVENTS.map((event) => event.id));
  const [busy, setBusy] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    void call('GET', '/api/webhook-endpoints')
      .then((data) => setWebhooks(Array.isArray(data) ? data.flatMap((item) => parseWebhook(item) ?? []) : []))
      .catch(() => setNotice({ tone: 'danger', text: 'Could not load your webhooks.' }));
  }, []);

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setNotice(null);
    try {
      await work();
    } catch (cause) {
      setNotice({ tone: 'danger', text: cause instanceof Error ? cause.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  };

  const add = () =>
    run('add', async () => {
      const created: unknown = await call('POST', '/api/webhook-endpoints', { url: url.trim(), events });
      const webhook = parseWebhook(created);
      if (!webhook || !isRecord(created) || typeof created.secret !== 'string') throw new Error('Server returned an invalid webhook');
      setWebhooks((list) => [...(list ?? []), webhook]);
      setSecret(created.secret);
      setUrl('');
    });

  const replace = (webhook: Webhook) => setWebhooks((list) => list?.map((item) => (item.id === webhook.id ? webhook : item)) ?? list);

  const setEnabled = (webhook: Webhook, enabled: boolean) =>
    run(webhook.id, async () => {
      const updated = parseWebhook(await call('PATCH', '/api/webhook-endpoints', { id: webhook.id, enabled }));
      if (updated) replace(updated);
    });

  const test = (webhook: Webhook) =>
    run(webhook.id, async () => {
      const result: unknown = await call('POST', '/api/webhook-endpoints/test', { id: webhook.id });
      const delivered = isRecord(result) && result.delivered === true;
      const error = isRecord(result) && typeof result.error === 'string' ? result.error : null;
      setNotice(delivered ? { tone: 'success', text: `Test event delivered to ${webhook.url}.` } : { tone: 'danger', text: error ?? 'The test event was not delivered.' });
    });

  const remove = (webhook: Webhook) =>
    run(webhook.id, async () => {
      await call('DELETE', '/api/webhook-endpoints', { id: webhook.id });
      setWebhooks((list) => list?.filter((item) => item.id !== webhook.id) ?? list);
    });

  return (
    <div className="flex flex-col gap-3">
      {secret ? (
        <AppAlert tone="success">
          <p className="text-xs font-medium">Signing secret. Check each delivery’s signature with it; it won’t be shown again.</p>
          <code className="mt-2 block break-all font-mono text-xs">{secret}</code>
        </AppAlert>
      ) : null}
      {notice ? (
        <AppAlert tone={notice.tone}>
          <p className="text-xs">{notice.text}</p>
        </AppAlert>
      ) : null}
      {webhooks?.length ? (
        <ul className="divide-y divide-ev-line rounded-[var(--ev-r-ctl)] border border-ev-line">
          {webhooks.map((webhook) => (
            <li key={webhook.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate font-mono text-xs">{webhook.url}</span>
                <span className={webhook.enabled && !webhook.lastError ? 'block text-xs text-ev-ink-2' : 'block text-xs text-ev-warn-ink'}>
                  {EVENTS.filter((event) => webhook.events.includes(event.id)).map((event) => event.label).join(', ')} · {statusLine(webhook)}
                  {webhook.addedWithKey ? ' · added with an API key, stops if the key is revoked' : null}
                </span>
              </span>
              <span className="flex shrink-0 gap-1">
                <button type="button" disabled={busy === webhook.id} onClick={() => void test(webhook)} className={appButton('ghost', 'sm')}>
                  Test
                </button>
                <button type="button" disabled={busy === webhook.id} onClick={() => void setEnabled(webhook, !webhook.enabled)} className={appButton('ghost', 'sm')}>
                  {webhook.enabled ? 'Turn off' : 'Turn on'}
                </button>
                <button type="button" disabled={busy === webhook.id} onClick={() => void remove(webhook)} className={appButton('ghost', 'sm')}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <div className="flex gap-2">
          <input
            type="url"
            required
            placeholder="https://example.com/hooks/eavesy"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            aria-label="Webhook URL"
            className="h-9 w-full rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-3 text-sm outline-none focus:border-ev-coat"
          />
          <button type="submit" disabled={busy === 'add' || !url.trim() || events.length === 0} className={appButton('secondary')}>
            {busy === 'add' ? 'Adding…' : 'Add'}
          </button>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {EVENTS.map((event) => (
            <label key={event.id} className="flex items-center gap-1.5 text-xs text-ev-ink-2">
              <input
                type="checkbox"
                checked={events.includes(event.id)}
                onChange={(change) =>
                  setEvents((list) => (change.target.checked ? [...list, event.id] : list.filter((id) => id !== event.id)))
                }
              />
              {event.label}
            </label>
          ))}
        </div>
      </form>
    </div>
  );
}
