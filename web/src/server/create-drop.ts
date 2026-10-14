import type { AppDb } from '@/db/client';
import { pid } from '@/db/ids';
import * as dropsRepo from '@/db/repo/drops';
import { publish } from '@/server/drops-hub';
import { dropKey, type DropDto, INLINE_TEXT_MAX_BYTES, MAX_TEXT_BYTES, PREVIEW_CHARS, toDto } from '@/server/drops';
import { putObject } from '@/server/r2';

export class DropTooLargeError extends Error {
  constructor() {
    super('text too large');
  }
}

/**
 * Store a text drop (in D1, or R2 past INLINE_TEXT_MAX_BYTES) and push it to the
 * user's open devices. Shared by POST /api/drops and the MCP worker's
 * `send_to_my_devices` tool, so it only touches bindings both workers have.
 */
export async function createTextDrop(
  db: AppDb,
  args: { userId: string; text: string; deviceLabel: string | null; origin: string | null },
): Promise<DropDto> {
  const { userId, text } = args;
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_TEXT_BYTES) throw new DropTooLargeError();

  const id = pid('drp');
  let r2Key: string | null = null;
  if (bytes > INLINE_TEXT_MAX_BYTES) {
    r2Key = dropKey(userId, id, 'text.txt');
    await putObject(r2Key, text, 'text/plain; charset=utf-8');
  }
  const row: dropsRepo.Drop = {
    id,
    userId,
    kind: 'text',
    text: r2Key ? null : text,
    preview: text.slice(0, PREVIEW_CHARS),
    r2Key,
    filename: null,
    contentType: 'text/plain',
    bytes,
    deviceLabel: args.deviceLabel,
    createdAt: Date.now(),
  };
  await dropsRepo.create(db, row);

  const drop = toDto(row);
  await publish(userId, { type: 'drop', drop, origin: args.origin });
  return drop;
}
