import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Every Slack post goes through an outbox in the engine's SQLite file. A post
// counts as delivered only after Slack says ok; a failure waits for the next
// patrol (the model never re-runs for it) and gives up after a day. With the bot
// (chat.postMessage), later news about the same rows goes into the first
// message's thread instead of a new message; the webhook can't thread, so it
// posts everything top-level as before.

export interface SlackMessage {
  text: string; // notification fallback
  blocks: unknown[];
}

export interface Transport {
  readonly threads: boolean;
  // Resolves with the message ts (bot) or nothing (webhook). Throws SlackError.
  post(m: SlackMessage & { thread_ts?: string; reply_broadcast?: boolean }): Promise<string | undefined>;
}

export class SlackError extends Error {
  constructor(
    message: string,
    readonly retryAfterSec?: number, // set on 429
    readonly permanent = false, // retrying can't help (bad blocks, too long)
  ) {
    super(message);
  }
}

// Slack's own errors that no retry fixes.
const PERMANENT = new Set(['invalid_blocks', 'invalid_blocks_format', 'msg_too_long', 'no_text', 'invalid_arguments', 'too_many_attachments']);

const NO_UNFURL = { unfurl_links: false, unfurl_media: false }; // link previews are an outbound channel

export function botTransport(token: string, channel: string, timeoutMs = 10_000): Transport {
  return {
    threads: true,
    async post(m) {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
        body: JSON.stringify({ channel, text: m.text, blocks: m.blocks, ...(m.thread_ts ? { thread_ts: m.thread_ts, reply_broadcast: !!m.reply_broadcast } : {}), ...NO_UNFURL }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) throw new SlackError('Slack: rate limited', Number(res.headers.get('retry-after') ?? 30));
      if (!res.ok) throw new SlackError(`Slack: HTTP ${res.status}`);
      const j = (await res.json()) as { ok: boolean; ts?: string; error?: string };
      if (!j.ok) throw new SlackError(`Slack: ${j.error ?? 'unknown error'}`, j.error === 'ratelimited' ? 30 : undefined, PERMANENT.has(j.error ?? ''));
      return j.ts;
    },
  };
}

export function webhookTransport(url: string, timeoutMs = 10_000): Transport {
  return {
    threads: false,
    async post(m) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: m.text, blocks: m.blocks, ...NO_UNFURL }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) throw new SlackError('Slack webhook: rate limited', Number(res.headers.get('retry-after') ?? 30));
      if (!res.ok) {
        const body = await res.text();
        throw new SlackError(`Slack webhook: HTTP ${res.status} ${body.slice(0, 100)}`, undefined, res.status === 400 && /invalid_blocks|no_text/.test(body));
      }
      return undefined;
    },
  };
}

// rows: an urgent rows card. report: an AI report. recovered: a thread reply
// that rows are back to normal (only when they have a thread).
export type PostKind = 'rows' | 'report' | 'recovered';

export interface Post {
  kind: PostKind;
  message: SlackMessage;
  keys: string[]; // the patrol rows this post is about: they pick the thread
  broadcast: boolean; // news worth showing in the channel when it lands in a thread
  file?: string; // the card on disk
}

export interface FlushResult {
  sent: number;
  pending: number;
  failed: number; // permanent errors and posts that gave up
  skipped: number; // recoveries with no thread to reply in
}

export interface OutboxOptions {
  threadHours?: number; // a row's thread takes replies this long after its last post
  freshMinutes?: number; // a reply to a thread opened this recently isn't broadcast: it's the same news
  giveUpHours?: number;
  gapMs?: number; // Slack allows about one message per second per channel
  maxWaitSec?: number; // honour Retry-After up to this, else leave the rest for the next patrol
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const H = 3600_000;

export class SlackOutbox {
  private readonly db: DatabaseSync;
  private readonly o: Required<OutboxOptions>;

  constructor(
    file: string,
    private readonly transport: Transport,
    opts: OutboxOptions = {},
  ) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS slack_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, kind TEXT NOT NULL,
        keys TEXT NOT NULL, broadcast INTEGER NOT NULL, message TEXT NOT NULL, file TEXT,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        sent_at TEXT, ts TEXT, thread_ts TEXT
      );
      CREATE INDEX IF NOT EXISTS slack_outbox_pending ON slack_outbox (status) WHERE status = 'pending';
      CREATE TABLE IF NOT EXISTS slack_threads (key TEXT PRIMARY KEY, ts TEXT NOT NULL, opened_at TEXT NOT NULL, last_at TEXT NOT NULL);
    `);
    this.o = {
      threadHours: 24,
      freshMinutes: 30,
      giveUpHours: 24,
      gapMs: 1100,
      maxWaitSec: 10,
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...opts,
    };
  }

  get threads(): boolean {
    return this.transport.threads;
  }

  enqueue(p: Post): number {
    const r = this.db
      .prepare(`INSERT INTO slack_outbox (created_at, kind, keys, broadcast, message, file, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
      .run(this.o.now().toISOString(), p.kind, JSON.stringify(p.keys), p.broadcast ? 1 : 0, JSON.stringify(p.message), p.file ?? null);
    return Number(r.lastInsertRowid);
  }

  // The open thread these rows already have, if exactly one. Rows split across
  // threads (rare) get a fresh message that becomes their thread.
  private threadFor(keys: string[], now: Date): { ts: string; opened_at: string } | undefined {
    if (!this.transport.threads || !keys.length) return undefined;
    const since = new Date(now.getTime() - this.o.threadHours * H).toISOString();
    const rows = this.db
      .prepare(`SELECT DISTINCT ts, opened_at FROM slack_threads WHERE key IN (${keys.map(() => '?').join(',')}) AND last_at >= ?`)
      .all(...keys, since) as Array<{ ts: string; opened_at: string }>;
    return rows.length === 1 ? rows[0] : undefined;
  }

  // Of these rows, the ones with an open thread, grouped by thread: recoveries
  // only make sense as a reply where the problem was posted.
  groupByThread(keys: string[]): string[][] {
    if (!this.transport.threads || !keys.length) return [];
    const since = new Date(this.o.now().getTime() - this.o.threadHours * H).toISOString();
    const rows = this.db
      .prepare(`SELECT key, ts FROM slack_threads WHERE key IN (${keys.map(() => '?').join(',')}) AND last_at >= ?`)
      .all(...keys, since) as Array<{ key: string; ts: string }>;
    const by = new Map<string, string[]>();
    for (const r of rows) by.set(r.ts, [...(by.get(r.ts) ?? []), r.key]);
    return [...by.values()];
  }

  // Send what is pending, oldest first. Never throws: Slack being down must not
  // stop a patrol or re-run the model.
  async flush(log: (s: string) => void = () => {}): Promise<FlushResult> {
    const out: FlushResult = { sent: 0, pending: 0, failed: 0, skipped: 0 };
    const pending = this.db.prepare(`SELECT * FROM slack_outbox WHERE status = 'pending' ORDER BY id`).all() as Array<{
      id: number; created_at: string; kind: PostKind; keys: string; broadcast: number; message: string; attempts: number;
    }>;
    let first = true;
    let waits = 0; // Retry-After waits this flush, so a 429 storm can't hold the patrol
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i]!;
      const now = this.o.now();
      if (now.getTime() - Date.parse(p.created_at) > this.o.giveUpHours * H) {
        this.db.prepare(`UPDATE slack_outbox SET status = 'gave_up' WHERE id = ?`).run(p.id);
        log(`slack: gave up on ${p.kind} post ${p.id} after ${p.attempts} attempt(s)`);
        out.failed++;
        continue;
      }
      const keys = JSON.parse(p.keys) as string[];
      const thread = this.threadFor(keys, now);
      if (p.kind === 'recovered' && !thread) {
        this.db.prepare(`UPDATE slack_outbox SET status = 'skipped' WHERE id = ?`).run(p.id);
        out.skipped++;
        continue;
      }
      const fresh = thread && now.getTime() - Date.parse(thread.opened_at) < this.o.freshMinutes * 60_000;
      if (!first) await this.o.sleep(this.o.gapMs);
      first = false;
      try {
        const ts = await this.transport.post({
          ...(JSON.parse(p.message) as SlackMessage),
          ...(thread ? { thread_ts: thread.ts, reply_broadcast: !!p.broadcast && !fresh } : {}),
        });
        const at = this.o.now().toISOString();
        this.db.prepare(`UPDATE slack_outbox SET status = 'sent', attempts = attempts + 1, sent_at = ?, ts = ?, thread_ts = ?, last_error = NULL WHERE id = ?`).run(at, ts ?? null, thread?.ts ?? null, p.id);
        // Rows posted top-level start (or move to) this message's thread; a reply keeps the thread alive.
        const root = thread?.ts ?? ts;
        if (root && p.kind !== 'recovered') {
          const up = this.db.prepare(
            `INSERT INTO slack_threads (key, ts, opened_at, last_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts, opened_at = CASE WHEN slack_threads.ts = excluded.ts THEN slack_threads.opened_at ELSE excluded.opened_at END, last_at = excluded.last_at`,
          );
          for (const k of keys) up.run(k, root, thread?.opened_at ?? at, at);
        }
        out.sent++;
      } catch (e) {
        const err = e instanceof SlackError ? e : new SlackError((e as Error).message);
        const status = err.permanent ? 'failed' : 'pending';
        this.db.prepare(`UPDATE slack_outbox SET status = ?, attempts = attempts + 1, last_error = ? WHERE id = ?`).run(status, err.message.slice(0, 300), p.id);
        log(`slack: ${p.kind} post ${p.id} ${err.permanent ? 'failed' : 'will retry'}: ${err.message.slice(0, 160)}`);
        if (err.permanent) {
          out.failed++;
          continue;
        }
        if (err.retryAfterSec !== undefined && err.retryAfterSec <= this.o.maxWaitSec && waits++ < 2) {
          await this.o.sleep(err.retryAfterSec * 1000);
          i--; // the same post again, once the wait is over
          continue;
        }
        // Rate limited for long, or Slack unreachable: the rest waits for the next patrol.
        out.pending = pending.length - i;
        return out;
      }
    }
    return out;
  }

  // For get_run and the daily status line.
  status(): Array<{ status: string; n: number }> {
    return (this.db.prepare(`SELECT status, COUNT(*) AS n FROM slack_outbox GROUP BY status ORDER BY status`).all() as Array<{ status: string; n: number }>).map((r) => ({ status: r.status, n: Number(r.n) }));
  }
}
