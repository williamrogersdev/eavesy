import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDb } from '@/db/client';
import { meetings, meetingSegments, recordingImports } from '@/db/schema';
import { pid } from '@/db/ids';
import { MAX_IMPORT_BYTES, MAX_IMPORT_SECONDS, SAMPLE_RATE, SEGMENT_SECONDS, wavDurationMs } from '@/lib/imports/wav';
import type { ProcessingEnv } from '@/server/processing-worker';
import type { QueueMessage } from '@/server/queue';

const createSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().trim().min(1).max(200),
  durationMs: z.number().int().min(1).max(MAX_IMPORT_SECONDS * 1000), language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/).default('en'),
});
const json = (error: string, status = 400) => Response.json({ error }, { status });
/** A body past its limit: the client's mistake (413), not a transient failure to retry. */
class UploadTooLarge extends Error {}

export async function createImport(db: AppDb, userId: string, input: unknown) {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return json('Invalid import metadata');
  const args = parsed.data;
  const existing = (await db.select().from(recordingImports).innerJoin(meetings, eq(meetings.id, recordingImports.meetingId))
    .where(and(eq(recordingImports.userId, userId), eq(recordingImports.fingerprint, args.fingerprint))).limit(1))[0];
  if (existing) {
    if (existing.meetings.deletedAt) return json('This file was deleted. Restore its meeting before importing again.', 409);
    return Response.json({ meetingId: existing.meetings.id, status: existing.meetings.status, state: existing.recording_imports.state, duplicate: true });
  }
  const id = pid('meet');
  const now = Date.now();
  // D1 batch is transactional: no orphan meeting on a concurrent duplicate.
  try {
    await db.batch([
      db.insert(meetings).values({ id, userId, title: args.title, source: 'import', language: args.language, status: 'uploading', startedAt: now, createdAt: now, updatedAt: now }),
      db.insert(recordingImports).values({ meetingId: id, userId, fingerprint: args.fingerprint, durationMs: args.durationMs, segmentCount: Math.ceil(args.durationMs / (SEGMENT_SECONDS * 1000)), createdAt: now }),
    ]);
  } catch (error) {
    const winner = (await db.select().from(recordingImports).where(and(eq(recordingImports.userId, userId), eq(recordingImports.fingerprint, args.fingerprint))).limit(1))[0];
    if (winner) return Response.json({ meetingId: winner.meetingId, state: winner.state, duplicate: true });
    throw error;
  }
  return Response.json({ meetingId: id, state: 'uploading', duplicate: false }, { status: 201 });
}

/** All operations re-check ownership. No work is queued until all audio is durable. */
export async function importRequest(db: AppDb, env: ProcessingEnv, userId: string, path: string, request: Request): Promise<Response> {
  const [id, action, indexText] = path.split('/');
  const record = (await db.select().from(recordingImports).innerJoin(meetings, eq(recordingImports.meetingId, meetings.id))
    .where(and(eq(recordingImports.meetingId, id), eq(recordingImports.userId, userId), isNull(meetings.deletedAt))).limit(1))[0];
  if (!record) return json('Import not found', 404);
  const job = record.recording_imports;
  const meeting = record.meetings;
  const segments = await db.select().from(meetingSegments).where(eq(meetingSegments.meetingId, id)).orderBy(meetingSegments.idx);
  if (request.method === 'GET' && !action) return Response.json({
    meetingId: id, state: job.state, status: meeting.status, error: meeting.statusError,
    uploaded: segments.map(s => s.idx), complete: segments.filter(s => s.transcribeStatus === 'complete').length,
    failed: segments.filter(s => s.transcribeStatus === 'failed').length, total: job.segmentCount,
  });
  if (request.method === 'DELETE' && !action) {
    if (meeting.status === 'complete') return json('Import already completed', 409);
    await db.batch([
      db.update(recordingImports).set({ state: 'cancelled' }).where(eq(recordingImports.meetingId, id)),
      db.update(meetings).set({ status: 'failed', statusError: 'Import cancelled', updatedAt: Date.now() }).where(eq(meetings.id, id)),
    ]);
    return Response.json({ ok: true });
  }
  if (request.method === 'POST' && action === 'resume' && job.state === 'cancelled') {
    await db.batch([
      db.update(recordingImports).set({ state: 'uploading' }).where(eq(recordingImports.meetingId, id)),
      db.update(meetings).set({ status: 'uploading', statusError: null, updatedAt: Date.now() }).where(eq(meetings.id, id)),
    ]);
    return Response.json({ ok: true });
  }
  if (job.state === 'cancelled') return json('Import cancelled. Select the file again to resume.', 409);
  if (request.method === 'PUT' && action === 'segments') {
    if (job.state !== 'uploading') return json('Upload already finalized', 409);
    const idx = Number(indexText);
    if (!Number.isInteger(idx) || idx < 0 || idx >= job.segmentCount) return json('Invalid segment index');
    if (segments.some(s => s.idx === idx)) return Response.json({ ok: true, duplicate: true });
    let audio: Uint8Array;
    try { audio = await boundedBody(request, 44 + SAMPLE_RATE * SEGMENT_SECONDS * 2); }
    catch (error) { if (error instanceof UploadTooLarge) return json('Segment too large', 413); throw error; }
    let durationMs: number;
    try { durationMs = wavDurationMs(audio); } catch { return json('Invalid audio segment'); }
    const expectedMs = Math.min(SEGMENT_SECONDS * 1000, job.durationMs - idx * SEGMENT_SECONDS * 1000);
    if (Math.abs(durationMs - expectedMs) > 1) return json('Segment duration mismatch');
    const r2Key = `users/${userId}/meetings/${id}/import/${idx}.wav`;
    await env.AUDIO_BUCKET.put(r2Key, audio, { httpMetadata: { contentType: 'audio/wav' } });
    await db.insert(meetingSegments).values({ id: `import_${id}_${idx}`, meetingId: id, idx, track: 'mixed', r2Key, bytes: audio.length, offsetMs: idx * SEGMENT_SECONDS * 1000, durationMs, transcribeStatus: 'pending', createdAt: Date.now() }).onConflictDoNothing();
    return Response.json({ ok: true }, { status: 202 });
  }
  if (request.method === 'PUT' && action === 'archive') {
    if (job.state !== 'uploading') return json('Upload already finalized', 409);
    const formats: Record<string, 'm4a' | 'wav' | 'mp3' | 'webm' | 'opus'> = { 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'opus' };
    const contentType = (request.headers.get('content-type') ?? '').split(';')[0];
    const format = formats[contentType];
    const size = Number(request.headers.get('content-length'));
    if (!format || !Number.isSafeInteger(size) || size <= 0 || size > MAX_IMPORT_BYTES || !request.body) return json('Unsupported archive format or size');
    const key = `users/${userId}/meetings/${id}/import/original.${format}`;
    // Request bodies carry a known length in Workers; R2 streams without buffering.
    const stored = await env.AUDIO_BUCKET.put(key, request.body as unknown as Parameters<ProcessingEnv['AUDIO_BUCKET']['put']>[1], { httpMetadata: { contentType } });
    if (stored.size !== size) {
      await env.AUDIO_BUCKET.delete(key);
      return json('Archive byte count does not match declared length');
    }
    await db.update(meetings).set({ audioR2Key: key, audioFormat: format, audioBytes: size, updatedAt: Date.now() }).where(eq(meetings.id, id));
    return Response.json({ ok: true });
  }
  if (request.method === 'POST' && (action === 'finalize' || action === 'retry')) {
    if (meeting.status === 'complete' && !(action === 'retry' && segments.some(s => s.transcribeStatus === 'failed'))) return Response.json({ ok: true, duplicate: true });
    if (segments.length !== job.segmentCount || segments.some((s, i) => s.idx !== i) || !meeting.audioR2Key) return json('Upload all segments and the original audio first', 409);
    if (action === 'retry') await db.update(meetingSegments).set({ transcribeStatus: 'pending' }).where(and(eq(meetingSegments.meetingId, id), eq(meetingSegments.transcribeStatus, 'failed')));
    await db.batch([
      db.update(recordingImports).set({ state: 'processing' }).where(and(eq(recordingImports.meetingId, id), ne(recordingImports.state, 'cancelled'))),
      db.update(meetings).set({ status: 'processing', statusError: null, durationSec: Math.round(job.durationMs / 1000), audioDurationSec: Math.round(job.durationMs / 1000), endedAt: Date.now(), updatedAt: Date.now() }).where(and(eq(meetings.id, id), isNull(meetings.deletedAt), sql`EXISTS (SELECT 1 FROM recording_imports WHERE meeting_id = ${id} AND state = 'processing')`)),
    ]);
    const active = (await db.select().from(recordingImports).where(eq(recordingImports.meetingId, id)).limit(1))[0];
    const activeMeeting = (await db.select().from(meetings).where(eq(meetings.id, id)).limit(1))[0];
    if (active?.state !== 'processing' || activeMeeting?.status !== 'processing' || activeMeeting.deletedAt) return json('Import is no longer active', 409);
    // Re-publishing restores handoff after a partial Queue failure. Consumers are idempotent.
    const messages: { body: QueueMessage }[] = segments
      .filter(segment => segment.transcribeStatus !== 'complete')
      .map(segment => ({ body: { kind: 'transcribe-segment', meetingId: id, idx: segment.idx } }));
    messages.push({ body: { kind: 'summarize', meetingId: id } });
    // sendBatch takes at most 100 messages per call.
    for (let i = 0; i < messages.length; i += 100) await env.PROCESSING_QUEUE.sendBatch(messages.slice(i, i + 100));
    return Response.json({ ok: true, status: 'processing' }, { status: 202 });
  }
  return json('Unknown import operation', 404);
}

async function boundedBody(request: Request, max: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing upload body');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > max) throw new UploadTooLarge('Upload too large'); chunks.push(chunk.value); }
  } finally { await reader.cancel(); }
  const out = new Uint8Array(length); let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
