import { SocketModeClient, type Logger, LogLevel } from '@slack/socket-mode';
import { Interactions, type InteractionContext } from './interactions.js';

export interface SocketClient {
  on(event: string, handler: (arg: any) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export function startSocket(ctx: InteractionContext, factory?: (appToken: string) => SocketClient) {
  const config = ctx.cfg.slackInteraction;
  if (!config) throw new Error('Socket Mode is not configured');
  const worker = new Interactions(ctx);
  // The SDK may log raw envelopes at debug level. Never pass payloads, URLs,
  // connection responses or credentials to application logs, even on errors.
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => ctx.log?.('Slack Socket Mode warning'),
    error: () => ctx.log?.('Slack Socket Mode error'),
    setLevel: () => {},
    getLevel: () => LogLevel.ERROR,
    setName: () => {},
  };
  const client =
    factory?.(config.appToken) ??
    new SocketModeClient({ appToken: config.appToken, logger, logLevel: LogLevel.ERROR, clientOptions: { retryConfig: { retries: 2 }, timeout: 10_000 } });
  const receive = ({ body, ack }: { body: unknown; ack: () => Promise<unknown> }) => {
    try {
      worker.receive(body);
      // Invalid/unauthorized messages are also acknowledged so Slack does not
      // retry them. Storage failures are deliberately left unacknowledged.
      void ack()
        .then(() => worker.drain())
        .catch(() => ctx.log?.('Slack acknowledgement failed; waiting for retry'));
    } catch {
      ctx.log?.('Slack event could not be persisted; waiting for retry');
    }
  };
  client.on('interactive', receive);
  client.on('app_mention', receive);
  client.on('error', () => ctx.log?.('Slack Socket Mode connection error'));
  client.on('connected', () => ctx.log?.('Slack Socket Mode connected'));
  client.on('disconnected', () => ctx.log?.('Slack Socket Mode disconnected'));
  void client.start().catch(() => ctx.log?.('Slack Socket Mode could not start; check app permissions, token and network. Monitoring continues.'));
  const timer = setInterval(() => void worker.drain(), 5000);
  timer.unref();
  void worker.drain();
  return {
    worker,
    async stop() {
      clearInterval(timer);
      worker.stop();
      await client.disconnect();
    },
  };
}
