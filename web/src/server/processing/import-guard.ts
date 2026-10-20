import type { ProcessingEnv } from './shared';

/** Guard the insert and its conflict update in one SQLite statement/snapshot. */
export function guardedImportWrite(env: ProcessingEnv, query: { sql: string; params: unknown[] }, meetingId: string) {
  const values = /\bvalues\s*\(([^)]*)\)/i.exec(query.sql);
  if (!values || values.index === undefined) throw new Error('Unsupported guarded import write');
  // Only the primitive placeholders emitted by these two insert builders are
  // supported. Expressions or nested parentheses fail closed, never rewritten.
  if (!/^(?:\s*(?:\?|null|[-0-9]+)\s*,?)+$/i.test(values[1])) throw new Error('Unsupported guarded values');
  const before = query.sql.slice(0, values.index);
  const after = query.sql.slice(values.index + values[0].length);
  const count = (values[1].match(/\?/g) ?? []).length;
  const sql = `${before}SELECT ${values[1]} WHERE EXISTS (
    SELECT 1 FROM recording_imports i JOIN meetings m ON m.id = i.meeting_id
    WHERE i.meeting_id = ? AND i.state = 'processing' AND m.deleted_at IS NULL AND m.status != 'failed'
  ) ${after}`;
  const params = [...query.params.slice(0, count), meetingId, ...query.params.slice(count)];
  return env.DB.prepare(sql).bind(...params);
}
