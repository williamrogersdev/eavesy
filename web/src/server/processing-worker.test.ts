import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { MessageBatch } from '@cloudflare/workers-types';
import type { ProcessingMessage } from '@/server/processing-worker';
mock.module('cloudflare:workers', () => ({ env: {} }));
const {
  crossesRollingNotesBoundary,
  DROP_TTL_MS,
  MAX_ATTEMPTS,
  PURGE_AFTER_MS,
  purgeDeleted,
  queue,
  summaryRetryDelaySeconds,
  SUMMARY_WAIT_LIMIT_MS,
} = await import('@/server/processing-worker');
import { createFakeEnv, delivery, stubAnthropic, summaryReply } from '@/server/testing/fake-env';

const SUMMARY = {
  title: 'Launch planning sync',
  description: 'The team planned the launch.',
  tldr: 'They agreed to ship Friday.',
  decisions: [{ text: 'Ship Friday' }],
  actionItems: [{ text: 'Write release notes', owner: 'Maya', due: null }],
  followUps: [],
  openQuestions: [],
  topics: ['launch'],
  mentions: [],
};

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

function setup(opts: Parameters<typeof createFakeEnv>[0] = {}) {
  const fake = createFakeEnv(opts);
  const now = Date.now();
  fake.sqlite.run(`INSERT INTO users (id, created_at, updated_at) VALUES ('u1', ?, ?)`, [now, now]);
  fake.sqlite.run(
    `INSERT INTO meetings (id, user_id, title, started_at, source, status, created_at, updated_at)
     VALUES ('m1', 'u1', 'Meeting recording', ?, 'desktop', 'processing', ?, ?)`,
    [now, now, now],
  );
  const addSegment = (
    idx: number,
    status: string,
    track: 'mixed' | 'mic' | 'system' = 'mixed',
    activeMs: number | null = null,
  ) => {
    fake.sqlite.run(
      `INSERT INTO meeting_segments (id, meeting_id, idx, track, active_ms, r2_key, bytes, offset_ms, duration_ms, transcribe_status, created_at)
       VALUES (?, 'm1', ?, ?, ?, ?, 3, ?, 240000, ?, ?)`,
      [`s${idx}${track}`, idx, track, activeMs, `seg/${idx}/${track}`, idx * 240_000, status, now],
    );
    fake.objects.set(`seg/${idx}/${track}`, new Uint8Array([track === 'mic' ? 1 : track === 'system' ? 2 : 0, idx]));
  };
  const addLine = (startMs: number, text: string) =>
    fake.sqlite.run(
      `INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, text) VALUES (?, 'm1', ?, ?, ?)`,
      [`t${startMs}`, startMs, startMs + 1000, text],
    );
  const meeting = () =>
    fake.sqlite.query(`SELECT status, status_error, title FROM meetings WHERE id = 'm1'`).get() as {
      status: string;
      status_error: string | null;
      title: string;
    };
  const segmentStatus = (idx: number, track = 'mixed') =>
    (
      fake.sqlite
        .query(`SELECT transcribe_status s FROM meeting_segments WHERE idx = ? AND track = ?`)
        .get(idx, track) as { s: string }
    ).s;
  const lines = () =>
    fake.sqlite
      .query('SELECT speaker_id speaker, start_ms, text FROM transcript_segments ORDER BY start_ms, speaker_id')
      .all() as { speaker: string | null; start_ms: number; text: string }[];
  return { ...fake, addSegment, addLine, meeting, segmentStatus, lines };
}

async function deliver(env: Parameters<typeof queue>[1], body: ProcessingMessage, attempts = 1) {
  const d = delivery(body, attempts);
  await queue({ messages: [d.message] } as unknown as MessageBatch<ProcessingMessage>, env);
  return d.outcome;
}

describe('final summary', () => {
  test('waits while segments are still being transcribed', async () => {
    const t = setup();
    t.addSegment(0, 'complete');
    t.addSegment(1, 'pending');
    const outcome = await deliver(t.env, { kind: 'summarize', meetingId: 'm1' });
    expect(outcome.acked).toBe(true);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].body.kind).toBe('summarize');
    expect(t.sent[0].delaySeconds).toBe(2);
    expect(t.meeting().status).toBe('processing');
  });

  test('checks back quickly at first, then backs off', () => {
    expect(summaryRetryDelaySeconds(2, 0)).toBe(2);
    expect(summaryRetryDelaySeconds(30, 0)).toBe(30);
    expect(summaryRetryDelaySeconds(2, 3 * 60_000)).toBe(30);
    expect(summaryRetryDelaySeconds(2, 10 * 60_000)).toBe(60);
  });

  test('does not wait forever on a segment that permanently failed', async () => {
    const t = setup();
    t.addSegment(0, 'complete');
    t.addSegment(1, 'failed');
    t.addLine(0, 'We ship Friday.');
    const api = stubAnthropic(() => summaryReply(SUMMARY));
    restoreFetch = api.restore;

    await deliver(t.env, { kind: 'summarize', meetingId: 'm1' });

    expect(t.meeting().status).toBe('complete');
    expect(t.meeting().title).toBe('Launch planning sync');
    expect(t.meeting().status_error).toContain('could not be transcribed');
    expect(t.sent.map((m) => m.body.kind)).toEqual(['embed']);
  });

  test('gives up waiting on stragglers after the wait limit', async () => {
    const t = setup();
    t.addSegment(0, 'processing');
    t.addLine(0, 'Hello.');
    const api = stubAnthropic(() => summaryReply(SUMMARY));
    restoreFetch = api.restore;

    await deliver(t.env, {
      kind: 'summarize',
      meetingId: 'm1',
      waitingSince: Date.now() - SUMMARY_WAIT_LIMIT_MS - 1,
    });
    expect(t.meeting().status).toBe('complete');
  });

  test('an unparseable reply is retried, not saved as an empty summary', async () => {
    const t = setup();
    t.addSegment(0, 'complete');
    t.addLine(0, 'Hello.');
    const api = stubAnthropic(() => summaryReply('not json' as unknown as Record<string, unknown>));
    restoreFetch = api.restore;

    const outcome = await deliver(t.env, { kind: 'summarize', meetingId: 'm1' });
    expect(outcome.retried).toBe(true);
    expect(t.meeting().status).toBe('processing');
    expect(t.sqlite.query('SELECT count(*) n FROM summaries').get()).toEqual({ n: 0 });
  });

  test('the last failed attempt marks the meeting failed with the reason', async () => {
    const t = setup();
    t.addSegment(0, 'complete');
    t.addLine(0, 'Hello.');
    const api = stubAnthropic(() => summaryReply({ ...SUMMARY, tldr: '' }));
    restoreFetch = api.restore;

    const outcome = await deliver(t.env, { kind: 'summarize', meetingId: 'm1' }, MAX_ATTEMPTS);
    expect(outcome.acked).toBe(true);
    expect(t.meeting().status).toBe('failed');
    expect(t.meeting().status_error).toContain('empty TL;DR');
  });

  test('requests schema-constrained JSON output', async () => {
    const t = setup();
    t.addSegment(0, 'complete');
    t.addLine(0, 'Hello.');
    const api = stubAnthropic(() => summaryReply(SUMMARY));
    restoreFetch = api.restore;
    await deliver(t.env, { kind: 'summarize', meetingId: 'm1' });
    const request = api.calls[0] as { output_config?: { format?: { type?: string } } };
    expect(request.output_config?.format?.type).toBe('json_schema');
  });
});

describe('segment transcription', () => {
  test('a transient failure leaves the segment pending for the retry', async () => {
    const t = setup({
      transcribe: () => {
        throw new Error('workers ai unavailable');
      },
    });
    t.addSegment(0, 'pending');
    const outcome = await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 0 });
    expect(outcome.retried).toBe(true);
    expect(t.segmentStatus(0)).toBe('pending');
  });

  test('the last failed attempt marks the segment failed so the summary can proceed', async () => {
    const t = setup({
      transcribe: () => {
        throw new Error('workers ai unavailable');
      },
    });
    t.addSegment(0, 'pending');
    const outcome = await deliver(
      t.env,
      { kind: 'transcribe-segment', meetingId: 'm1', idx: 0 },
      MAX_ATTEMPTS,
    );
    expect(outcome.acked).toBe(true);
    expect(t.segmentStatus(0)).toBe('failed');
  });

  test('stores lines at their absolute position in the meeting', async () => {
    const t = setup({
      transcribe: () => ({ text: 'hi', segments: [{ start: 1.5, end: 2, text: ' hi ' }] }),
    });
    t.addSegment(2, 'pending');
    await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 2 });
    expect(t.segmentStatus(2)).toBe('complete');
    expect(t.sqlite.query('SELECT start_ms, text FROM transcript_segments').all()).toEqual([
      { start_ms: 2 * 240_000 + 1_500, text: 'hi' },
    ]);
  });
});

describe('rolling summary', () => {
  test('fires each time the audio crosses another four minutes, whatever the segment length', () => {
    const minute = 60_000;
    const fired = (lengthMs: number, totalMs: number) => {
      const ends: number[] = [];
      for (let offset = 0; offset < totalMs; offset += lengthMs) {
        if (crossesRollingNotesBoundary({ offsetMs: offset, durationMs: lengthMs })) ends.push(offset + lengthMs);
      }
      return ends;
    };
    expect(fired(minute, 12 * minute)).toEqual([4, 8, 12].map((m) => m * minute));
    expect(fired(4 * minute, 12 * minute)).toEqual([4, 8, 12].map((m) => m * minute));
    expect(fired(75_000, 10 * minute)).toEqual([300_000, 525_000]);
  });

  test('one-minute segments only queue notes at the boundary', async () => {
    const t = setup({ transcribe: () => ({ text: 'hi', segments: [{ start: 1, end: 2, text: 'hi' }] }) });
    t.sqlite.run(`UPDATE meetings SET status = 'recording'`);
    const addMinute = (idx: number) =>
      t.sqlite.run(
        `INSERT INTO meeting_segments (id, meeting_id, idx, track, r2_key, bytes, offset_ms, duration_ms, transcribe_status, created_at)
         VALUES (?, 'm1', ?, 'mixed', ?, 3, ?, 60000, 'pending', 0)`,
        [`s${idx}`, idx, `seg/${idx}`, idx * 60_000],
      );
    for (const idx of [0, 1, 2, 3]) {
      addMinute(idx);
      t.objects.set(`seg/${idx}`, new Uint8Array([0, idx]));
      await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx });
    }
    expect(t.sent.map((m) => m.body)).toEqual([
      { kind: 'rolling-summarize', meetingId: 'm1', throughIdx: 3, throughMs: 240_000 },
    ]);
  });

  test('summarizes the last interval of audio', async () => {
    const t = setup();
    t.sqlite.run(`UPDATE meetings SET status = 'recording'`);
    t.addLine(30_000, 'Old news from the start.');
    t.addLine(400_000, 'Budget is approved.');
    t.addLine(470_000, 'Ship Friday.');
    const api = stubAnthropic(() => summaryReply(SUMMARY));
    restoreFetch = api.restore;
    await deliver(t.env, { kind: 'rolling-summarize', meetingId: 'm1', throughIdx: 7, throughMs: 480_000 });
    const request = api.calls[0] as { messages: { content: string }[] };
    expect(request.messages[0].content).toBe('Budget is approved.\nShip Friday.');
  });

  test('is dropped once the meeting has ended, so it cannot overwrite the final summary', async () => {
    const t = setup();
    t.addSegment(0, 'complete');
    t.addLine(0, 'Hello.');
    const api = stubAnthropic(() => summaryReply(SUMMARY));
    restoreFetch = api.restore;
    await deliver(t.env, { kind: 'rolling-summarize', meetingId: 'm1', throughIdx: 2 });
    expect(api.calls).toHaveLength(0);
    expect(t.sqlite.query('SELECT count(*) n FROM summaries').get()).toEqual({ n: 0 });
  });

  test('streams from Haiku with a small budget, on the user’s own key when they have one', async () => {
    const t = setup();
    t.sqlite.run(`UPDATE meetings SET status = 'recording'`);
    t.sqlite.run(`UPDATE users SET byo_anthropic_key = 'sk-ant-mine'`);
    t.addSegment(0, 'complete');
    t.addLine(0, 'We ship Friday.');
    const keys: (string | null)[] = [];
    const api = stubAnthropic(() => summaryReply(SUMMARY));
    const stubbed = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get('x-api-key'));
      return stubbed(input, init);
    }) as typeof fetch;
    restoreFetch = api.restore;

    await deliver(t.env, { kind: 'rolling-summarize', meetingId: 'm1', throughIdx: 0 });

    const request = api.calls[0] as { model: string; stream: boolean; max_tokens: number; output_config: { effort: string } };
    expect(request).toMatchObject({ model: 'claude-haiku-5-5', stream: true, max_tokens: 8_000 });
    expect(request.output_config.effort).toBe('low');
    expect(keys).toEqual(['sk-ant-mine']);
    expect(t.sqlite.query('SELECT tldr, generated_by_model m FROM summaries').get()).toEqual({
      tldr: SUMMARY.tldr,
      m: 'byo-anthropic:claude-haiku-5-5',
    });
  });

  test('the final summary stays on the summary model', async () => {
    const t = setup();
    t.addSegment(0, 'complete');
    t.addLine(0, 'We ship Friday.');
    const api = stubAnthropic(() => summaryReply(SUMMARY));
    restoreFetch = api.restore;
    await deliver(t.env, { kind: 'summarize', meetingId: 'm1' });
    expect((api.calls[0] as { model: string; stream?: boolean })).toMatchObject({ model: 'claude-sonnet-4-6' });
    expect((api.calls[0] as { stream?: boolean }).stream).toBeUndefined();
  });
});

describe('dead-letter queue', () => {
  test('messages are reported and acknowledged, never re-run', async () => {
    const t = setup();
    t.addSegment(0, 'pending');
    const d = delivery({ kind: 'transcribe-segment', meetingId: 'm1', idx: 0 });
    await queue(
      { queue: 'eavesy-processing-dlq', messages: [d.message] } as unknown as MessageBatch<ProcessingMessage>,
      t.env,
    );
    expect(d.outcome.acked).toBe(true);
    expect(t.segmentStatus(0)).toBe('pending');
  });
});

describe('two-track transcription', () => {
  const whisper = (audio: Uint8Array) =>
    audio[0] === 1
      ? {
          text: '',
          segments: [
            { start: 1, end: 3, text: 'Morning, I can present first.' },
            { start: 11.2, end: 13, text: 'everyone see the launch checklist on my screen' },
            { start: 20, end: 21, text: 'Thanks for watching!', no_speech_prob: 0.5 },
          ],
        }
      : {
          text: '',
          segments: [{ start: 10, end: 12, text: 'Can everyone see the launch checklist on my screen?' }],
        };

  test('labels each track and removes the echo once both sides are in', async () => {
    const t = setup({ transcribe: whisper });
    t.addSegment(0, 'pending', 'mic', 60_000);
    t.addSegment(0, 'pending', 'system', 60_000);

    await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 0, track: 'mic' });
    expect(t.lines().map((l) => l.speaker)).toEqual(['you', 'you']);

    await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 0, track: 'system' });
    expect(t.lines()).toEqual([
      { speaker: 'you', start_ms: 1_000, text: 'Morning, I can present first.' },
      { speaker: 'them', start_ms: 10_000, text: 'Can everyone see the launch checklist on my screen?' },
    ]);
  });

  test('a silent track is completed without being transcribed', async () => {
    let calls = 0;
    const t = setup({
      transcribe: (audio) => {
        calls += 1;
        return whisper(audio);
      },
    });
    t.addSegment(0, 'pending', 'system', 0);
    await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 0, track: 'system' });
    expect(calls).toBe(0);
    expect(t.segmentStatus(0, 'system')).toBe('complete');
  });

  test('rolling notes fire once per index, after both tracks', async () => {
    const t = setup({ transcribe: whisper });
    t.sqlite.run(`UPDATE meetings SET status = 'uploading'`);
    t.addSegment(2, 'pending', 'mic', 60_000);
    t.addSegment(2, 'pending', 'system', 60_000);
    await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 2, track: 'mic' });
    expect(t.sent).toHaveLength(0);
    await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 2, track: 'system' });
    expect(t.sent.map((m) => m.body.kind)).toEqual(['rolling-summarize']);
  });

  test('the summary sees speaker labels when both sides spoke', async () => {
    const t = setup();
    t.addSegment(0, 'complete', 'mic');
    t.addSegment(0, 'complete', 'system');
    t.sqlite.run(
      `INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, speaker_id, text) VALUES
       ('a', 'm1', 0, 1000, 'you', 'I will write the notes.'),
       ('b', 'm1', 2000, 3000, 'them', 'Great, thanks.')`,
    );
    t.sqlite.run(`UPDATE meetings SET speaker_names_json = '{"you":"Will"}'`);
    const api = stubAnthropic(() => summaryReply(SUMMARY));
    restoreFetch = api.restore;
    await deliver(t.env, { kind: 'summarize', meetingId: 'm1' });
    const request = api.calls[0] as { system: string; messages: { content: string }[] };
    expect(request.messages[0].content).toBe('Will: I will write the notes.\nThem: Great, thanks.');
    expect(request.system).toContain('"Will" is the person who recorded the meeting');
  });
});

describe('mic-only notes', () => {
  test('a quiet mic is transcribed even with little active time', async () => {
    let calls = 0;
    const t = setup({
      transcribe: () => {
        calls += 1;
        return { text: '', segments: [{ start: 0, end: 1, text: 'Call the bank.' }] };
      },
    });
    t.addSegment(0, 'pending', 'mic', 120);
    await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 0, track: 'mic' });
    expect(calls).toBe(1);
    expect(t.lines().map((l) => l.text)).toEqual(['Call the bank.']);
  });

  test('a short "thank you" note is kept when Whisper did not doubt it', async () => {
    const t = setup({ transcribe: () => ({ text: '', segments: [{ start: 0, end: 1, text: 'Thank you.' }] }) });
    t.addSegment(0, 'pending', 'mic', 900);
    await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 0, track: 'mic' });
    expect(t.lines().map((l) => l.text)).toEqual(['Thank you.']);
  });

  test('speech the VAD cut away gets one more pass without it', async () => {
    const passes: boolean[] = [];
    const t = setup({
      transcribe: (_audio, { vadFilter }) => {
        passes.push(vadFilter);
        return vadFilter
          ? { text: '', segments: [] }
          : { text: '', segments: [{ start: 0, end: 2, text: 'quiet words', no_speech_prob: 0.2 }] };
      },
    });
    t.addSegment(0, 'pending', 'mic', 600);
    await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 0, track: 'mic' });
    expect(passes).toEqual([true, false]);
    expect(t.lines().map((l) => l.text)).toEqual(['quiet words']);
  });

  test('the retry without VAD still drops invented stock phrases', async () => {
    const t = setup({
      transcribe: (_audio, { vadFilter }) =>
        vadFilter ? { text: '', segments: [] } : { text: '', segments: [{ start: 0, end: 1, text: 'Thank you.' }] },
    });
    t.addSegment(0, 'pending', 'mic', 600);
    await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 0, track: 'mic' });
    expect(t.lines()).toEqual([]);
    expect(t.segmentStatus(0, 'mic')).toBe('complete');
  });

  test('the mic side of a call is still skipped when silent', async () => {
    let calls = 0;
    const t = setup({
      transcribe: () => {
        calls += 1;
        return { text: '', segments: [] };
      },
    });
    t.addSegment(0, 'complete', 'system', 60_000);
    t.addSegment(0, 'pending', 'mic', 0);
    await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 0, track: 'mic' });
    expect(calls).toBe(0);
  });

  test('a short dictation finishes without a summary, titled by its words', async () => {
    const t = setup();
    t.addSegment(0, 'complete', 'mic', 5_000);
    t.sqlite.run(`UPDATE meeting_segments SET duration_ms = 8000`);
    t.addLine(0, 'Remind me to send the invoice to Dana on Monday morning please.');
    const api = stubAnthropic(() => summaryReply(SUMMARY));
    restoreFetch = api.restore;
    await deliver(t.env, { kind: 'summarize', meetingId: 'm1' });
    expect(api.calls).toHaveLength(0);
    expect(t.meeting().status).toBe('complete');
    expect(t.meeting().title).toBe('Remind me to send the invoice to Dana…');
    expect(t.sent.map((m) => m.body.kind)).toEqual(['embed']);
  });

  test('a long voice note is still summarized', async () => {
    const t = setup();
    t.addSegment(0, 'complete', 'mic', 60_000);
    t.addLine(0, 'Hello.');
    t.addLine(200_000, 'More thoughts.');
    const api = stubAnthropic(() => summaryReply(SUMMARY));
    restoreFetch = api.restore;
    await deliver(t.env, { kind: 'summarize', meetingId: 'm1' });
    expect(api.calls).toHaveLength(1);
    expect(t.meeting().title).toBe(SUMMARY.title);
  });
});

describe('chapters', () => {
  test('long meetings get chapters snapped to real lines', async () => {
    const t = setup();
    t.addSegment(0, 'complete');
    t.addLine(1_000, 'Welcome, let us start.');
    t.addLine(400_000, 'On to the budget.');
    t.addLine(900_000, 'Finally, hiring.');
    const api = stubAnthropic(() =>
      summaryReply({
        ...SUMMARY,
        chapters: [
          { start: '00:00', title: 'Kickoff' },
          { start: '06:41', title: 'Budget' },
          { start: '15:00', title: 'Hiring' },
        ],
      }),
    );
    restoreFetch = api.restore;
    await deliver(t.env, { kind: 'summarize', meetingId: 'm1' });

    const request = api.calls[0] as {
      messages: { content: string }[];
      output_config: { format: { schema: { required: string[] } } };
    };
    expect(request.output_config.format.schema.required).toContain('chapters');
    expect(request.messages[0].content.split('\n')[1]).toBe('[06:40] On to the budget.');
    const row = t.sqlite.query('SELECT chapters_json c FROM summaries').get() as { c: string };
    expect(JSON.parse(row.c)).toEqual([
      { startMs: 1_000, title: 'Kickoff' },
      { startMs: 400_000, title: 'Budget' },
      { startMs: 900_000, title: 'Hiring' },
    ]);
  });
});

describe('purging deleted data', () => {
  test('a deleted meeting loses its audio, segments, vectors and rows', async () => {
    const fake = setup();
    fake.addSegment(0, 'done');
    fake.addLine(0, 'hello');
    fake.objects.set('users/u1/meetings/m1/audio.m4a', new Uint8Array([1]));
    fake.objects.set('users/u1/meetings/m1/segments/000000.m4a', new Uint8Array([1]));
    fake.objects.set('users/u1/meetings/m2/audio.m4a', new Uint8Array([1]));
    fake.sqlite.run(
      `INSERT INTO embeddings (id, user_id, source_type, source_id, chunk_idx, content_excerpt, created_at)
       VALUES ('m1__0', 'u1', 'meeting', 'm1', 0, 'hello', 0)`,
    );

    expect(await deliver(fake.env, { kind: 'purge-meeting', meetingId: 'm1' })).toMatchObject({ acked: true });

    expect(fake.sqlite.query(`SELECT id FROM meetings WHERE id = 'm1'`).get()).toBeNull();
    expect(fake.sqlite.query(`SELECT id FROM meeting_segments`).all()).toHaveLength(0);
    expect(fake.sqlite.query(`SELECT id FROM embeddings`).all()).toHaveLength(0);
    expect(fake.deletedVectors).toEqual(['m1__0']);
    expect([...fake.objects.keys()]).toEqual(['users/u1/meetings/m2/audio.m4a']);
  });

  test('the cron purges only items deleted more than a day ago', async () => {
    const fake = setup();
    const now = Date.now();
    fake.sqlite.run(`UPDATE meetings SET deleted_at = ? WHERE id = 'm1'`, [now - PURGE_AFTER_MS - 1]);
    fake.sqlite.run(
      `INSERT INTO meetings (id, user_id, title, started_at, source, status, created_at, updated_at, deleted_at)
       VALUES ('m-recent', 'u1', 'Just deleted', ?, 'desktop', 'complete', ?, ?, ?)`,
      [now, now, now, now - 60_000],
    );
    fake.sqlite.run(
      `INSERT INTO captures (id, user_id, kind, capture_mode, title, r2_key, content_type, bytes, created_at, updated_at, deleted_at)
       VALUES ('c1', 'u1', 'image', 'screenshot', 'Shot', 'users/u1/captures/c1.png', 'image/png', 1, ?, ?, ?)`,
      [now, now, now - PURGE_AFTER_MS - 1],
    );
    fake.objects.set('users/u1/captures/c1.png', new Uint8Array([1]));
    fake.sqlite.run(
      `INSERT INTO drops (id, user_id, kind, r2_key, filename, bytes, created_at)
       VALUES ('d-old', 'u1', 'file', 'users/u1/drops/d-old/notes.docx', 'notes.docx', 1, ?),
              ('d-new', 'u1', 'file', 'users/u1/drops/d-new/notes.docx', 'notes.docx', 1, ?)`,
      [now - DROP_TTL_MS - 1, now - 60_000],
    );
    fake.objects.set('users/u1/drops/d-old/notes.docx', new Uint8Array([1]));
    fake.objects.set('users/u1/drops/d-new/notes.docx', new Uint8Array([1]));

    const purged = await purgeDeleted(fake.env, now);

    expect(purged).toEqual({ meetings: 1, captures: 1, dictations: 0, drops: 1 });
    expect(fake.sqlite.query(`SELECT id FROM drops`).all()).toEqual([{ id: 'd-new' }]);
    expect(fake.objects.has('users/u1/drops/d-old/notes.docx')).toBe(false);
    expect(fake.objects.has('users/u1/drops/d-new/notes.docx')).toBe(true);
    expect(fake.sent.map((s) => s.body)).toEqual([{ kind: 'purge-meeting', meetingId: 'm1' }]);
    expect(fake.sqlite.query(`SELECT id FROM captures`).all()).toHaveLength(0);
    expect(fake.objects.has('users/u1/captures/c1.png')).toBe(false);
  });
});

describe('deleting an account', () => {
  test('removes every row and object the user owns, and leaves other users alone', async () => {
    const fake = setup();
    const now = Date.now();
    fake.addSegment(0, 'done');
    fake.addLine(0, 'hello');
    fake.sqlite.run(`INSERT INTO users (id, created_at, updated_at) VALUES ('u2', ?, ?)`, [now, now]);
    fake.sqlite.run(
      `INSERT INTO meetings (id, user_id, title, started_at, source, status, created_at, updated_at)
       VALUES ('m2', 'u2', 'Not yours', ?, 'web', 'complete', ?, ?)`,
      [now, now, now],
    );
    fake.sqlite.run(
      `INSERT INTO captures (id, user_id, kind, capture_mode, title, r2_key, content_type, bytes, created_at, updated_at)
       VALUES ('c1', 'u1', 'image', 'screenshot', 'Shot', 'users/u1/captures/c1.png', 'image/png', 1, ?, ?)`,
      [now, now],
    );
    fake.sqlite.run(
      `INSERT INTO embeddings (id, user_id, source_type, source_id, chunk_idx, content_excerpt, created_at)
       VALUES ('m1__0', 'u1', 'meeting', 'm1', 0, 'hello', 0)`,
    );
    fake.sqlite.run(
      `INSERT INTO devices (id, user_id, name, platform, root_folder_path, last_seen_at, created_at)
       VALUES ('d1', 'u1', 'Mac', 'macos', '/x', ?, ?)`,
      [now, now],
    );
    fake.objects.set('users/u1/captures/c1.png', new Uint8Array([1]));
    fake.objects.set('users/u2/meetings/m2.webm', new Uint8Array([1]));

    expect(await deliver(fake.env, { kind: 'purge-account', userId: 'u1' })).toMatchObject({ acked: true });

    const count = (sql: string) => (fake.sqlite.query(sql).get() as { n: number }).n;
    expect(count(`SELECT count(*) n FROM users WHERE id = 'u1'`)).toBe(0);
    expect(count(`SELECT count(*) n FROM meetings WHERE user_id = 'u1'`)).toBe(0);
    expect(count(`SELECT count(*) n FROM captures`)).toBe(0);
    expect(count(`SELECT count(*) n FROM devices`)).toBe(0);
    expect(count(`SELECT count(*) n FROM transcript_segments`)).toBe(0);
    expect(fake.deletedVectors).toContain('m1__0');
    expect([...fake.objects.keys()]).toEqual(['users/u2/meetings/m2.webm']);
    expect(count(`SELECT count(*) n FROM meetings WHERE user_id = 'u2'`)).toBe(1);
  });
});
