import { and, eq, isNull } from 'drizzle-orm';
import type { Queue } from '@cloudflare/workers-types';
import { meetingBots, users } from '@/db/schema';
import { pid } from '@/db/ids';
import type { AppDb } from '@/db/client';
import { type EmailEnv, sendEmail } from '@/server/email/resend';
import type { QueueMessage } from '@/server/queue';
import type { CanaryEnv, MeetingBotControl, MeetingBotsEnv } from './control';
import { type BotPlatform, type MeetingBot, TERMINAL_BOT_STATUSES, botById, parseMeetingUrl } from './service';

/**
 * The notetaker's daily canary. Joining and speaker detection lean on Meet's
 * and Teams' own page text, which changes under us every few weeks; once a
 * day a bot joins a standing test meeting on each, stays a couple of minutes
 * (service.ts, `watchBot`), and is checked here. A bot that never got in, or
 * read no names off the call, raises an alert. Canary bots belong to a
 * system account, make no meeting and drop their audio, so nothing lands in
 * anyone's library.
 */

export type CanaryRunEnv = MeetingBotsEnv & CanaryEnv & EmailEnv & { PROCESSING_QUEUE: Queue<QueueMessage> };

/** Daily, at a quiet hour; the processing Worker's hourly sweep runs on its own cron. */
export const CANARY_CRON = '20 7 * * *';
/** Owner of every canary bot. Created on first use, dated 0 so no daily metric counts it. */
export const CANARY_USER_ID = 'user_eavesy_canary';
/** Start, join (two minutes at most), a couple of minutes in, leave: all done well within this. */
export const CANARY_CHECK_AFTER_SECONDS = 10 * 60;
/** A bot just in that hasn't sent its first heartbeat yet is looked at again this much later. */
export const CANARY_RECHECK_SECONDS = 3 * 60;
const MAX_CHECKS = 2;

const PLATFORMS: { platform: BotPlatform; label: string; url: (env: CanaryEnv) => string | undefined }[] = [
  { platform: 'meet', label: 'Google Meet', url: (env) => env.CANARY_MEET_URL },
  { platform: 'teams', label: 'Teams', url: (env) => env.CANARY_TEAMS_URL },
];

export type CanaryFailure = 'invalid_url' | 'schedule_failed' | 'did_not_join' | 'no_speakers' | 'check_failed';

const FAILURE_TEXT: Record<CanaryFailure, string> = {
  invalid_url: 'The configured test meeting link is not one the notetaker can join.',
  schedule_failed: 'The meeting-bot Worker could not be reached to start the bot.',
  did_not_join: 'The bot did not get into the call.',
  no_speakers: 'The bot got into the call but read no participant or speaker names.',
  check_failed: 'The check on the bot kept failing, so this run could not be judged.',
};

interface CanaryAlert {
  /** Absent only when a failed check couldn't tell which platform it was for. */
  platform?: BotPlatform;
  reason: CanaryFailure;
  botId?: string;
  status?: string;
  statusDetail?: string | null;
}

/** Sends a bot to each configured test meeting. Does nothing when none is configured. */
export async function startCanaries(db: AppDb, env: CanaryRunEnv, now = Date.now()) {
  const targets = PLATFORMS.map((p) => ({ ...p, configured: p.url(env)?.trim() })).filter((p) => p.configured);
  if (!targets.length) return [];
  const control = env.MEETING_BOTS;
  if (!control) {
    // Configured but not bound: a misdeploy, which is what the canary is for.
    for (const target of targets) await raiseCanaryAlert(env, { platform: target.platform, reason: 'schedule_failed' });
    return [];
  }
  try {
    await db.insert(users).values({
      id: CANARY_USER_ID,
      displayName: 'Eavesy canary',
      defaultTranscriptionEngine: 'whisper',
      createdAt: 0,
      updatedAt: 0,
    }).onConflictDoNothing();
  } catch (error) {
    console.error(JSON.stringify({ message: 'canary account write failed', error: error instanceof Error ? error.message : String(error) }));
    for (const target of targets) await raiseCanaryAlert(env, { platform: target.platform, reason: 'schedule_failed' });
    return [];
  }

  const started: string[] = [];
  for (const target of targets) {
    const parsed = parseMeetingUrl(target.configured!);
    if (!parsed || parsed.platform !== target.platform) {
      await raiseCanaryAlert(env, { platform: target.platform, reason: 'invalid_url' });
      continue;
    }
    try {
      const id = await startCanary(db, env, control, parsed, target.label, now);
      if (id) started.push(id);
    } catch (error) {
      // One platform's failure doesn't keep the other from being checked.
      console.error(JSON.stringify({ message: 'canary start failed', platform: target.platform, error: error instanceof Error ? error.message : String(error) }));
      await raiseCanaryAlert(env, { platform: target.platform, reason: 'schedule_failed' });
    }
  }
  return started;
}

async function startCanary(db: AppDb, env: CanaryRunEnv, control: MeetingBotControl, target: { url: string; platform: BotPlatform }, label: string, now: number) {
  const id = pid('bot', now);
  await db.insert(meetingBots).values({
    id,
    userId: CANARY_USER_ID,
    provider: 'eavesy',
    providerBotId: id,
    meetingUrl: target.url,
    platform: target.platform,
    title: `Canary: ${label}`,
    status: 'scheduling',
    canary: true,
    createdAt: now,
    updatedAt: now,
  });
  // Only while unclaimed: a bot that started anyway is left to its check.
  const giveUp = async () => (await db.update(meetingBots).set({ status: 'failed', statusDetail: 'provider_unavailable', updatedAt: Date.now() })
    .where(and(eq(meetingBots.id, id), eq(meetingBots.status, 'scheduling'), isNull(meetingBots.statusDetail)))
    .returning({ id: meetingBots.id })).length > 0;
  try {
    // Queued before the bot can start, so a bot that started is always judged and sent home.
    await env.PROCESSING_QUEUE.send({ kind: 'check-canary', botId: id, platform: target.platform }, { delaySeconds: CANARY_CHECK_AFTER_SECONDS });
  } catch (error) {
    console.error(JSON.stringify({ message: 'canary check could not be queued', botId: id, error: error instanceof Error ? error.message : String(error) }));
    await giveUp();
    await raiseCanaryAlert(env, { platform: target.platform, reason: 'schedule_failed', botId: id });
    return null;
  }
  try {
    await control.schedule(id, null);
  } catch (error) {
    console.error(JSON.stringify({ message: 'canary schedule failed', botId: id, error: error instanceof Error ? error.message : String(error) }));
    if (!(await giveUp())) return id;
    await stopBot(env, id); // its claim now fails; this covers anything already running
    await raiseCanaryAlert(env, { platform: target.platform, reason: 'schedule_failed', botId: id });
    return null;
  }
  // The bot may already have claimed its start; that's further along. Its check doesn't need this.
  await db.update(meetingBots).set({ status: 'scheduled', updatedAt: Date.now() })
    .where(and(eq(meetingBots.id, id), eq(meetingBots.status, 'scheduling')))
    .catch((error: unknown) => console.error(JSON.stringify({ message: 'canary status write failed', botId: id, error: error instanceof Error ? error.message : String(error) })));
  console.log(JSON.stringify({ message: 'canary started', botId: id, platform: target.platform }));
  return id;
}

/** What a canary bot's row says about its run: passed, failed, or still too early to tell. */
export function canaryVerdict(bot: Pick<MeetingBot, 'status' | 'canaryNames'>): 'passed' | 'pending' | CanaryFailure {
  if (bot.canaryNames === null) return 'did_not_join';
  if (bot.canaryNames > 0) return 'passed';
  // In, but no names yet: the first heartbeat comes a minute after joining.
  return TERMINAL_BOT_STATUSES.includes(bot.status) ? 'no_speakers' : 'pending';
}

/** Queue job a few minutes after a canary started: judges it, and sends home a bot still out. */
export async function checkCanary(db: AppDb, env: CanaryRunEnv, botId: string, check = 1) {
  const bot = await botById(db, botId);
  if (!bot?.canary) return;
  if (bot.statusDetail === 'provider_unavailable') return; // never started; alerted then
  let verdict = canaryVerdict(bot);
  if (verdict === 'pending' && check < MAX_CHECKS) {
    await env.PROCESSING_QUEUE.send({ kind: 'check-canary', botId, platform: bot.platform, check: check + 1 }, { delaySeconds: CANARY_RECHECK_SECONDS });
    return;
  }
  if (verdict === 'pending') verdict = 'no_speakers';
  // Stuck in a lobby, still loading, or overstaying: it has had its time.
  if (verdict !== 'passed') await sendHome(db, env, bot, 'canary_timeout');
  else if (!TERMINAL_BOT_STATUSES.includes(bot.status)) await stopBot(env, bot.id);
  if (verdict === 'passed') {
    console.log(JSON.stringify({ message: 'canary passed', botId, platform: bot.platform, names: bot.canaryNames }));
    return;
  }
  await raiseCanaryAlert(env, { platform: bot.platform, reason: verdict, botId, status: bot.status, statusDetail: bot.statusDetail });
}

/** The check job ran out of retries: still say so, and don't leave the bot in the meeting. */
export async function failCanaryCheck(db: AppDb, env: CanaryRunEnv, botId: string, platform: BotPlatform | undefined, error: string) {
  console.error(JSON.stringify({ message: 'canary check failed', botId, error: error.slice(0, 300) }));
  const bot = await botById(db, botId).catch(() => undefined);
  if (bot && !bot.canary) return;
  if (bot) await sendHome(db, env, bot, 'canary_check_failed');
  else await stopBot(env, botId);
  await raiseCanaryAlert(env, { platform: bot?.platform ?? platform, reason: 'check_failed', botId, status: bot?.status, statusDetail: bot?.statusDetail });
}

async function stopBot(env: CanaryRunEnv, botId: string) {
  await env.MEETING_BOTS?.stop(botId).catch((error: unknown) =>
    console.error(JSON.stringify({ message: 'canary stop failed', botId, error: error instanceof Error ? error.message : String(error) })));
}

/** Stops a failed canary still out and marks it failed, keeping the reason it gave. */
async function sendHome(db: AppDb, env: CanaryRunEnv, bot: MeetingBot, detail: string) {
  if (TERMINAL_BOT_STATUSES.includes(bot.status)) return;
  await stopBot(env, bot.id);
  // Only from the status read: a bot that moved on since is judged as it is now.
  await db.update(meetingBots).set({ status: 'failed', statusDetail: bot.statusDetail ?? detail, updatedAt: Date.now() })
    .where(and(eq(meetingBots.id, bot.id), eq(meetingBots.status, bot.status)));
}

/**
 * A structured error Workers observability can alert on (`alert` =
 * `meeting_bot_canary`), and an email when Resend and a recipient are set.
 * Never the meeting link: it would let anyone into the test meeting.
 */
export async function raiseCanaryAlert(env: CanaryRunEnv, alert: CanaryAlert) {
  const platform = PLATFORMS.find((p) => p.platform === alert.platform)?.label ?? 'an unknown platform';
  console.error(JSON.stringify({ message: 'meeting bot canary failed', alert: 'meeting_bot_canary', ...alert }));
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.CANARY_ALERT_EMAIL) return;
  const lines = [
    `The notetaker's daily canary failed on ${platform}: ${FAILURE_TEXT[alert.reason]}`,
    alert.status ? `Last status: ${alert.status}${alert.statusDetail ? ` (${alert.statusDetail})` : ''}` : null,
    alert.botId ? `Bot: ${alert.botId}. Its container logs are in the eavesy-meeting-bot Worker's observability.` : null,
    'Meet and Teams may have changed their page; see docs/plans/self-hosted-meeting-bot.md.',
  ].filter((line): line is string => Boolean(line));
  try {
    await sendEmail({ RESEND_API_KEY: env.RESEND_API_KEY, EMAIL_FROM: env.EMAIL_FROM }, {
      to: env.CANARY_ALERT_EMAIL,
      subject: `Eavesy notetaker canary failed on ${platform}`,
      text: lines.join('\n\n'),
      html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(''),
      tags: { kind: 'meeting_bot_canary' },
      idempotencyKey: `canary:${alert.botId ?? `${alert.platform}:${new Date().toISOString().slice(0, 10)}`}`,
    });
  } catch (error) {
    console.error(JSON.stringify({ message: 'canary alert email failed', error: error instanceof Error ? error.message : String(error) }));
  }
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
