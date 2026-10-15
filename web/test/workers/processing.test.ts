import { env } from 'cloudflare:workers';
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
} from 'cloudflare:test';
import type { D1Database, Queue, R2Bucket } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { worker, type Env } from '../../../workers/processing/src/index';
import * as templatesRepo from '../../src/db/repo/templates';
import * as dbSchema from '../../src/db/schema';
import type { ProcessingMessage } from '../../src/server/processing-worker';
import { Route as MetricsRoute } from '../../src/routes/api/ops/metrics';
import { Route as TranscribeRoute } from '../../src/routes/api/transcribe';
import { Route as SegmentRoute } from '../../src/routes/api/sessions/$id/segments/$idx';
import { Route as FinalizeRoute } from '../../src/routes/api/sessions/$id/finalize/index';
import { Route as FilesRoute } from '../../src/routes/api/sessions/$id/files';
import { Route as ResultRoute } from '../../src/routes/api/sessions/$id/result';

interface TestEnv {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM product_metrics_daily'),
    testEnv.DB.prepare('DELETE FROM activity_log'),
    testEnv.DB.prepare('DELETE FROM transcript_segments'),
    testEnv.DB.prepare('DELETE FROM meeting_segments'),
    testEnv.DB.prepare('DELETE FROM meeting_uploads'),
    testEnv.DB.prepare('DELETE FROM meetings'),
    testEnv.DB.prepare('DELETE FROM prompt_templates'),
    testEnv.DB.prepare('DELETE FROM device_pairing_codes'),
    testEnv.DB.prepare('DELETE FROM device_tokens'),
    testEnv.DB.prepare('DELETE FROM devices'),
    testEnv.DB.prepare('DELETE FROM users'),
  ]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('desktop transcription authentication', () => {
  it('accepts a paired device token and rejects missing or revoked credentials', async () => {
    const unauthenticated = await transcribePost({
      request: transcribeRequest('', new Uint8Array()),
      params: {},
    });
    expect(unauthenticated.status).toBe(401);

    const token = await insertDeviceActor('user_transcribe_auth', 'device_transcribe_auth');
    const authenticated = await transcribePost({
      request: transcribeRequest(token, new Uint8Array()),
      params: {},
    });
    expect(authenticated.status).toBe(400);
    expect(await authenticated.json()).toEqual({ error: 'empty audio' });

    await testEnv.DB.prepare(
      'UPDATE device_tokens SET revoked_at = ? WHERE device_id = ?',
    )
      .bind(Date.now(), 'device_transcribe_auth')
      .run();
    const revoked = await transcribePost({
      request: transcribeRequest(token, new Uint8Array()),
      params: {},
    });
    expect(revoked.status).toBe(401);
  });
});

describe('template ownership', () => {
  it('does not update or delete another user\'s template', async () => {
    await insertUser('user_template_owner');
    await insertUser('user_template_other');
    await testEnv.DB.prepare(
      `INSERT INTO prompt_templates
        (id, user_id, name, system_prompt, applies_to, is_default, sort_order)
       VALUES (?, ?, ?, ?, 'meeting', 0, 0)`,
    )
      .bind(
        'tpl_private',
        'user_template_owner',
        'Private template',
        'Keep this private.',
      )
      .run();

    const db = drizzle(testEnv.DB, { schema: dbSchema });
    await templatesRepo.update(db, {
      id: 'tpl_private',
      userId: 'user_template_other',
      name: 'Hijacked template',
    });
    expect(
      await row<{ name: string }>('SELECT name FROM prompt_templates WHERE id = ?', 'tpl_private'),
    ).toEqual({ name: 'Private template' });

    await templatesRepo.remove(db, {
      id: 'tpl_private',
      userId: 'user_template_other',
    });
    expect(
      await row<{ id: string }>('SELECT id FROM prompt_templates WHERE id = ?', 'tpl_private'),
    ).toEqual({ id: 'tpl_private' });
  });
});

describe('processing queue orchestration', () => {
  it('acks cleanup only after deleting both the object and meeting', async () => {
    await insertUser('user_cleanup');
    await insertMeeting({
      id: 'meet_cleanup',
      userId: 'user_cleanup',
      status: 'complete',
      audioR2Key: 'anonymous/user_cleanup/meet_cleanup.m4a',
    });
    await testEnv.AUDIO_BUCKET.put('anonymous/user_cleanup/meet_cleanup.m4a', new Uint8Array([1]));

    const batch = createMessageBatch<ProcessingMessage>('eavesy-processing', [
      queueMessage('cleanup-1', { kind: 'cleanup-anonymous', meetingId: 'meet_cleanup' }),
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, runtimeEnv());

    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['cleanup-1']);
    expect(result.retryMessages).toEqual([]);
    expect(await testEnv.AUDIO_BUCKET.head('anonymous/user_cleanup/meet_cleanup.m4a')).toBeNull();
    expect(await row<{ id: string }>('SELECT id FROM meetings WHERE id = ?', 'meet_cleanup')).toBeNull();
  });

  it('keeps a failed transcription pending until the terminal attempt', async () => {
    await insertUser('user_retry');
    await insertMeeting({ id: 'meet_retry', userId: 'user_retry', status: 'uploading' });
    await insertSegment({
      id: 'mseg_retry',
      meetingId: 'meet_retry',
      idx: 0,
      r2Key: 'users/user_retry/meetings/meet_retry/segments/missing.m4a',
    });

    const batch = createMessageBatch<ProcessingMessage>('eavesy-processing', [
      queueMessage('transcribe-1', { kind: 'transcribe-segment', meetingId: 'meet_retry', idx: 0 }),
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, runtimeEnv());

    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'transcribe-1' }]);
    expect(
      await row<{ transcribe_status: string }>(
        'SELECT transcribe_status FROM meeting_segments WHERE id = ?',
        'mseg_retry',
      ),
    ).toEqual({ transcribe_status: 'pending' });
    const terminal = createMessageBatch<ProcessingMessage>('eavesy-processing', [
      { ...queueMessage('transcribe-terminal', { kind: 'transcribe-segment', meetingId: 'meet_retry', idx: 0 }), attempts: 5 },
    ]);
    const terminalCtx = createExecutionContext();
    await worker.queue(terminal, runtimeEnv());
    expect((await getQueueResult(terminal, terminalCtx)).explicitAcks).toEqual(['transcribe-terminal']);
    expect(await row<{ transcribe_status: string }>('SELECT transcribe_status FROM meeting_segments WHERE id = ?', 'mseg_retry'))
      .toEqual({ transcribe_status: 'failed' });
  });

  it('persists transcript output before acknowledging and schedules rolling notes', async () => {
    await insertUser('user_transcribe');
    await insertMeeting({ id: 'meet_transcribe', userId: 'user_transcribe', status: 'uploading' });
    const key = 'users/user_transcribe/meetings/meet_transcribe/segments/000002.m4a';
    await insertSegment({
      id: 'mseg_transcribe',
      meetingId: 'meet_transcribe',
      idx: 2,
      r2Key: key,
      // Ends at 4:01, crossing the first rolling-notes boundary.
      offsetMs: 238_000,
    });
    await testEnv.AUDIO_BUCKET.put(key, new Uint8Array([1, 2, 3]));

    const queue = mockQueue();
    const ai = {
      run: vi.fn(async () => ({
        text: 'A durable transcript',
        segments: [{ start: 1, end: 3, text: 'A durable transcript' }],
        transcription_info: { language: 'en', duration: 3 },
      })),
    };
    const batch = createMessageBatch<ProcessingMessage>('eavesy-processing', [
      queueMessage('transcribe-2', { kind: 'transcribe-segment', meetingId: 'meet_transcribe', idx: 2 }),
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, runtimeEnv(queue.binding, ai));

    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['transcribe-2']);
    expect(
      await row<{ start_ms: number; end_ms: number; text: string }>(
        'SELECT start_ms, end_ms, text FROM transcript_segments WHERE meeting_id = ?',
        'meet_transcribe',
      ),
    ).toEqual({ start_ms: 239_000, end_ms: 241_000, text: 'A durable transcript' });
    expect(
      await row<{ transcribe_status: string }>(
        'SELECT transcribe_status FROM meeting_segments WHERE id = ?',
        'mseg_transcribe',
      ),
    ).toEqual({ transcribe_status: 'complete' });
    const stamped = await row<{ first_transcript_at: number | null; started_at: number }>(
      'SELECT first_transcript_at, started_at FROM meetings WHERE id = ?',
      'meet_transcribe',
    );
    expect(stamped?.first_transcript_at).toBeGreaterThanOrEqual(stamped?.started_at ?? Infinity);
    expect(queue.send).toHaveBeenCalledWith({
      kind: 'rolling-summarize',
      meetingId: 'meet_transcribe',
      throughIdx: 2,
      throughMs: 241_000,
    });
  });

  it('marks a meeting failed before acknowledging a terminal DLQ message', async () => {
    await insertUser('user_dlq');
    await insertMeeting({ id: 'meet_dlq', userId: 'user_dlq', status: 'processing' });

    const batch = createMessageBatch<ProcessingMessage>('eavesy-processing-dlq', [
      queueMessage('dlq-1', { kind: 'summarize', meetingId: 'meet_dlq' }),
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, runtimeEnv());

    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['dlq-1']);
    expect(result.retryMessages).toEqual([]);
    expect(
      await row<{ status: string; status_error: string }>(
        'SELECT status, status_error FROM meetings WHERE id = ?',
        'meet_dlq',
      ),
    ).toEqual({
      status: 'failed',
      status_error:
        'Automatic summarize processing failed after retries. The uploaded recording has been preserved.',
    });
  });

  it('does not record a false failure for a late DLQ duplicate', async () => {
    await insertUser('user_dlq_complete');
    await insertMeeting({ id: 'meet_dlq_complete', userId: 'user_dlq_complete', status: 'complete' });

    const batch = createMessageBatch<ProcessingMessage>('eavesy-processing-dlq', [
      queueMessage('dlq-late', { kind: 'summarize', meetingId: 'meet_dlq_complete' }),
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, runtimeEnv());

    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['dlq-late']);
    expect(
      await row<{ count: number }>(
        `SELECT count(*) AS count FROM activity_log
          WHERE meeting_id = ? AND event_type = 'meeting.fail'`,
        'meet_dlq_complete',
      ),
    ).toEqual({ count: 0 });
  });

  it('completes a long-form summary, records the funnel event, and schedules embedding', async () => {
    await insertUser('user_summary');
    await insertMeeting({ id: 'meet_summary', userId: 'user_summary', status: 'processing' });
    await testEnv.DB.prepare(
      `INSERT INTO transcript_segments
        (id, meeting_id, start_ms, end_ms, text, is_edited, is_final)
       VALUES ('tseg_summary', 'meet_summary', 0, 1000, 'Final transcript', 0, 1)`,
    ).run();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                title: 'Durable Long Form Result',
                description: 'The finalizer completed.',
                tldr: 'Summary complete.',
                decisions: [],
                actionItems: [],
                followUps: [],
                openQuestions: [],
                topics: [],
                mentions: [],
              }),
            },
          ],
        }),
      ),
    );
    const queue = mockQueue();
    const batch = createMessageBatch<ProcessingMessage>('eavesy-processing', [
      queueMessage('summary-1', { kind: 'summarize', meetingId: 'meet_summary' }),
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, runtimeEnv(queue.binding));

    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['summary-1']);
    expect(
      await row<{ status: string; title: string }>(
        'SELECT status, title FROM meetings WHERE id = ?',
        'meet_summary',
      ),
    ).toEqual({ status: 'complete', title: 'Durable Long Form Result' });
    expect(
      await row<{ event_type: string }>(
        `SELECT event_type FROM activity_log
          WHERE meeting_id = ? AND event_type = 'meeting.complete'`,
        'meet_summary',
      ),
    ).toEqual({ event_type: 'meeting.complete' });
    expect(queue.send).toHaveBeenCalledWith({ kind: 'embed', meetingId: 'meet_summary' });
  });

  it("bills the user's own Anthropic key for the meeting summary", async () => {
    await insertUser('user_byo');
    await testEnv.DB.prepare(`UPDATE users SET byo_anthropic_key = 'sk-ant-user' WHERE id = ?`)
      .bind('user_byo')
      .run();
    await insertMeeting({ id: 'meet_byo', userId: 'user_byo', status: 'processing' });
    await testEnv.DB.prepare(
      `INSERT INTO transcript_segments
        (id, meeting_id, start_ms, end_ms, text, is_edited, is_final)
       VALUES ('tseg_byo', 'meet_byo', 0, 1000, 'Final transcript', 0, 1)`,
    ).run();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              title: 'BYO',
              description: '',
              tldr: 'Done.',
              decisions: [],
              actionItems: [],
              followUps: [],
              openQuestions: [],
              topics: [],
              mentions: [],
            }),
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const queue = mockQueue();
    const batch = createMessageBatch<ProcessingMessage>('eavesy-processing', [
      queueMessage('summary-byo', { kind: 'summarize', meetingId: 'meet_byo' }),
    ]);
    await worker.queue(batch, runtimeEnv(queue.binding));

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-api-key')).toBe('sk-ant-user');
    expect(
      await row<{ generated_by_model: string }>(
        'SELECT generated_by_model FROM summaries WHERE meeting_id = ?',
        'meet_byo',
      ),
    ).toEqual({ generated_by_model: 'byo-anthropic:claude-sonnet-4-6' });
  });

  it('processes a browser recording asynchronously and makes replay a no-op', async () => {
    await insertUser('user_web');
    const key = 'users/user_web/meetings/meet_web.webm';
    await insertMeeting({
      id: 'meet_web',
      userId: 'user_web',
      status: 'processing',
      audioR2Key: key,
    });
    await testEnv.AUDIO_BUCKET.put(key, new Uint8Array([1, 2, 3, 4]));

    const ai = {
      run: vi.fn(async () => ({
        text: 'Browser transcript',
        segments: [{ start: 0, end: 2, text: 'Browser transcript' }],
        transcription_info: { language: 'en', duration: 2 },
      })),
    };
    const summaryFetch = vi.fn(async () =>
      Response.json({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              title: 'Async Browser Recording Result',
              description: 'Processed outside the upload request.',
              tldr: 'The queued pipeline completed.',
              decisions: [],
              actionItems: [],
              followUps: [],
              openQuestions: [],
              topics: ['testing'],
              mentions: [],
            }),
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', summaryFetch);
    const queue = mockQueue();
    const firstBatch = createMessageBatch<ProcessingMessage>('eavesy-processing', [
      queueMessage('web-1', { kind: 'process-recording', meetingId: 'meet_web' }),
    ]);
    const firstCtx = createExecutionContext();
    await worker.queue(firstBatch, runtimeEnv(queue.binding, ai));

    expect((await getQueueResult(firstBatch, firstCtx)).explicitAcks).toEqual(['web-1']);
    expect(
      await row<{ status: string; title: string; audio_duration_sec: number }>(
        'SELECT status, title, audio_duration_sec FROM meetings WHERE id = ?',
        'meet_web',
      ),
    ).toEqual({
      status: 'complete',
      title: 'Async Browser Recording Result',
      audio_duration_sec: 2,
    });
    expect(
      await row<{ text: string }>(
        'SELECT text FROM transcript_segments WHERE meeting_id = ?',
        'meet_web',
      ),
    ).toEqual({ text: 'Browser transcript' });
    expect(
      await row<{ tldr: string }>('SELECT tldr FROM summaries WHERE meeting_id = ?', 'meet_web'),
    ).toEqual({ tldr: 'The queued pipeline completed.' });
    expect(queue.send).toHaveBeenCalledWith({ kind: 'embed', meetingId: 'meet_web' });

    const replayBatch = createMessageBatch<ProcessingMessage>('eavesy-processing', [
      queueMessage('web-2', { kind: 'process-recording', meetingId: 'meet_web' }),
    ]);
    const replayCtx = createExecutionContext();
    await worker.queue(replayBatch, runtimeEnv(queue.binding, ai));
    expect((await getQueueResult(replayBatch, replayCtx)).explicitAcks).toEqual(['web-2']);
    expect(summaryFetch).toHaveBeenCalledTimes(1);
    expect(
      await row<{ count: number }>(
        'SELECT count(*) AS count FROM transcript_segments WHERE meeting_id = ?',
        'meet_web',
      ),
    ).toEqual({ count: 1 });
  });
});

describe('processing cron recovery', () => {
  it('purges expired pairing codes and requeues expired and abandoned work', async () => {
    const now = Date.now();
    await insertUser('user_cron');
    await insertMeeting({
      id: 'meet_expired',
      userId: 'user_cron',
      status: 'complete',
      expiresAt: now - 1,
      createdAt: now - 2 * 24 * 60 * 60 * 1_000,
      endedAt: now - 7_000,
    });
    await insertMeeting({
      id: 'meet_abandoned',
      userId: 'user_cron',
      status: 'recording',
      updatedAt: now - 31 * 60 * 1_000,
    });
    await insertMeeting({
      id: 'meet_fresh',
      userId: 'user_cron',
      status: 'recording',
      updatedAt: now,
    });
    await insertMeeting({
      id: 'meet_browser_delayed',
      userId: 'user_cron',
      status: 'processing',
      source: 'web',
      audioR2Key: 'users/user_cron/meetings/meet_browser_delayed.webm',
      updatedAt: now - 6 * 60 * 1_000,
    });
    await insertMeeting({
      id: 'meet_stuck',
      userId: 'user_cron',
      status: 'processing',
      updatedAt: now - 31 * 60 * 1_000,
    });
    await insertMeeting({
      id: 'meet_brief_two',
      userId: 'user_cron',
      status: 'complete',
      createdAt: now - 4_000,
    });
    await insertUser('user_cron_second');
    await insertMeeting({
      id: 'meet_second_user',
      userId: 'user_cron_second',
      status: 'complete',
      createdAt: now - 4_000,
    });
    await insertUser('user_cron_late_return');
    await insertMeeting({
      id: 'meet_late_first',
      userId: 'user_cron_late_return',
      status: 'complete',
      createdAt: now - 8 * 24 * 60 * 60 * 1_000,
    });
    await insertMeeting({
      id: 'meet_late_return',
      userId: 'user_cron_late_return',
      status: 'recording',
      createdAt: now - 4_000,
    });
    await insertSegment({ id: 'mseg_abandoned', meetingId: 'meet_abandoned', idx: 0 });
    await insertSegment({ id: 'mseg_fresh', meetingId: 'meet_fresh', idx: 0 });
    // Streamed recordings with a first transcript line 4s and 2s after start;
    // meet_expired has no segments, so its latency is excluded.
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE meetings SET started_at = ?, first_transcript_at = ? WHERE id = ?')
        .bind(now - 5_000, now - 1_000, 'meet_abandoned'),
      testEnv.DB.prepare('UPDATE meetings SET started_at = ?, first_transcript_at = ? WHERE id = ?')
        .bind(now - 4_000, now - 2_000, 'meet_fresh'),
      testEnv.DB.prepare('UPDATE meetings SET first_transcript_at = ? WHERE id = ?')
        .bind(now - 1_000, 'meet_expired'),
    ]);
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO activity_log
          (id, user_id, event_type, meeting_id, metadata_json, created_at)
         VALUES (?, ?, 'meeting.complete', ?, '{}', ?)`,
      ).bind('act_complete', 'user_cron', 'meet_expired', now - 2_000),
      testEnv.DB.prepare(
        `INSERT INTO activity_log
          (id, user_id, event_type, meeting_id, metadata_json, created_at)
         VALUES (?, ?, 'meeting.copy', ?, '{}', ?)`,
      ).bind('act_copy', 'user_cron', 'meet_expired', now - 1_000),
      testEnv.DB.prepare(
        `INSERT INTO activity_log
          (id, user_id, event_type, meeting_id, metadata_json, created_at)
         VALUES (?, ?, 'meeting.export', ?, '{}', ?)`,
      ).bind('act_incomplete_export', 'user_cron', 'meet_fresh', now - 1_000),
      testEnv.DB.prepare(
        `INSERT INTO activity_log
          (id, user_id, event_type, meeting_id, metadata_json, created_at)
         VALUES (?, ?, 'meeting.complete', ?, '{}', ?)`,
      ).bind('act_complete_two', 'user_cron', 'meet_brief_two', now - 3_000),
      testEnv.DB.prepare(
        `INSERT INTO activity_log
          (id, user_id, event_type, meeting_id, metadata_json, created_at)
         VALUES (?, ?, 'meeting.copy', ?, '{}', ?)`,
      ).bind('act_copy_two', 'user_cron', 'meet_brief_two', now - 1_000),
      testEnv.DB.prepare(
        `INSERT INTO activity_log
          (id, user_id, event_type, meeting_id, metadata_json, created_at)
         VALUES (?, ?, 'meeting.complete', ?, '{}', ?)`,
      ).bind('act_second_complete', 'user_cron_second', 'meet_second_user', now - 2_000),
    ]);
    await testEnv.DB.prepare(
      `INSERT INTO device_pairing_codes
        (code_hash, device_id, name, root_folder_path, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind('expired-code', 'device-1', 'Test Mac', '/tmp', now - 1, now - 10_000)
      .run();

    const queue = mockQueue();
    const controller = createScheduledController({ scheduledTime: new Date(now), cron: '0 * * * *' });
    await worker.scheduled(controller, runtimeEnv(queue.binding));

    expect(queue.send).toHaveBeenCalledWith({
      kind: 'cleanup-anonymous',
      meetingId: 'meet_expired',
    });
    expect(queue.send).toHaveBeenCalledWith({ kind: 'summarize', meetingId: 'meet_abandoned' });
    expect(queue.send).toHaveBeenCalledWith({
      kind: 'process-recording',
      meetingId: 'meet_browser_delayed',
    });
    expect(
      await row<{ status: string }>('SELECT status FROM meetings WHERE id = ?', 'meet_abandoned'),
    ).toEqual({ status: 'processing' });
    expect(await row<{ status: string }>('SELECT status FROM meetings WHERE id = ?', 'meet_fresh')).toEqual({
      status: 'recording',
    });
    expect(
      await row<{ code_hash: string }>(
        'SELECT code_hash FROM device_pairing_codes WHERE code_hash = ?',
        'expired-code',
      ),
    ).toBeNull();
    expect(
      await row<{
        signups: number;
        users_first_recording: number;
        users_first_transcript: number;
        users_first_brief_use: number;
        users_first_return_7d: number;
        meetings_started: number;
        meetings_completed: number;
        meetings_brief_used: number;
        meetings_failed: number;
        meetings_stuck: number;
        processing_samples: number;
        processing_ms_total: number;
        processing_ms_max: number;
        first_transcript_samples: number;
        first_transcript_ms_total: number;
        first_transcript_ms_max: number;
        audio_seconds: number;
        estimated_ai_cost_microusd: number;
      }>(
        `SELECT signups, users_first_recording, users_first_transcript,
                users_first_brief_use, meetings_started, meetings_completed,
                users_first_return_7d, meetings_brief_used, meetings_failed,
                meetings_stuck, processing_samples, processing_ms_total,
                processing_ms_max, first_transcript_samples,
                first_transcript_ms_total, first_transcript_ms_max,
                audio_seconds, estimated_ai_cost_microusd
           FROM product_metrics_daily
          WHERE date = ?`,
        new Date(now).toISOString().slice(0, 10),
      ),
    ).toEqual({
      signups: 3,
      users_first_recording: 1,
      users_first_transcript: 2,
      users_first_brief_use: 1,
      users_first_return_7d: 1,
      meetings_started: 7,
      meetings_completed: 3,
      meetings_brief_used: 2,
      meetings_failed: 0,
      meetings_stuck: 1,
      processing_samples: 1,
      processing_ms_total: 5_000,
      processing_ms_max: 5_000,
      first_transcript_samples: 2,
      first_transcript_ms_total: 6_000,
      first_transcript_ms_max: 4_000,
      audio_seconds: 0,
      estimated_ai_cost_microusd: 0,
    });
  });
});

describe('private operational metrics', () => {
  it('rejects unauthenticated requests and returns only aggregate rows', async () => {
    const now = Date.now();
    await testEnv.DB.prepare(
      `INSERT INTO product_metrics_daily
        (date, signups, meetings_started, updated_at)
       VALUES (?, 2, 3, ?)`,
    )
      .bind(new Date(now).toISOString().slice(0, 10), now)
      .run();

    const unauthorized = await metricsGet({
      request: new Request('https://eavesy.test/api/ops/metrics'),
      params: {},
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await metricsGet({
      request: new Request('https://eavesy.test/api/ops/metrics?days=7', {
        headers: { authorization: 'Bearer test-metrics-token' },
      }),
      params: {},
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({
      rows: [{
        signups: 2,
        users_first_brief_use: 0,
        users_first_return_7d: 0,
        meetings_started: 3,
        meetings_brief_used: 0,
        processing_samples: 0,
        average_processing_ms: 0,
        first_transcript_samples: 0,
        average_first_transcript_ms: 0,
      }],
      pricingAssumptions: { whisperUsdPerMinute: 0.00051 },
    });
  });
});

describe('desktop ingest replay safety', () => {
  it('round-trips device-authenticated external Markdown edits without cross-user access', async () => {
    const ownerToken = await insertDeviceActor('user_file_owner', 'device_file_owner');
    const otherToken = await insertDeviceActor('user_file_other', 'device_file_other');
    await insertMeeting({ id: 'meet_file_edit', userId: 'user_file_owner', status: 'complete' });

    const unauthorized = await filesPatch({
      request: fileEditRequest('meet_file_edit', '', 'summary', '# Private edit'),
      params: { id: 'meet_file_edit' },
    });
    expect(unauthorized.status).toBe(401);

    const crossUser = await filesPatch({
      request: fileEditRequest('meet_file_edit', otherToken, 'summary', '# Wrong owner'),
      params: { id: 'meet_file_edit' },
    });
    expect(crossUser.status).toBe(404);

    const summary = await filesPatch({
      request: fileEditRequest('meet_file_edit', ownerToken, 'summary', '# Edited brief\n\nShip it.'),
      params: { id: 'meet_file_edit' },
    });
    expect(summary.status).toBe(200);

    const notes = await filesPatch({
      request: fileEditRequest(
        'meet_file_edit',
        ownerToken,
        'notes',
        '---\nid: meet_file_edit\n---\n\n# Notes\n\nRemember the launch date.',
      ),
      params: { id: 'meet_file_edit' },
    });
    expect(notes.status).toBe(200);

    expect(
      await row<{ summary_override_md: string }>(
        'SELECT summary_override_md FROM meetings WHERE id = ?',
        'meet_file_edit',
      ),
    ).toEqual({ summary_override_md: '# Edited brief\n\nShip it.' });
    expect(
      await row<{ content_md: string }>(
        'SELECT content_md FROM user_notes WHERE meeting_id = ?',
        'meet_file_edit',
      ),
    ).toEqual({ content_md: 'Remember the launch date.' });

    const result = await resultGet({
      request: new Request('https://eavesy.test/api/sessions/meet_file_edit/result', {
        headers: { authorization: `Bearer ${ownerToken}` },
      }),
      params: { id: 'meet_file_edit' },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      summaryOverrideMd: '# Edited brief\n\nShip it.',
      notesMd: 'Remember the launch date.',
    });
  });

  it('rejects unauthenticated, cross-user, and empty segment uploads without side effects', async () => {
    const ownerToken = await insertDeviceActor('user_ingest_owner', 'device_ingest_owner');
    const otherToken = await insertDeviceActor('user_ingest_other', 'device_ingest_other');
    await insertMeeting({
      id: 'meet_ingest_guard',
      userId: 'user_ingest_other',
      status: 'recording',
    });

    const unauthorized = await segmentPut({
      request: new Request(
        'https://eavesy.test/api/sessions/meet_ingest_guard/segments/0',
        { method: 'PUT' },
      ),
      params: { id: 'meet_ingest_guard', idx: '0' },
    });
    expect(unauthorized.status).toBe(401);

    const crossUser = await segmentPut({
      request: segmentRequest('meet_ingest_guard', 0, ownerToken, new Uint8Array([1, 2, 3])),
      params: { id: 'meet_ingest_guard', idx: '0' },
    });
    expect(crossUser.status).toBe(404);

    const empty = await segmentPut({
      request: segmentRequest('meet_ingest_guard', 0, otherToken, new Uint8Array()),
      params: { id: 'meet_ingest_guard', idx: '0' },
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'empty_segment' });

    expect(
      await row<{ count: number }>(
        'SELECT count(*) AS count FROM meeting_segments WHERE meeting_id = ?',
        'meet_ingest_guard',
      ),
    ).toEqual({ count: 0 });
    expect(
      await testEnv.AUDIO_BUCKET.head(
        'users/user_ingest_other/meetings/meet_ingest_guard/segments/000000.m4a',
      ),
    ).toBeNull();
  });

  it('rejects an empty final archive part without creating multipart state', async () => {
    const rawToken = await insertDeviceActor('user_finalize_empty', 'device_finalize_empty');
    await insertMeeting({
      id: 'meet_finalize_empty',
      userId: 'user_finalize_empty',
      status: 'uploading',
    });

    const response = await finalizePost({
      request: finalizeRequest('meet_finalize_empty', rawToken, new Uint8Array()),
      params: { id: 'meet_finalize_empty' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_final_part' });
    expect(
      await row<{ count: number }>(
        'SELECT count(*) AS count FROM meeting_uploads WHERE meeting_id = ?',
        'meet_finalize_empty',
      ),
    ).toEqual({ count: 0 });
  });

  it('stores a segment once and returns the same handoff on replay', async () => {
    const rawToken = await insertDeviceActor('user_segment', 'device_segment');
    await insertMeeting({ id: 'meet_segment', userId: 'user_segment', status: 'recording' });

    const firstRequest = segmentRequest('meet_segment', 0, rawToken, new Uint8Array([1, 2, 3, 4]));
    const first = await segmentPut({
      request: firstRequest,
      params: { id: 'meet_segment', idx: '0' },
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ ok: true, nextSegmentIdx: 1 });

    const replay = await segmentPut({
      request: segmentRequest('meet_segment', 0, rawToken, new Uint8Array([9, 9, 9, 9])),
      params: { id: 'meet_segment', idx: '0' },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, idempotent: true, nextSegmentIdx: 1 });

    expect(
      await row<{ count: number }>(
        'SELECT count(*) AS count FROM meeting_segments WHERE meeting_id = ?',
        'meet_segment',
      ),
    ).toEqual({ count: 1 });
    const key = 'users/user_segment/meetings/meet_segment/segments/000000.m4a';
    const object = await testEnv.AUDIO_BUCKET.get(key);
    expect(object).not.toBeNull();
    expect(Array.from(new Uint8Array(await object!.arrayBuffer()))).toEqual([1, 2, 3, 4]);
    expect(await row<{ status: string }>('SELECT status FROM meetings WHERE id = ?', 'meet_segment')).toEqual({
      status: 'uploading',
    });
  });

  it('completes the archive once and makes finalize replay idempotent', async () => {
    const rawToken = await insertDeviceActor('user_finalize', 'device_finalize');
    await insertMeeting({ id: 'meet_finalize', userId: 'user_finalize', status: 'uploading' });
    await insertSegment({
      id: 'mseg_finalize',
      meetingId: 'meet_finalize',
      idx: 0,
      offsetMs: 0,
    });

    const first = await finalizePost({
      request: finalizeRequest('meet_finalize', rawToken, new Uint8Array([4, 5, 6, 7, 8])),
      params: { id: 'meet_finalize' },
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, status: 'processing', audioBytes: 5 });

    const archiveKey = 'users/user_finalize/meetings/meet_finalize/audio.m4a';
    const archive = await testEnv.AUDIO_BUCKET.get(archiveKey);
    expect(archive).not.toBeNull();
    expect(Array.from(new Uint8Array(await archive!.arrayBuffer()))).toEqual([4, 5, 6, 7, 8]);
    expect(
      await row<{ state: string; next_part_number: number }>(
        'SELECT state, next_part_number FROM meeting_uploads WHERE meeting_id = ?',
        'meet_finalize',
      ),
    ).toEqual({ state: 'complete', next_part_number: 2 });
    expect(
      await row<{ status: string; audio_r2_key: string; audio_bytes: number }>(
        'SELECT status, audio_r2_key, audio_bytes FROM meetings WHERE id = ?',
        'meet_finalize',
      ),
    ).toEqual({ status: 'processing', audio_r2_key: archiveKey, audio_bytes: 5 });

    const replay = await finalizePost({
      request: finalizeRequest('meet_finalize', rawToken, new Uint8Array([99])),
      params: { id: 'meet_finalize' },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, idempotent: true, status: 'processing' });
    const replayedArchive = await testEnv.AUDIO_BUCKET.get(archiveKey);
    expect(Array.from(new Uint8Array(await replayedArchive!.arrayBuffer()))).toEqual([4, 5, 6, 7, 8]);
  });

  it('finalizes from uploaded segments when the desktop archive was lost', async () => {
    const rawToken = await insertDeviceActor('user_segments_only', 'device_segments_only');
    await insertMeeting({ id: 'meet_segments_only', userId: 'user_segments_only', status: 'uploading' });
    await insertSegment({ id: 'mseg_so_0', meetingId: 'meet_segments_only', idx: 0, offsetMs: 0 });
    await insertSegment({ id: 'mseg_so_1', meetingId: 'meet_segments_only', idx: 1, offsetMs: 3_000 });

    const first = await finalizePost({
      request: segmentsOnlyFinalizeRequest('meet_segments_only', rawToken),
      params: { id: 'meet_segments_only' },
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, status: 'processing' });
    const meeting = await row<{ status: string; audio_r2_key: string | null; ended_at: number | null }>(
      'SELECT status, audio_r2_key, ended_at FROM meetings WHERE id = ?',
      'meet_segments_only',
    );
    expect(meeting?.status).toBe('processing');
    expect(meeting?.audio_r2_key).toBeNull();
    expect(meeting?.ended_at).toBeGreaterThan(0);
    expect(
      await row<{ count: number }>(
        'SELECT count(*) AS count FROM meeting_uploads WHERE meeting_id = ?',
        'meet_segments_only',
      ),
    ).toEqual({ count: 0 });

    const replay = await finalizePost({
      request: segmentsOnlyFinalizeRequest('meet_segments_only', rawToken),
      params: { id: 'meet_segments_only' },
    });
    expect(await replay.json()).toMatchObject({ ok: true, idempotent: true, status: 'processing' });
  });

  it('refuses a segments-only finalize with nothing uploaded or with a body', async () => {
    const rawToken = await insertDeviceActor('user_segments_none', 'device_segments_none');
    await insertMeeting({ id: 'meet_segments_none', userId: 'user_segments_none', status: 'recording' });

    const empty = await finalizePost({
      request: segmentsOnlyFinalizeRequest('meet_segments_none', rawToken),
      params: { id: 'meet_segments_none' },
    });
    expect(empty.status).toBe(409);
    expect(await empty.json()).toEqual({ error: 'no_segments' });

    const withBody = new Request('https://eavesy.test/api/sessions/meet_segments_none/finalize?archive=none', {
      method: 'POST',
      headers: { authorization: `Bearer ${rawToken}` },
      body: requestBody(new Uint8Array([1])),
    });
    const rejected = await finalizePost({ request: withBody, params: { id: 'meet_segments_none' } });
    expect(rejected.status).toBe(400);
    expect(
      await row<{ status: string }>('SELECT status FROM meetings WHERE id = ?', 'meet_segments_none'),
    ).toEqual({ status: 'recording' });
  });
});

type RouteHandler = (args: {
  request: Request;
  params: Record<string, string>;
}) => Promise<Response>;

const segmentPut = (
  SegmentRoute.options as unknown as { server: { handlers: { PUT: RouteHandler } } }
).server.handlers.PUT;
const finalizePost = (
  FinalizeRoute.options as unknown as { server: { handlers: { POST: RouteHandler } } }
).server.handlers.POST;
const metricsGet = (
  MetricsRoute.options as unknown as { server: { handlers: { GET: RouteHandler } } }
).server.handlers.GET;
const filesPatch = (
  FilesRoute.options as unknown as { server: { handlers: { PATCH: RouteHandler } } }
).server.handlers.PATCH;
const resultGet = (
  ResultRoute.options as unknown as { server: { handlers: { GET: RouteHandler } } }
).server.handlers.GET;
const transcribePost = (
  TranscribeRoute.options as unknown as { server: { handlers: { POST: RouteHandler } } }
).server.handlers.POST;

function runtimeEnv(queue = mockQueue().binding, ai: { run: (model: string, input: unknown) => Promise<unknown> } = {
  run: async () => ({}),
}): Env {
  return {
    DB: testEnv.DB,
    AUDIO_BUCKET: testEnv.AUDIO_BUCKET,
    VECTORIZE: {} as Env['VECTORIZE'],
    PROCESSING_QUEUE: queue,
    AI: ai as Env['AI'],
    ANTHROPIC_API_KEY: 'test-only',
  };
}

function mockQueue() {
  const send = vi.fn(async () => undefined);
  return {
    send,
    binding: { send } as unknown as Queue<ProcessingMessage>,
  };
}

function queueMessage(id: string, body: ProcessingMessage) {
  return { id, timestamp: new Date(), attempts: 1, body };
}

async function insertUser(id: string) {
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO users
      (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at)
     VALUES (?, 'whisper', 'en', 0, ?, ?)`,
  )
    .bind(id, now, now)
    .run();
}

async function insertDeviceActor(userId: string, deviceId: string): Promise<string> {
  await insertUser(userId);
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO devices
      (id, user_id, name, platform, root_folder_path, last_seen_at, created_at)
     VALUES (?, ?, 'Test Mac', 'macos', '/tmp/Eavesy', ?, ?)`,
  )
    .bind(deviceId, userId, now, now)
    .run();
  const rawToken = `eavesy_device_${userId}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken));
  const tokenHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  await testEnv.DB.prepare(
    `INSERT INTO device_tokens
      (id, user_id, device_id, token_hash, name, created_at)
     VALUES (?, ?, ?, ?, 'Test Mac', ?)`,
  )
    .bind(`token_${deviceId}`, userId, deviceId, tokenHash, now)
    .run();
  return rawToken;
}

function segmentRequest(meetingId: string, idx: number, token: string, body: Uint8Array): Request {
  return new Request(`https://eavesy.test/api/sessions/${meetingId}/segments/${idx}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-length': String(body.byteLength),
      'content-type': 'audio/mp4',
      'x-segment-duration-ms': '3000',
      'x-segment-start-ms': String(idx * 3000),
    },
    body: requestBody(body),
  });
}

function finalizeRequest(meetingId: string, token: string, body: Uint8Array): Request {
  return new Request(`https://eavesy.test/api/sessions/${meetingId}/finalize`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-length': String(body.byteLength),
      'content-type': 'audio/mp4',
    },
    body: requestBody(body),
  });
}

function segmentsOnlyFinalizeRequest(meetingId: string, token: string): Request {
  return new Request(`https://eavesy.test/api/sessions/${meetingId}/finalize?archive=none`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

function fileEditRequest(
  meetingId: string,
  token: string,
  role: 'summary' | 'transcript' | 'notes',
  contentMd: string,
): Request {
  return new Request(`https://eavesy.test/api/sessions/${meetingId}/files`, {
    method: 'PATCH',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ role, contentMd, contentHash: 'a'.repeat(64) }),
  });
}

function transcribeRequest(token: string, body: Uint8Array): Request {
  return new Request('https://eavesy.test/api/transcribe', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: requestBody(body),
  });
}

function requestBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function insertMeeting(args: {
  id: string;
  userId: string;
  status: string;
  audioR2Key?: string;
  source?: 'desktop' | 'web' | 'import';
  expiresAt?: number;
  updatedAt?: number;
  createdAt?: number;
  endedAt?: number;
}) {
  const now = Date.now();
  const createdAt = args.createdAt ?? now;
  await testEnv.DB.prepare(
    `INSERT INTO meetings
      (id, user_id, title, description, started_at, ended_at, source, language,
       audio_r2_key, status, expires_at, created_at, updated_at)
     VALUES (?, ?, 'Test meeting', '', ?, ?, ?, 'en', ?, ?, ?, ?, ?)`,
  )
    .bind(
      args.id,
      args.userId,
      createdAt,
      args.endedAt ?? null,
      args.source ?? 'desktop',
      args.audioR2Key ?? null,
      args.status,
      args.expiresAt ?? null,
      createdAt,
      args.updatedAt ?? now,
    )
    .run();
}

async function insertSegment(args: {
  id: string;
  meetingId: string;
  idx: number;
  r2Key?: string;
  offsetMs?: number;
}) {
  await testEnv.DB.prepare(
    `INSERT INTO meeting_segments
      (id, meeting_id, idx, r2_key, bytes, offset_ms, duration_ms, transcribe_status, created_at)
     VALUES (?, ?, ?, ?, 3, ?, 3000, 'pending', ?)`,
  )
    .bind(
      args.id,
      args.meetingId,
      args.idx,
      args.r2Key ?? `users/test/meetings/${args.meetingId}/segments/${args.idx}.m4a`,
      args.offsetMs ?? 0,
      Date.now(),
    )
    .run();
}

async function row<T>(sql: string, ...bindings: unknown[]): Promise<T | null> {
  return await testEnv.DB.prepare(sql)
    .bind(...bindings)
    .first<T>();
}
