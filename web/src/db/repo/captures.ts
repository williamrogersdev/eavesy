import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { captures } from '../schema';

export type Capture = typeof captures.$inferSelect;
export type CaptureKind = Capture['kind'];
export type CaptureMode = Capture['captureMode'];
export type TranscriptStatus = Capture['transcriptStatus'];

export async function create(
  db: AppDb,
  args: {
    userId: string;
    kind: CaptureKind;
    captureMode: CaptureMode;
    source?: Capture['source'];
    title: string;
    r2Key: string;
    contentType: string;
    bytes: number;
    durationSec?: number | null;
    width?: number | null;
    height?: number | null;
    folderId?: string | null;
    transcript?: string | null;
    transcriptStatus?: TranscriptStatus;
    transcriptError?: string | null;
  },
): Promise<string> {
  const id = pid('cap');
  const now = Date.now();
  await db.insert(captures).values({
    id,
    userId: args.userId,
    kind: args.kind,
    captureMode: args.captureMode,
    source: args.source ?? 'web',
    title: args.title,
    r2Key: args.r2Key,
    contentType: args.contentType,
    bytes: args.bytes,
    durationSec: args.durationSec ?? null,
    width: args.width ?? null,
    height: args.height ?? null,
    transcript: args.transcript ?? null,
    transcriptStatus: args.transcriptStatus ?? 'none',
    transcriptError: args.transcriptError ?? null,
    folderId: args.folderId ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function setTranscript(
  db: AppDb,
  args: {
    captureId: string;
    userId: string;
    status: TranscriptStatus;
    transcript?: string | null;
    error?: string | null;
  },
): Promise<void> {
  await db
    .update(captures)
    .set({
      transcriptStatus: args.status,
      transcript: args.transcript ?? null,
      transcriptError: args.error ?? null,
      updatedAt: Date.now(),
    })
    .where(and(eq(captures.id, args.captureId), eq(captures.userId, args.userId)));
}

export async function listForUser(
  db: AppDb,
  args: { userId: string; limit?: number },
): Promise<Capture[]> {
  return await db
    .select()
    .from(captures)
    .where(and(eq(captures.userId, args.userId), isNull(captures.deletedAt)))
    .orderBy(desc(captures.createdAt))
    .limit(args.limit ?? 100);
}

export async function get(
  db: AppDb,
  args: { captureId: string; userId: string },
): Promise<Capture | null> {
  const rows = await db
    .select()
    .from(captures)
    .where(
      and(
        eq(captures.id, args.captureId),
        eq(captures.userId, args.userId),
        isNull(captures.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function rename(
  db: AppDb,
  args: { captureId: string; userId: string; title: string },
): Promise<void> {
  await db
    .update(captures)
    .set({ title: args.title, updatedAt: Date.now() })
    .where(and(eq(captures.id, args.captureId), eq(captures.userId, args.userId)));
}

export async function softDelete(
  db: AppDb,
  args: { captureId: string; userId: string },
): Promise<void> {
  await db
    .update(captures)
    .set({ deletedAt: Date.now(), updatedAt: Date.now() })
    .where(and(eq(captures.id, args.captureId), eq(captures.userId, args.userId)));
}
