import { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireServerEnv, serverEnv } from '@/lib/env';

let s3: S3Client | null = null;

function client(): S3Client {
  if (s3) return s3;
  const accountId = requireServerEnv('R2_ACCOUNT_ID');
  s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requireServerEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireServerEnv('R2_SECRET_ACCESS_KEY'),
    },
  });
  return s3;
}

function bucket(): string {
  return requireServerEnv('R2_BUCKET');
}

export function meetingAudioKey(opts: {
  isAnonymous: boolean;
  userId: string;
  meetingId: string;
  format: 'opus' | 'mp3' | 'webm' | 'wav' | 'm4a';
}): string {
  const prefix = opts.isAnonymous ? `anonymous/${opts.userId}` : `users/${opts.userId}`;
  return `${prefix}/meetings/${opts.meetingId}.${opts.format}`;
}

export async function putAudioObject(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function getAudioUrl(key: string, opts: { expiresInSeconds?: number } = {}): Promise<string> {
  const base = serverEnv.R2_PUBLIC_URL_BASE;
  if (base) {
    // For private content, fall through to presigned URL.
  }
  return await getSignedUrl(
    client(),
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn: opts.expiresInSeconds ?? 60 * 60 },
  );
}

export async function getPresignedPutUrl(key: string, contentType: string, opts: { expiresInSeconds?: number } = {}): Promise<string> {
  return await getSignedUrl(
    client(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn: opts.expiresInSeconds ?? 15 * 60 },
  );
}

export async function deleteAudioObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
