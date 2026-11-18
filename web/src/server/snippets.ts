import { z } from 'zod';
import type { AppDb } from '@/db/client';
import * as snippets from '@/db/repo/snippets';
import { MAX_SNIPPET_TEXT, MAX_SNIPPETS, MAX_TRIGGER, isSnippetField, snippetProblem } from '@/lib/snippets';
import type { ResolvedIngestActor } from './device-auth';

const saveBody = z.object({
  id: z.string().min(1).max(100).optional(),
  // Generous enough that snippetProblem, not the parser, explains a long phrase or text.
  trigger: z.string().max(MAX_TRIGGER * 4),
  text: z.string().max(MAX_SNIPPET_TEXT * 2),
  field: z.string().max(40).nullable().optional(),
});

/** What a snippet looks like to the Settings list and the Mac. */
export function snippetView(row: snippets.SnippetRow) {
  return { id: row.id, trigger: row.trigger, text: row.text, field: row.field, updatedAt: row.updatedAt };
}

/** Shared by the browser and a paired Mac; the account always comes from authentication. */
export async function snippetsRequest(request: Request, db: AppDb, actor: ResolvedIngestActor): Promise<Response> {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  if (request.method === 'GET') return json({ snippets: (await snippets.list(db, actor.userId)).map(snippetView) });
  const text = await request.text().catch(() => null);
  if (text === null || text.length > 20_000) return json({ error: 'invalid_request' }, 400);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({ error: 'invalid_json' }, 400); }
  if (request.method === 'DELETE') {
    const parsed = z.object({ id: z.string().min(1).max(100) }).safeParse(body);
    if (!parsed.success) return json({ error: 'invalid_request' }, 400);
    await snippets.remove(db, actor.userId, parsed.data.id);
    return json({ ok: true });
  }
  const parsed = saveBody.safeParse(body);
  if (!parsed.success) return json({ error: 'invalid_request' }, 400);
  const { id, trigger, text: insert, field } = parsed.data;
  const problem = snippetProblem(trigger, insert);
  if (problem) return json({ error: 'invalid_snippet', message: problem }, 400);
  if (field != null && !isSnippetField(field)) return json({ error: 'invalid_field', message: 'Pick a field from the list.' }, 400);
  const outcome = await snippets.save(db, actor.userId, { id, trigger, text: insert, field: field ?? null });
  switch (outcome) {
    case 'saved': return json({ ok: true });
    case 'taken': return json({ error: 'taken', message: 'Another snippet already uses that phrase. Edit that one instead.' }, 409);
    case 'full': return json({ error: 'full', message: `You can keep up to ${MAX_SNIPPETS} snippets. Remove one before adding another.` }, 400);
    case 'not_found': return json({ error: 'not_found', message: 'That snippet is gone. Refresh the list.' }, 404);
  }
}
