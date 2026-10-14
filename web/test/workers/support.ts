import { env } from 'cloudflare:workers';
import type { applyD1Migrations } from 'cloudflare:test';
import type { D1Database, Queue, R2Bucket } from '@cloudflare/workers-types';
import { vi } from 'vitest';
import type { Env } from '../../../workers/processing/src/index';
import type { ProcessingMessage } from '../../src/server/processing-worker';

export interface TestEnv {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

export const testEnv = env as unknown as TestEnv;

export type RouteHandler = (args: {
  request: Request;
  params: Record<string, string>;
}) => Promise<Response>;

type HandlerMap = Partial<Record<string, RouteHandler>>;

export function handlersOf(route: { options: unknown }): HandlerMap {
  return (route.options as { server?: { handlers?: HandlerMap } }).server?.handlers ?? {};
}

export function handler(route: { options: unknown }, method: string): RouteHandler {
  const found = handlersOf(route)[method];
  if (!found) throw new Error(`route has no ${method} handler`);
  return found;
}

export async function resetTables(...tables: string[]) {
  await testEnv.DB.batch(tables.map((table) => testEnv.DB.prepare(`DELETE FROM ${table}`)));
}

export async function insertUser(id: string) {
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO users
      (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at)
     VALUES (?, 'whisper', 'en', 0, ?, ?)`,
  )
    .bind(id, now, now)
    .run();
}

export async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function insertDeviceActor(userId: string, deviceId: string): Promise<string> {
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
  await testEnv.DB.prepare(
    `INSERT INTO device_tokens
      (id, user_id, device_id, token_hash, name, created_at)
     VALUES (?, ?, ?, ?, 'Test Mac', ?)`,
  )
    .bind(`token_${deviceId}`, userId, deviceId, await sha256(rawToken), now)
    .run();
  return rawToken;
}

export async function insertMeeting(args: {
  id: string;
  userId: string;
  status: string;
  audioR2Key?: string;
  source?: 'desktop' | 'web' | 'import';
}) {
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO meetings
      (id, user_id, title, description, started_at, source, language,
       audio_r2_key, status, created_at, updated_at)
     VALUES (?, ?, 'Test meeting', '', ?, ?, 'en', ?, ?, ?, ?)`,
  )
    .bind(args.id, args.userId, now, args.source ?? 'desktop', args.audioR2Key ?? null, args.status, now, now)
    .run();
}

export async function insertSegment(args: { id: string; meetingId: string; idx: number; r2Key: string }) {
  await testEnv.DB.prepare(
    `INSERT INTO meeting_segments
      (id, meeting_id, idx, r2_key, bytes, offset_ms, duration_ms, transcribe_status, created_at)
     VALUES (?, ?, ?, ?, 3, 0, 3000, 'pending', ?)`,
  )
    .bind(args.id, args.meetingId, args.idx, args.r2Key, Date.now())
    .run();
}

export async function row<T>(sql: string, ...bindings: unknown[]): Promise<T | null> {
  return await testEnv.DB.prepare(sql)
    .bind(...bindings)
    .first<T>();
}

export function mockQueue() {
  const send = vi.fn(async () => undefined);
  return { send, binding: { send } as unknown as Queue<ProcessingMessage> };
}

export function runtimeEnv(
  queue = mockQueue().binding,
  ai: { run: (model: string, input: unknown) => Promise<unknown> } = { run: async () => ({}) },
): Env {
  return {
    DB: testEnv.DB,
    AUDIO_BUCKET: testEnv.AUDIO_BUCKET,
    VECTORIZE: {} as Env['VECTORIZE'],
    PROCESSING_QUEUE: queue,
    AI: ai as Env['AI'],
    ANTHROPIC_API_KEY: 'test-only',
  };
}

export function requestBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
