import type { Drop } from '@/db/repo/drops';

/** Text up to this size is stored in D1; larger text goes to R2 as a .txt object. */
export const INLINE_TEXT_MAX_BYTES = 128 * 1024;
/** Text up to this size is shipped in list/broadcast payloads; bigger drops are fetched on demand. */
export const PAYLOAD_TEXT_MAX_BYTES = 32 * 1024;
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const PREVIEW_CHARS = 600;

export interface DropDto {
  id: string;
  kind: 'text' | 'file';
  /** Full text when small enough to ship inline; otherwise null and `contentUrl` serves it. */
  text: string | null;
  preview: string | null;
  filename: string | null;
  contentType: string | null;
  bytes: number;
  deviceLabel: string | null;
  createdAt: number;
  contentUrl: string;
}

export function toDto(drop: Drop): DropDto {
  return {
    id: drop.id,
    kind: drop.kind,
    text: drop.kind === 'text' && drop.text != null && drop.bytes <= PAYLOAD_TEXT_MAX_BYTES ? drop.text : null,
    preview: drop.preview,
    filename: drop.filename,
    contentType: drop.contentType,
    bytes: drop.bytes,
    deviceLabel: drop.deviceLabel,
    createdAt: drop.createdAt,
    contentUrl: `/api/drops/${encodeURIComponent(drop.id)}`,
  };
}

export function dropKey(userId: string, dropId: string, filename: string): string {
  return `users/${userId}/drops/${dropId}/${filename}`;
}

/** Strip path separators and control characters; keep the name recognisable. */
export function safeFilename(raw: string | null | undefined): string {
  const cleaned = (raw ?? '')
    .replace(/[\\/]/g, '_')
    .split('')
    .filter(isPrintable)
    .join('')
    .trim()
    .slice(0, 200);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file';
}

export function deviceLabelFrom(request: Request): string | null {
  let label = request.headers.get('x-drop-device') ?? '';
  try {
    label = decodeURIComponent(label);
  } catch {
    // Not percent-encoded; use it as-is.
  }
  label = label.split('').filter(isPrintable).join('').trim();
  return label ? label.slice(0, 60) : null;
}

export function originFrom(request: Request): string | null {
  const origin = request.headers.get('x-drop-client')?.trim();
  return origin && /^[A-Za-z0-9_-]{1,64}$/.test(origin) ? origin : null;
}

function isPrintable(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}
