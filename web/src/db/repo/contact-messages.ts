import { desc } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { contactMessages } from '../schema';

export async function create(
  db: AppDb,
  args: {
    name: string;
    email: string;
    topic?: string;
    message: string;
  },
): Promise<string> {
  const id = pid('msg');
  await db.insert(contactMessages).values({
    id,
    name: args.name,
    email: args.email,
    topic: args.topic ?? 'general',
    message: args.message,
    createdAt: Date.now(),
  });
  return id;
}

export async function listRecent(db: AppDb, args: { limit?: number } = {}) {
  return await db
    .select()
    .from(contactMessages)
    .orderBy(desc(contactMessages.createdAt))
    .limit(args.limit ?? 100);
}
