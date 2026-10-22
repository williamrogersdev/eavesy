import { and, desc, eq, isNull, ne, or } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { captures, devices } from '../schema';

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
    clientCaptureId?: string | null;
    deviceId?: string | null;
    createdAt?: number;
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
    clientCaptureId: args.clientCaptureId ?? null,
    deviceId: args.deviceId ?? null,
    createdAt: args.createdAt ?? now,
    updatedAt: now,
  });
  return id;
}

/** A desktop upload already received under this Mac-side id, deleted or not. */
export async function getByClientId(
  db: AppDb,
  args: { userId: string; clientCaptureId: string },
): Promise<Capture | null> {
  const rows = await db
    .select()
    .from(captures)
    .where(and(eq(captures.userId, args.userId), eq(captures.clientCaptureId, args.clientCaptureId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Images another device can bring into its history: everything not uploaded by `exceptDeviceId`. */
export async function listImagesForDevice(
  db: AppDb,
  args: { userId: string; exceptDeviceId?: string; limit: number; offset: number },
) {
  return await db
    .select({
      id: captures.id,
      clientCaptureId: captures.clientCaptureId,
      title: captures.title,
      contentType: captures.contentType,
      bytes: captures.bytes,
      transcript: captures.transcript,
      createdAt: captures.createdAt,
      deviceName: devices.name,
    })
    .from(captures)
    .leftJoin(devices, eq(devices.id, captures.deviceId))
    .where(
      and(
        eq(captures.userId, args.userId),
        eq(captures.kind, 'image'),
        isNull(captures.deletedAt),
        args.exceptDeviceId
          ? or(isNull(captures.deviceId), ne(captures.deviceId, args.exceptDeviceId))
          : undefined,
      ),
    )
    .orderBy(desc(captures.createdAt), desc(captures.id))
    .limit(args.limit)
    .offset(args.offset);
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

export async function listSummariesForUser(db: AppDb, args: { userId: string; limit?: number }) {
  return await db
    .select({
      id: captures.id,
      kind: captures.kind,
      captureMode: captures.captureMode,
      title: captures.title,
      contentType: captures.contentType,
      bytes: captures.bytes,
      durationSec: captures.durationSec,
      width: captures.width,
      height: captures.height,
      r2Key: captures.r2Key,
      transcriptStatus: captures.transcriptStatus,
      createdAt: captures.createdAt,
    })
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
