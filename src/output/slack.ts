import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

// Every Slack post goes through an outbox in the engine's SQLite file. A post
// counts as delivered only after Slack says ok; a failure waits for the next
// patrol (the model never re-runs for it) and gives up after a day. With the bot
// (chat.postMessage), later news about the same rows goes into the first
// message's thread instead of a new message; the webhook can't thread, so it
// posts everything top-level as before. A post about an issue (see
// patrol/issues.ts) goes into that issue's thread for as long as the issue is
// tracked, past the 24 h row window, and broadcasts exactly when asked.

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
  issue?: string | undefined; // the issue it is about: its thread wins over the rows'
  repeat?: boolean | undefined; // nothing new for the channel: a quiet reply in the issue's thread, or nothing
}

export interface FlushResult {
  sent: number;
  pending: number;
  failed: number; // permanent errors and posts that gave up
  skipped: number; // recoveries and issue repeats with no thread to reply in
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
const SENDER_LEASE_MS = 60_000; // renewed while sending; transport calls time out after 10 s

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
      CREATE TABLE IF NOT EXISTS slack_sender (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, expires_at TEXT NOT NULL, last_attempt_at INTEGER);
      -- An issue that reached Slack, and its thread (ts is NULL when it went out without one: the webhook).
      CREATE TABLE IF NOT EXISTS slack_issue_threads (issue TEXT PRIMARY KEY, ts TEXT, opened_at TEXT NOT NULL);
    `);
    const cols = new Set((this.db.prepare(`PRAGMA table_info(slack_outbox)`).all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('issue')) this.db.exec(`ALTER TABLE slack_outbox ADD COLUMN issue TEXT`);
    if (!cols.has('repeat')) this.db.exec(`ALTER TABLE slack_outbox ADD COLUMN repeat INTEGER NOT NULL DEFAULT 0`);
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
      .prepare(`INSERT INTO slack_outbox (created_at, kind, keys, broadcast, message, file, status, issue, repeat) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(this.o.now().toISOString(), p.kind, JSON.stringify(p.keys), p.broadcast ? 1 : 0, JSON.stringify(p.message), p.file ?? null, p.issue ?? null, p.repeat ? 1 : 0);
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

  // Whether an issue has reached Slack, and in which thread.
  private issueThread(issue: string): { ts: string | null; opened_at: string } | undefined {
    return this.db.prepare(`SELECT ts, opened_at FROM slack_issue_threads WHERE issue = ?`).get(issue) as { ts: string | null; opened_at: string } | undefined;
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
    // One sender for this channel/database, across instances and processes.
    // A crashed sender's lease expires; a late sender cannot release its
    // replacement's lease. Do not hold a SQLite transaction over network I/O.
    const owner = randomUUID();
    const now = this.o.now();
    const expiry = () => new Date(this.o.now().getTime() + SENDER_LEASE_MS).toISOString();
    const claimed = this.db.prepare(`INSERT INTO slack_sender (id, owner, expires_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE slack_sender.expires_at <= ?`)
      .run(owner, expiry(), now.toISOString()).changes;
    if (!claimed) return { sent: 0, pending: this.pendingCount(), failed: 0, skipped: 0 };
    let held = true;
    const renew = () => held && !!this.db.prepare(`UPDATE slack_sender SET expires_at = ? WHERE id = 1 AND owner = ?`).run(expiry(), owner).changes;
    const heartbeat = setInterval(() => {
      try { held = renew(); } catch { held = false; }
    }, SENDER_LEASE_MS / 3);
    heartbeat.unref();
    try {
      return await this.sendPending(log, renew);
    } finally {
      clearInterval(heartbeat);
      this.db.prepare(`UPDATE slack_sender SET owner = '', expires_at = '1970-01-01T00:00:00.000Z' WHERE id = 1 AND owner = ?`).run(owner);
    }
  }

  private pendingCount(): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM slack_outbox WHERE status = 'pending'`).get() as { n: number }).n);
  }

  private async sendPending(log: (s: string) => void, renew: () => boolean): Promise<FlushResult> {
    const out: FlushResult = { sent: 0, pending: 0, failed: 0, skipped: 0 };
    const pending = this.db.prepare(`SELECT * FROM slack_outbox WHERE status = 'pending' ORDER BY id`).all() as Array<{
      id: number; created_at: string; kind: PostKind; keys: string; broadcast: number; message: string; attempts: number; issue: string | null; repeat: number;
    }>;
    let waits = 0; // Retry-After waits this flush, so a 429 storm can't hold the patrol
    for (let i = 0; i < pending.length; i++) {
      if (!renew()) {
        out.pending = this.pendingCount();
        return out;
      }
      const p = pending[i]!;
      const now = this.o.now();
      if (now.getTime() - Date.parse(p.created_at) > this.o.giveUpHours * H) {
        this.db.prepare(`UPDATE slack_outbox SET status = 'gave_up' WHERE id = ?`).run(p.id);
        log(`slack: gave up on ${p.kind} post ${p.id} after ${p.attempts} attempt(s)`);
        out.failed++;
        continue;
      }
      const keys = JSON.parse(p.keys) as string[];
      // An issue already in Slack keeps its thread, however old, and the caller
      // decides the broadcast. A repeat where it can't thread (the webhook, or
      // its thread is unknown) isn't posted: it says nothing new. One about an
      // issue that never reached Slack is its first post, so it goes out as one.
      const known = p.issue ? this.issueThread(p.issue) : undefined;
      const inIssue = known?.ts && this.transport.threads ? { ts: known.ts, opened_at: known.opened_at } : undefined;
      const thread = inIssue ?? this.threadFor(keys, now);
      const noThread = p.kind === 'recovered' ? !thread : !!(p.repeat && known && !inIssue);
      if (noThread) {
        this.db.prepare(`UPDATE slack_outbox SET status = 'skipped' WHERE id = ?`).run(p.id);
        if (p.kind !== 'recovered') log(`slack: ${p.kind} post ${p.id} about ${p.issue} not sent: a repeat, and there is no thread to reply in`);
        out.skipped++;
        continue;
      }
      const fresh = !inIssue && thread && now.getTime() - Date.parse(thread.opened_at) < this.o.freshMinutes * 60_000;
      // Persist the gap across flushes too: an urgent card is flushed before
      // the model, and a fast investigation may finish less than a second later.
      const last = this.db.prepare(`SELECT last_attempt_at FROM slack_sender WHERE id = 1`).get() as { last_attempt_at: number | null };
      const wait = last.last_attempt_at === null ? 0 : this.o.gapMs - (this.o.now().getTime() - last.last_attempt_at);
      if (wait > 0) await this.o.sleep(wait);
      if (!renew()) {
        out.pending = this.pendingCount();
        return out;
      }
      this.db.prepare(`UPDATE slack_sender SET last_attempt_at = ? WHERE id = 1`).run(this.o.now().getTime());
      try {
        const ts = await this.transport.post({
          ...(JSON.parse(p.message) as SlackMessage),
          ...(thread ? { thread_ts: thread.ts, reply_broadcast: !!p.broadcast && !fresh } : {}),
        });
        const at = this.o.now().toISOString();
        this.db.prepare(`UPDATE slack_outbox SET status = 'sent', attempts = attempts + 1, sent_at = ?, ts = ?, thread_ts = ?, last_error = NULL WHERE id = ?`).run(at, ts ?? null, thread?.ts ?? null, p.id);
        // Rows posted top-level start (or move to) this message's thread; a reply keeps the thread alive.
        const root = thread?.ts ?? ts;
        // The first post about an issue gives it its thread (none with the webhook).
        if (p.issue && p.kind !== 'recovered')
          this.db
            .prepare(`INSERT INTO slack_issue_threads (issue, ts, opened_at) VALUES (?, ?, ?) ON CONFLICT(issue) DO UPDATE SET ts = excluded.ts, opened_at = excluded.opened_at WHERE slack_issue_threads.ts IS NULL AND excluded.ts IS NOT NULL`)
            .run(p.issue, root ?? null, thread?.opened_at ?? at);
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
        out.pending = this.pendingCount();
        return out;
      }
    }
    out.pending = this.pendingCount();
    return out;
  }

  // For get_run and the daily status line.
  status(): Array<{ status: string; n: number }> {
    return (this.db.prepare(`SELECT status, COUNT(*) AS n FROM slack_outbox GROUP BY status ORDER BY status`).all() as Array<{ status: string; n: number }>).map((r) => ({ status: r.status, n: Number(r.n) }));
  }
}
