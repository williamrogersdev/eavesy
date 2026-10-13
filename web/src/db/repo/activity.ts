import { desc, eq } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { activityLog } from '../schema';
import { encode } from '../codec';

export type EventType =
  | 'meeting.start'
  | 'meeting.finalize'
  | 'meeting.complete'
  | 'meeting.fail'
  | 'meeting.delete'
  | 'meeting.share'
  | 'meeting.copy'
  | 'meeting.export'
  | 'meeting.chat'
  | 'meeting.regenerate'
  | 'meeting.edit_brief'
  | 'dictation.create'
  | 'capture.create'
  | 'capture.delete'
  | 'mcp.query'
  | 'auth.signin'
  | 'auth.upgrade'
  | 'settings.update'
  | 'onboarding.complete'
  | 'device.pair'
  | 'billing.checkout'
  | 'billing.update';

export async function log(
  db: AppDb,
  args: {
    userId: string;
    eventType: EventType;
    meetingId?: string;
    dictationId?: string;
    metadata?: Record<string, unknown>;
  },
) {
  await db.insert(activityLog).values({
    id: pid('act'),
    userId: args.userId,
    eventType: args.eventType,
    meetingId: args.meetingId,
    dictationId: args.dictationId,
    metadataJson: encode(args.metadata ?? {}),
    createdAt: Date.now(),
  });
}

export async function listForUser(db: AppDb, args: { userId: string; limit?: number }) {
  return await db
    .select()
    .from(activityLog)
    .where(eq(activityLog.userId, args.userId))
    .orderBy(desc(activityLog.createdAt))
    .limit(args.limit ?? 200);
}
