import { eq } from 'drizzle-orm';
import type { AppDb } from '@/db/client';
import { meetingUploads } from '@/db/schema';
import { ARCHIVE_CONTENT_TYPE, bucket, meetingArchiveKey, type ArchiveFormat } from '@/server/r2';
import { ARCHIVE_PART_SIZE } from '@/server/session-ingest';

export interface UploadedPartState {
  partNumber: number;
  etag: string;
  bytes: number;
}

export function parseUploadedParts(value: string): UploadedPartState[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (part): part is UploadedPartState =>
        typeof part === 'object' &&
        part !== null &&
        Number.isSafeInteger((part as UploadedPartState).partNumber) &&
        typeof (part as UploadedPartState).etag === 'string' &&
        Number.isSafeInteger((part as UploadedPartState).bytes),
    );
  } catch {
    return [];
  }
}

export async function loadOrCreateMultipart(
  db: AppDb,
  args: { meetingId: string; userId: string; format?: ArchiveFormat },
) {
  const existing = (
    await db.select().from(meetingUploads).where(eq(meetingUploads.meetingId, args.meetingId)).limit(1)
  )[0];
  if (existing) return existing;

  const multipart = await bucket().createMultipartUpload(
    meetingArchiveKey(args.userId, args.meetingId, args.format),
    { httpMetadata: { contentType: ARCHIVE_CONTENT_TYPE[args.format ?? 'm4a'] } },
  );
  const now = Date.now();
  try {
    await db.insert(meetingUploads).values({
      meetingId: args.meetingId,
      uploadId: multipart.uploadId,
      partSize: ARCHIVE_PART_SIZE,
      nextPartNumber: 1,
      etagsJson: '[]',
      state: 'active',
      updatedAt: now,
    });
  } catch (error) {
    await multipart.abort().catch(() => undefined);
    const raced = (
      await db.select().from(meetingUploads).where(eq(meetingUploads.meetingId, args.meetingId)).limit(1)
    )[0];
    if (raced) return raced;
    throw error;
  }

  return {
    meetingId: args.meetingId,
    uploadId: multipart.uploadId,
    partSize: ARCHIVE_PART_SIZE,
    nextPartNumber: 1,
    etagsJson: '[]',
    state: 'active' as const,
    updatedAt: now,
  };
}
