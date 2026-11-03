import { LogLevel, SocketModeClient, type Logger } from '@slack/socket-mode';
import type { Issues } from '../patrol/issues.js';
import type { SlackOutbox } from '../output/slack.js';
import { redact } from '../engine/text.js';
import { onClick, RESPONSE_URL, type ButtonIds, type ClickResult } from './buttons.js';

// Button clicks arrive over Socket Mode: an outbound WebSocket opened with the
// app-level token (connections:write), so the engine needs no public URL. Only
// block_actions are handled. Each click is recorded before Slack is
// acknowledged (Slack wants that within 3 s); then the clicker gets a reply
// only they see, and the outbox sends the message update. There is no timer:
// the outbox is flushed after a click, and a failed post waits for its backoff.

export interface SocketClient {
  on(event: string, handler: (arg: { body?: unknown; ack?: () => Promise<void> }) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface ButtonsOptions {
  appToken: string;
  appId: string;
  channel: string;
  team: () => Promise<string>; // the bot's workspace (auth.test)
  issues: Issues;
  outbox: SlackOutbox;
  log: (s: string) => void;
  client?: (appToken: string) => SocketClient; // tests
  respond?: (url: string, text: string) => Promise<void>; // tests
  now?: () => Date;
  retryMs?: number; // between attempts to learn the workspace
}

// A reply only the clicker sees, through the click's response_url.
export async function respond(url: string, text: string, timeoutMs = 10_000): Promise<void> {
  if (!RESPONSE_URL.test(url)) throw new Error('not a Slack response_url');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// The SDK may log whole envelopes at debug level: payloads, response URLs and
// connection URLs never reach the engine's logs.
const quiet = (log: (s: string) => void): Logger => ({
  debug: () => {},
  info: () => {},
  warn: () => log('Slack Socket Mode: warning'),
  error: () => log('Slack Socket Mode: error'),
  setLevel: () => {},
  getLevel: () => LogLevel.ERROR,
  setName: () => {},
});

export function startButtons(o: ButtonsOptions): { ready: Promise<void>; stop(): Promise<void> } {
  const client = o.client?.(o.appToken) ?? new SocketModeClient({ appToken: o.appToken, logger: quiet(o.log), logLevel: LogLevel.ERROR });
  let stopped = false;
  let ids: ButtonIds | undefined; // the workspace first: a click is checked against it
  client.on('interactive', ({ body, ack }) => {
    let r: ClickResult = {};
    try {
      if (ids) r = onClick(body, { issues: o.issues, outbox: o.outbox, ids, log: o.log, ...(o.now ? { now: o.now } : {}) });
    } catch (e) {
      o.log(`buttons: a click could not be recorded: ${redact((e as Error).message).slice(0, 200)}`);
      const url = (body as { response_url?: unknown } | undefined)?.response_url;
      r = typeof url === 'string' && RESPONSE_URL.test(url) ? { respondTo: url, reply: 'The engine could not record that click. Nothing changed; try again.' } : {};
    }
    void (ack?.() ?? Promise.resolve())
      .then(async () => {
        if (r.reply && r.respondTo) await (o.respond ?? respond)(r.respondTo, r.reply).catch(() => o.log('buttons: the reply to a click failed'));
        if (r.updated && !stopped) await o.outbox.flush(o.log);
      })
      .catch(() => o.log('buttons: Slack did not take the acknowledgement'));
  });
  client.on('connected', () => o.log('Slack Socket Mode connected: buttons on'));
  client.on('disconnected', () => o.log('Slack Socket Mode disconnected'));
  const ready = (async () => {
    for (let wait = o.retryMs ?? 60_000; !stopped; wait = Math.min(wait * 2, 15 * 60_000)) {
      try {
        ids ??= { app: o.appId, team: await o.team(), channel: o.channel };
        await client.start();
        return;
      } catch (e) {
        o.log(`buttons: not started (${redact((e as Error).message).slice(0, 160)}); trying again in ${Math.round(wait / 1000)} s. Monitoring continues.`);
        await new Promise((r) => setTimeout(r, wait).unref());
      }
    }
  })();
  return {
    ready,
    async stop() {
      stopped = true;
      await client.disconnect().catch(() => {});
    },
  };
}
