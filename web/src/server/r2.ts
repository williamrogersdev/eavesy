import { getCloudflareContext } from '@/server/cloudflare-context';
import type { R2Bucket } from '@cloudflare/workers-types';

type R2PutValue = Parameters<R2Bucket['put']>[1];

export function bucket(): R2Bucket {
  const { env } = getCloudflareContext();
  const r2 = (env as unknown as { AUDIO_BUCKET?: R2Bucket }).AUDIO_BUCKET;
  if (!r2) {
    throw new Error('AUDIO_BUCKET binding missing — see wrangler.toml');
  }
  return r2;
}

export function meetingAudioKey(opts: {
  isAnonymous: boolean;
  userId: string;
  meetingId: string;
  format: 'm4a' | 'opus' | 'mp3' | 'webm' | 'wav';
}): string {
  const prefix = opts.isAnonymous ? `anonymous/${opts.userId}` : `users/${opts.userId}`;
  return `${prefix}/meetings/${opts.meetingId}.${opts.format}`;
}

export type ArchiveFormat = 'm4a' | 'webm' | 'opus';

export const ARCHIVE_CONTENT_TYPE: Record<ArchiveFormat, string> = {
  m4a: 'audio/mp4',
  webm: 'audio/webm',
  opus: 'audio/ogg',
};

export function archiveFormatOf(meeting: { audioFormat: string | null }): ArchiveFormat {
  return meeting.audioFormat === 'webm' || meeting.audioFormat === 'opus' ? meeting.audioFormat : 'm4a';
}

export function meetingArchiveKey(userId: string, meetingId: string, format: ArchiveFormat = 'm4a'): string {
  return `users/${userId}/meetings/${meetingId}/audio.${format}`;
}

export function meetingSegmentKey(
  userId: string,
  meetingId: string,
  idx: number,
  track: 'mixed' | 'mic' | 'system' = 'mixed',
): string {
  const suffix = track === 'mixed' ? '' : `-${track}`;
  return `users/${userId}/meetings/${meetingId}/segments/${idx.toString().padStart(6, '0')}${suffix}.m4a`;
}

export function dictationAudioKey(opts: {
  isAnonymous: boolean;
  userId: string;
  dictationId: string;
  format: 'opus' | 'webm';
}): string {
  const prefix = opts.isAnonymous ? `anonymous/${opts.userId}` : `users/${opts.userId}`;
  return `${prefix}/dictations/${opts.dictationId}.${opts.format}`;
}

export function captureKey(opts: { userId: string; captureId: string; ext: string }): string {
  return `users/${opts.userId}/captures/${opts.captureId}.${opts.ext}`;
}

export async function putAudio(
  key: string,
  body: R2PutValue,
  contentType: string,
): Promise<void> {
  await bucket().put(key, body, {
    httpMetadata: { contentType },
  });
}

export async function getAudio(key: string, range?: { offset: number; length: number }) {
  return await bucket().get(key, range ? { range } : undefined);
}

export async function headAudio(key: string) {
  return await bucket().head(key);
}


export async function deleteAudio(key: string): Promise<void> {
  await bucket().delete(key);
}

export const putObject = putAudio;
export const deleteObject = deleteAudio;

export async function getObject(key: string, range?: { offset: number; length?: number }) {
  return await bucket().get(key, range ? { range } : undefined);
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    return (await bucket().head(key)) != null;
  } catch {
    return false;
  }
}

export function audioProxyUrl(key: string): string {
  return `/api/audio/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export function mediaProxyUrl(key: string): string {
  return `/api/media/${key.split('/').map(encodeURIComponent).join('/')}`;
}
