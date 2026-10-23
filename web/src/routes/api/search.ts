import { createFileRoute } from '@tanstack/react-router';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { and, desc, eq, inArray, isNull, ne, or, sql, type SQLWrapper } from 'drizzle-orm';
import type { VectorizeIndex } from '@cloudflare/workers-types';
import { getDb } from '@/db/client';
import { clampLimit } from '@/lib/http/clamp-limit';
import { embeddings, meetings, dictations } from '@/db/schema';
import { guardUserQuota } from '@/server/rate-limit';
import { resolveActor } from '@/server/auth';
import { createAiRunner, type CreditEnv } from '@/lib/ai/credit-runner';
import { embedTexts } from '@/lib/ai/embed';

type SearchItem =
  | {
      kind: 'meeting';
      score: number;
      excerpt?: string;
      meeting: { id: string; title: string; description: string; startedAt: number };
    }
  | {
      kind: 'dictation';
      score: number;
      excerpt?: string;
      dictation: { id: string; title: string; createdAt: number };
    };

export const Route = createFileRoute('/api/search')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const url = new URL(request.url);
        const q = url.searchParams.get('q')?.trim();
        const limit = clampLimit(url.searchParams.get('limit'), 10, 25);
        if (!q) return Response.json({ items: [] });

        const db = getDb();
        // `\` escapes LIKE's wildcards; SQLite needs ESCAPE to honour it.
        const pattern = `%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        const contains = (column: SQLWrapper) => sql`${column} LIKE ${pattern} ESCAPE '\\'`;
        const lexicalRows = await db
          .select()
          .from(meetings)
          .where(
            and(
              eq(meetings.userId, actor.userId),
              isNull(meetings.deletedAt),
              or(ne(meetings.source, 'import'), eq(meetings.status, 'complete')),
              or(
                contains(meetings.title),
                contains(meetings.description),
                contains(meetings.summaryOverrideMd),
                contains(meetings.transcriptOverrideMd),
              ),
            ),
          )
          .orderBy(desc(meetings.startedAt))
          .limit(limit);
        const lexicalItems: SearchItem[] = lexicalRows.map((meeting) => ({
          kind: 'meeting' as const,
          score: 1,
          excerpt: matchingExcerpt(
            meeting.summaryOverrideMd ?? meeting.transcriptOverrideMd ?? meeting.description,
            q,
          ),
          meeting: {
            id: meeting.id,
            title: meeting.title,
            description: meeting.description,
            startedAt: meeting.startedAt,
          },
        }));

        const { env } = getCloudflareContext();
        const vectorize = (env as { VECTORIZE?: VectorizeIndex }).VECTORIZE;
        const fallback = () => Response.json({ items: lexicalItems, note: 'semantic search is unavailable; showing text matches' });
        if (!vectorize || (await guardUserQuota(actor.userId, 'search'))) return fallback();
        let queryVec: number[] | undefined;
        try {
          // Query embeddings never go through the credit pilot: without the binding there is no vector to search with.
          const ai = (env as CreditEnv).AI ? createAiRunner(env as CreditEnv, 'search-embedding') : undefined;
          if (!ai) return fallback();
          queryVec = (await embedTexts(ai, [q]))[0];
        } catch { console.warn(JSON.stringify({ message: 'semantic search unavailable; using lexical results' })); return fallback(); }
        if (!queryVec) return fallback();

        const matches = await vectorize.query(queryVec, {
          topK: limit * 3,
          filter: { userId: actor.userId },
          returnMetadata: 'all',
        });

        const meetingIds = new Set<string>();
        const dictationIds = new Set<string>();
        for (const m of matches.matches ?? []) {
          const md = asMetadata(m.metadata);
          if (md?.sourceType === 'meeting' && md.sourceId) meetingIds.add(md.sourceId);
          if (md?.sourceType === 'dictation' && md.sourceId) dictationIds.add(md.sourceId);
        }

        const [meetingRows, dictationRows, excerpts] = await Promise.all([
          meetingIds.size
            ? db
                .select()
                .from(meetings)
                .where(
                  and(
                    eq(meetings.userId, actor.userId),
                    isNull(meetings.deletedAt),
              or(ne(meetings.source, 'import'), eq(meetings.status, 'complete')),
                    inArray(meetings.id, [...meetingIds]),
                  ),
                )
            : Promise.resolve([]),
          dictationIds.size
            ? db
                .select()
                .from(dictations)
                .where(
                  and(
                    eq(dictations.userId, actor.userId),
                    isNull(dictations.deletedAt),
                    inArray(dictations.id, [...dictationIds]),
                  ),
                )
            : Promise.resolve([]),
          matches.matches?.length
            ? db
                .select()
                .from(embeddings)
                .where(
                  and(
                    eq(embeddings.userId, actor.userId),
                    inArray(embeddings.id, matches.matches.map((match) => String(match.id))),
                  ),
                )
            : Promise.resolve([]),
        ]);

        const meetingsById = new Map(meetingRows.map((m) => [m.id, m]));
        const dictationsById = new Map(dictationRows.map((d) => [d.id, d]));
        const excerptByVecId = new Map(excerpts.map((e) => [e.id, e.contentExcerpt]));

        const items: SearchItem[] =
          matches.matches?.map((m): SearchItem | null => {
            const md = asMetadata(m.metadata);
            const id = m.id;
            if (md.sourceType === 'meeting' && md.sourceId) {
              const meeting = meetingsById.get(md.sourceId);
              if (!meeting) return null;
              return {
                kind: 'meeting',
                score: m.score,
                excerpt: excerptByVecId.get(id),
                meeting: {
                  id: meeting.id,
                  title: meeting.title,
                  description: meeting.description,
                  startedAt: meeting.startedAt,
                },
              };
            }
            if (md.sourceType === 'dictation' && md.sourceId) {
              const d = dictationsById.get(md.sourceId);
              if (!d) return null;
              return {
                kind: 'dictation',
                score: m.score,
                excerpt: excerptByVecId.get(id),
                dictation: { id: d.id, title: d.title, createdAt: d.createdAt },
              };
            }
            return null;
          }).filter((item): item is SearchItem => item !== null) ?? [];

        const combined = [...lexicalItems, ...items].filter((item, index, all) => {
          const key = searchItemKey(item);
          return all.findIndex((candidate) => searchItemKey(candidate) === key) === index;
        });
        return Response.json({ items: combined.slice(0, limit) });
      },
    },
  },
});

function asMetadata(value: unknown): {
  sourceType?: 'meeting' | 'dictation';
  sourceId?: string;
} {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const sourceType = record.sourceType === 'meeting' || record.sourceType === 'dictation'
    ? record.sourceType
    : undefined;
  return {
    sourceType,
    sourceId: typeof record.sourceId === 'string' ? record.sourceId : undefined,
  };
}

function matchingExcerpt(content: string, query: string): string | undefined {
  const normalized = content.toLocaleLowerCase();
  const index = normalized.indexOf(query.toLocaleLowerCase());
  if (index < 0) return content.trim().slice(0, 240) || undefined;
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + query.length + 160);
  return `${start > 0 ? '…' : ''}${content.slice(start, end).trim()}${end < content.length ? '…' : ''}`;
}

function searchItemKey(item: SearchItem): string {
  return item.kind === 'meeting' ? `meeting:${item.meeting.id}` : `dictation:${item.dictation.id}`;
}
