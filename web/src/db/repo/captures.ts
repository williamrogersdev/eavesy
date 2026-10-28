import { and, desc, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { captures, devices } from '../schema';

export type Capture = typeof captures.$inferSelect;
export type CaptureKind = Capture['kind'];
export type CaptureMode = Capture['captureMode'];
export type TranscriptStatus = Capture['transcriptStatus'];

/** The kinds a Mac shares with the user's other Macs. */
export const DEVICE_SHARED_KINDS = ['image', 'note'] as const satisfies readonly CaptureKind[];

export function isDeviceShared(kind: CaptureKind): boolean {
  return (DEVICE_SHARED_KINDS as readonly CaptureKind[]).includes(kind);
}

/**
 * A transcript `processing` for longer than this never finished: the request
 * that claimed it was cut off (the tab closed during "Saving…", or the isolate
 * went away). The next upload of the audio may claim it again.
 *
 * The claim's age is the row's `updatedAt`. Any other write to the row (a
 * rename) only pushes the claim later, never earlier, and a finished
 * transcript is not `processing` any more, so the only way to reclaim a live
 * one is a single Whisper call outlasting this, far longer than Workers AI
 * allows a request. Should it ever happen, the first result to land wins and
 * the other is dropped (`setTranscript` with `ifStatus`).
 */
export const TRANSCRIPT_CLAIM_TTL_MS = 15 * 60 * 1_000;

export async function create(
  db: AppDb,
  args: {
    /** Given when the caller already named the R2 object after it. */
    id?: string;
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
  const id = args.id ?? pid('cap');
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

/** Images and notes another device can bring into its history: everything not uploaded by `exceptDeviceId`. */
export async function listForDevice(
  db: AppDb,
  args: { userId: string; exceptDeviceId?: string; limit: number; offset: number },
) {
  return await db
    .select({
      id: captures.id,
      kind: captures.kind,
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
        inArray(captures.kind, [...DEVICE_SHARED_KINDS]),
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

/** Returns false when `ifStatus` was given and the row had moved on. */
export async function setTranscript(
  db: AppDb,
  args: {
    captureId: string;
    userId: string;
    status: TranscriptStatus;
    transcript?: string | null;
    error?: string | null;
    /** Only write while the transcript is still at this status. */
    ifStatus?: TranscriptStatus;
  },
): Promise<boolean> {
  const rows = await db
    .update(captures)
    .set({
      transcriptStatus: args.status,
      transcript: args.transcript ?? null,
      transcriptError: args.error ?? null,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(captures.id, args.captureId),
        eq(captures.userId, args.userId),
        args.ifStatus === undefined ? undefined : eq(captures.transcriptStatus, args.ifStatus),
      ),
    )
    .returning({ id: captures.id });
  return rows.length > 0;
}

/**
 * Moves a capture's transcript from `from` to `to` only if it is still at
 * `from`, so a transcript is worked on (and paid for) once. False otherwise.
 */
export async function claimTranscript(
  db: AppDb,
  args: {
    captureId: string;
    userId: string;
    from: TranscriptStatus;
    to: TranscriptStatus;
    /** Also take over a row already at `to` that has sat there this long. */
    staleAfterMs?: number;
    error?: string | null;
  },
): Promise<boolean> {
  const now = Date.now();
  const claimable =
    args.staleAfterMs === undefined
      ? eq(captures.transcriptStatus, args.from)
      : or(
          eq(captures.transcriptStatus, args.from),
          and(eq(captures.transcriptStatus, args.to), lt(captures.updatedAt, now - args.staleAfterMs)),
        );
  const rows = await db
    .update(captures)
    .set({ transcriptStatus: args.to, transcriptError: args.error ?? null, updatedAt: now })
    .where(and(eq(captures.id, args.captureId), eq(captures.userId, args.userId), claimable, isNull(captures.deletedAt)))
    .returning({ id: captures.id });
  return rows.length > 0;
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

/**
 * Newest first; `before` (a `createdAt`) pages back through older captures.
 * Notes synced between Macs are left out: the web app has no view for them.
 */
export async function listSummariesForUser(db: AppDb, args: { userId: string; limit?: number; before?: number }) {
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
    .where(
      and(
        eq(captures.userId, args.userId),
        ne(captures.kind, 'note'),
        isNull(captures.deletedAt),
        args.before === undefined ? undefined : lt(captures.createdAt, args.before),
      ),
    )
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
