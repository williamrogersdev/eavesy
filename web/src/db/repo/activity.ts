import { desc, eq } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { activityLog } from '../schema';
import { encode } from '../codec';
import { trackEvent } from '../../server/observability';

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
  | 'device.pair';

// Activity that is also a product analytics event. Only these metadata keys,
// with short enum-like values, are forwarded; never titles or content.
const PRODUCT_EVENTS: Partial<Record<EventType, string>> = {
  'device.pair': 'mac_paired',
  'capture.create': 'capture_created',
  'dictation.create': 'dictation_created',
  'meeting.start': 'meeting_started',
  'onboarding.complete': 'onboarding_completed',
};
const PRODUCT_EVENT_KEYS = ['kind', 'captureMode', 'source', 'platform'];

function productProperties(metadata: Record<string, unknown> = {}) {
  const out: Record<string, string> = {};
  for (const key of PRODUCT_EVENT_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string' && /^[a-z0-9_-]{1,32}$/i.test(value)) out[key] = value;
  }
  return out;
}

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
  const productEvent = PRODUCT_EVENTS[args.eventType];
  if (productEvent) trackEvent(args.userId, productEvent, productProperties(args.metadata));
}

export async function listForUser(db: AppDb, args: { userId: string; limit?: number }) {
  return await db
    .select()
    .from(activityLog)
    .where(eq(activityLog.userId, args.userId))
    .orderBy(desc(activityLog.createdAt))
    .limit(args.limit ?? 200);
}
