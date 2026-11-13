import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { chosenModel, DEFAULT_ASSISTANT_MODEL } from '@/lib/ai/model-choice';

/** The model the account chose for Eavesy's assistant, or the default. */
export async function assistantModelFor(userId: string): Promise<string> {
  const row = (await getDb().select({ assistantModel: users.assistantModel }).from(users).where(eq(users.id, userId)).limit(1))[0];
  return chosenModel(row?.assistantModel, DEFAULT_ASSISTANT_MODEL);
}
