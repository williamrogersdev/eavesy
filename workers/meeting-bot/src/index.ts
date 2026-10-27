import { Container, ContainerProxy, type StopParams } from '@cloudflare/containers';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { D1Database, Queue, R2Bucket } from '@cloudflare/workers-types';
import type { MeetingBotControl } from '@/server/meeting-bots/control';
import { START_ATTEMPTS, START_INSTANCE_TIMEOUT_MS, START_PORTS_TIMEOUT_MS, botDatabase, claimBotStart, failBotStart, handleBotEvent, handleBotSegment, launchingBot, nextStartAttemptAt, startWasCancelled, watchBot } from '@/server/meeting-bots/service';
import type { QueueMessage } from '@/server/queue';

/**
 * Eavesy's meeting bots. Each bot is one container running the Rust driver
 * in `bot/` (Chromium joining a Meet or Teams call), owned by one Durable
 * Object named after the bot's id. The web and processing Workers reach it
 * through `BotControl`; the bot reports back to `http://eavesy.internal`,
 * which never leaves Cloudflare: the container's outbound requests to that
 * host are handled here, and only for the bot that container runs.
 */

interface Env {
  MEETING_BOT: DurableObjectNamespace<MeetingBot>;
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  PROCESSING_QUEUE: Queue<QueueMessage>;
}

const INGEST_HOST = 'eavesy.internal';
/** How often the Durable Object checks on a bot it started. */
const WATCH_EVERY_MS = 2 * 60 * 1_000;
/** A start whose claim hit a database error is tried again this soon. */
const CLAIM_RETRY_MS = 30 * 1_000;

/** A container start to try again: which attempt it is, and when the start was claimed. */
interface StartRetry { botId: string; attempt: number; claimedAt: number }

const database = (env: Env) => botDatabase(env.DB);
const logError = (message: string, botId: string | undefined, error: unknown) =>
  console.error(JSON.stringify({ message, botId, error: error instanceof Error ? error.message : String(error) }));
const botObject = (env: Env, botId: string) => env.MEETING_BOT.get(env.MEETING_BOT.idFromName(botId));

/** The bot's segments and status reports. */
async function ingest(request: Request, env: Env, ctx: { containerId: string }): Promise<Response> {
  const match = /^\/bots\/([\w-]{1,100})\/(events|segments\/(\d{1,6}))$/.exec(new URL(request.url).pathname);
  if (!match) return Response.json({ error: 'not_found' }, { status: 404 });
  const [, botId, kind, idx] = match;
  // A container only ever reports for its own bot.
  if (env.MEETING_BOT.idFromName(botId).toString() !== ctx.containerId) return Response.json({ error: 'forbidden' }, { status: 403 });
  if (kind === 'events' && request.method === 'POST') return handleBotEvent(database(env), env, botId, request);
  if (idx !== undefined && request.method === 'PUT') return handleBotSegment(database(env), env, botId, idx, request);
  return Response.json({ error: 'method_not_allowed' }, { status: 405 });
}

export class MeetingBot extends Container<Env> {
  defaultPort = 8080;
  // The bot leaves on its own when the call ends (four hours at most); this only reclaims a hung one.
  sleepAfter = '5h';
  enableInternet = true;

  static outboundByHost = { [INGEST_HOST]: ingest };

  /** Starts the bot at `joinAt`. Repeats are harmless: only one start is ever claimed. */
  async prepare(botId: string, joinAt: number) {
    await this.ctx.storage.put('botId', botId);
    await this.schedule(new Date(Math.max(joinAt, Date.now())), 'launch', botId);
  }

  async launch(botId: string) {
    // Watch from before the claim, so whatever fails from here on is noticed:
    // a bot claimed but never started is failed by the watchdog.
    await this.schedule(new Date(Date.now() + WATCH_EVERY_MS), 'watch', botId);
    let start: Awaited<ReturnType<typeof claimBotStart>>;
    try {
      start = await claimBotStart(database(this.env), botId);
    } catch (error) {
      // Nothing was claimed, and a failed callback isn't run again: try shortly.
      logError('claiming meeting bot start failed', botId, error);
      await this.schedule(new Date(Date.now() + CLAIM_RETRY_MS), 'launch', botId);
      return;
    }
    if (!start) return; // cancelled, or already started
    await this.tryStart(botId, start, 1, Date.now());
  }

  /**
   * A later attempt at a container start that failed, most often for want of
   * capacity at that moment. The bot may have been cancelled meanwhile.
   */
  async retryStart({ botId, attempt, claimedAt }: StartRetry) {
    let start: Awaited<ReturnType<typeof launchingBot>>;
    try {
      start = await launchingBot(database(this.env), botId);
    } catch (error) {
      logError('reading meeting bot before a start retry failed', botId, error);
      await this.retryOrFail(botId, attempt, claimedAt); // counts as an attempt
      return;
    }
    if (start) await this.tryStart(botId, start, attempt, claimedAt);
  }

  private async tryStart(botId: string, start: NonNullable<Awaited<ReturnType<typeof launchingBot>>>, attempt: number, claimedAt: number) {
    try {
      await this.startContainer(botId, start);
    } catch (error) {
      logError(`meeting bot did not start (attempt ${attempt} of ${START_ATTEMPTS})`, botId, error);
      await this.shutDown().catch(() => undefined);
      await this.retryOrFail(botId, attempt, claimedAt);
      return;
    }
    // A cancel while the container was starting found nothing to stop: stop
    // it now, before it joins the call. Should this look fail, the watchdog
    // stops a cancelled bot's container at its next look.
    try {
      if (await startWasCancelled(database(this.env), botId)) await this.shutDown();
    } catch (error) {
      logError('checking for a cancel after the start failed', botId, error);
    }
  }

  /**
   * Schedules the next start attempt. When none is left, or scheduling it
   * throws, the bot is failed now rather than at the watchdog.
   */
  private async retryOrFail(botId: string, attempt: number, claimedAt: number) {
    const at = nextStartAttemptAt(attempt, claimedAt, Date.now());
    if (at !== null) {
      try {
        await this.schedule<StartRetry>(new Date(at), 'retryStart', { botId, attempt: attempt + 1, claimedAt });
        return;
      } catch (error) {
        logError('scheduling a meeting bot start retry failed', botId, error);
      }
    }
    // No image, no capacity, or the port never opened: say so now. The
    // watchdog still covers this write failing.
    await failBotStart(database(this.env), botId).catch((e: unknown) => logError('recording the failed start', botId, e));
  }

  private async startContainer(botId: string, start: NonNullable<Awaited<ReturnType<typeof launchingBot>>>) {
    await this.startAndWaitForPorts({
      // Explicit, so the retry timing in nextStartAttemptAt can count on them.
      cancellationOptions: { instanceGetTimeoutMS: START_INSTANCE_TIMEOUT_MS, portReadyTimeoutMS: START_PORTS_TIMEOUT_MS },
      startOptions: {
        envVars: {
          MEETING_URL: start.meetingUrl,
          PLATFORM: start.platform,
          BOT_NAME: start.botName,
          INGEST_URL: `http://${INGEST_HOST}/bots/${botId}`,
        },
        labels: { bot: botId },
      },
    });
  }

  async watch(botId: string) {
    let verdict: Awaited<ReturnType<typeof watchBot>> = 'watch';
    try {
      verdict = await watchBot(database(this.env), this.env, botId, await this.running());
    } catch (error) {
      logError('meeting bot watch failed', botId, error); // look again next time
    }
    // The next look is set before stopping, so a failed stop is tried again.
    // Everything that can fail above is caught; what's left is a row in this
    // object's own SQLite, which only fails if its storage does.
    if (verdict !== 'done') await this.schedule(new Date(Date.now() + WATCH_EVERY_MS), 'watch', botId);
    if (verdict === 'stop') await this.stop().catch((e: unknown) => logError('stopping meeting bot', botId, e)); // SIGTERM: leave and deliver
  }

  /**
   * Asks the bot to leave the call; false when no bot is running. A SIGTERM
   * makes it leave, deliver what it recorded and send `done`.
   */
  async requestLeave() {
    if (!(await this.running())) return false;
    await this.stop();
    return true;
  }

  async shutDown() {
    if (await this.running()) await this.stop();
  }

  override async onStop(params: StopParams) {
    const botId = await this.ctx.storage.get<string>('botId');
    console.log(JSON.stringify({ message: 'meeting bot stopped', botId, ...params }));
    // The watch still running for this bot covers a failure here.
    if (botId) await watchBot(database(this.env), this.env, botId, false).catch((e: unknown) => logError('meeting bot stop report failed', botId, e));
  }

  private async running() {
    const { status } = await this.getState();
    return status === 'running' || status === 'healthy';
  }
}

/** What the web and processing Workers call, through their `MEETING_BOTS` service binding. */
export class BotControl extends WorkerEntrypoint<Env> implements MeetingBotControl {
  async schedule(botId: string, joinAt: number | null) {
    await botObject(this.env, botId).prepare(botId, joinAt ?? Date.now());
  }

  async leave(botId: string) {
    return botObject(this.env, botId).requestLeave();
  }

  async stop(botId: string) {
    await botObject(this.env, botId).shutDown();
  }
}

export { ContainerProxy };

export default {
  fetch(): Response {
    return new Response('eavesy-meeting-bot', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
