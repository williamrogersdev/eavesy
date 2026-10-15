'use client';

import { Loader2, Send, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ANONYMOUS_TOKEN_STORAGE_KEY } from '@/lib/runtime';
import { cn } from '@/lib/utils';
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
    <Section title="Ask">
      <div className="rounded-lg border border-border">
        {messages.length === 0 ? (
          <div className="p-3">
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Sparkles className="h-4 w-4 text-accent" />
              Ask anything about this recording — answers are grounded in its transcript.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {CHAT_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={!ready || busy}
                  onClick={() => void send(s)}
                  className="h-7 rounded-full border border-border bg-background px-2.5 text-xs transition hover:border-accent/50 hover:text-accent disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div ref={scrollRef} className="max-h-96 space-y-2.5 overflow-y-auto p-3">
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
                    m.role === 'user' ? 'bg-action text-white' : 'border border-border bg-background',
                  )}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {busy ? (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl border border-border bg-background px-3.5 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
                </div>
              </div>
            ) : null}
          </div>
        )}

        {error ? <p className="px-3 pb-2 text-xs text-danger">{error}</p> : null}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="flex items-center gap-1.5 border-t border-border p-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={ready ? 'Ask about this meeting…' : 'Available once processing finishes…'}
            aria-label="Ask a question about this meeting"
            disabled={!ready || busy}
            className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-sm outline-none focus:border-accent/50 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!ready || busy || !input.trim()}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-action text-white transition hover:bg-action-hover disabled:opacity-50"
            aria-label="Send"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </form>
      </div>
    </Section>
  );
}
