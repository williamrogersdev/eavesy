'use client';

import { Loader2, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ANONYMOUS_TOKEN_STORAGE_KEY } from '@/lib/runtime';
import { cn } from '@/lib/utils';
import { Mascot } from '@/components/launcher/ui';
import { Section } from './layout';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

const CHAT_SUGGESTIONS = [
  'Summarize the key decisions',
  'What are my action items?',
  'Draft a follow-up email',
];

export function MeetingChat({ meetingId, ready }: { meetingId: string; ready: boolean }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || busy) return;
      setError(null);
      const next: ChatMsg[] = [...messages, { role: 'user', content }];
      setMessages(next);
      setInput('');
      setBusy(true);
      try {
        const token =
          typeof window !== 'undefined'
            ? window.localStorage.getItem(ANONYMOUS_TOKEN_STORAGE_KEY)
            : null;
        const res = await fetch(`/api/meetings/${meetingId}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: next, anonymousSessionToken: token ?? undefined }),
        });
        const json = (await res.json().catch(() => ({}))) as { reply?: string; error?: string; message?: string };
        if (!res.ok) throw new Error(json.message || json.error || 'Chat failed');
        setMessages((m) => [...m, { role: 'assistant', content: String(json.reply ?? '') }]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Chat failed');
      } finally {
        setBusy(false);
      }
    },
    [messages, busy, meetingId],
  );

  return (
    <Section title="Ask Eavesy" icon={<Mascot size={20} state={busy ? 'thinking' : 'idle'} />} flush>
      <div>
        {messages.length === 0 ? (
          <div className="px-4 pb-3">
            <p className="text-sm text-ev-ink-2">
              Ask anything about this recording. Answers come from its transcript.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {CHAT_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={!ready || busy}
                  onClick={() => void send(s)}
                  className="h-7 rounded-full bg-ev-well px-3 font-round text-xs font-semibold text-ev-ink transition hover:bg-ev-coat-soft hover:text-ev-coat disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div ref={scrollRef} className="max-h-[28rem] space-y-2.5 overflow-y-auto px-4 pb-3">
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap rounded-[var(--ev-r-panel)] px-3.5 py-2 text-sm leading-relaxed',
                    m.role === 'user' ? 'rounded-br-md bg-ev-coat text-ev-on-coat' : 'rounded-bl-md bg-ev-well text-ev-ink',
                  )}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {busy ? (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-[var(--ev-r-panel)] rounded-bl-md bg-ev-well px-3.5 py-2 text-sm text-ev-ink-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
                </div>
              </div>
            ) : null}
          </div>
        )}

        {error ? <p className="px-4 pb-2 text-xs text-ev-warn-ink">{error}</p> : null}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="m-2 mt-0 flex items-center gap-1.5 rounded-full bg-ev-well p-1 pl-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={ready ? 'Ask about this recording…' : 'Ready when the transcript is…'}
            aria-label="Ask a question about this meeting"
            disabled={!ready || busy}
            className="h-8 min-w-0 flex-1 bg-transparent px-2 text-sm text-ev-ink outline-none placeholder:text-ev-ink-3 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!ready || busy || !input.trim()}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-action font-round font-bold text-ev-on-coat transition hover:bg-action-hover disabled:opacity-50"
            aria-label="Send"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </form>
      </div>
    </Section>
  );
}
