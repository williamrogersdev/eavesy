import { Container } from '@cloudflare/containers';

/**
 * Eavesy's meeting bots. Each bot is one container running the Rust driver
 * in `bot/` (Chromium joining a Meet or Teams call), owned by one Durable
 * Object named after the bot's id.
 *
 * This first version only defines the container, so the image builds and
 * deploys on its own; the web app starts using it in a later change.
 */

interface Env {
  MEETING_BOT: DurableObjectNamespace<MeetingBot>;
}

export class MeetingBot extends Container<Env> {
  defaultPort = 8080;
  // The bot exits on its own when the call ends; this only reclaims a hung one.
  sleepAfter = '5h';
  enableInternet = true;
}

export default {
  fetch(): Response {
    return new Response('eavesy-meeting-bot', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
