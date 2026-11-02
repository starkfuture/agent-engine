import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isQuiet, localClock, type NotificationPolicy } from './schedule.js';
import { cleanModelText, redact, slackEscape } from '../engine/text.js';

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
  update?(ts: string, m: SlackMessage): Promise<string | undefined>;
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

export function withControls(message: SlackMessage, status?: string): SlackMessage {
  return {
    ...message,
    blocks: [
      ...message.blocks,
      ...(status ? [{ type: 'context', elements: [{ type: 'plain_text', text: status.slice(0, 500) }] }] : []),
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'incident_on_it', text: { type: 'plain_text', text: 'On it' }, value: 'incident' },
          { type: 'button', action_id: 'incident_not_issue', text: { type: 'plain_text', text: 'Not an issue' }, value: 'incident' },
        ],
      },
    ],
  };
}

export function botTransport(token: string, channel: string, timeoutMs = 10_000): Transport {
  const call = async (method: string, body: Record<string, unknown>) => {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429) throw new SlackError('Slack: rate limited', Number(res.headers.get('retry-after') ?? 30));
    if (!res.ok) throw new SlackError(`Slack: HTTP ${res.status}`);
    const j = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    if (!j.ok) throw new SlackError(`Slack: ${j.error ?? 'unknown error'}`, j.error === 'ratelimited' ? 30 : undefined, PERMANENT.has(j.error ?? ''));
    if (!j.ts) throw new SlackError('Slack: successful response missing message timestamp');
    return j.ts;
  };
  return {
    threads: true,
    async post(m) {
      return call('chat.postMessage', { ...m, ...NO_UNFURL });
    },
    update: (ts, m) => call('chat.update', { ts, text: m.text, blocks: m.blocks }),
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
export type PostKind = 'rows' | 'report' | 'recovered' | 'reply' | 'update' | 'status' | 'digest';

export interface Post {
  kind: PostKind;
  message: SlackMessage;
  keys: string[]; // the patrol rows this post is about: they pick the thread
  broadcast: boolean; // news worth showing in the channel when it lands in a thread
  file?: string; // the card on disk
  targetTs?: string; // a validated engine root; replies/updates never choose another thread
  dedupeKey?: string;
  urgent?: boolean;
  actor?: { engineUser: string; slackUser: string };
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
  controls?: boolean; // opt-in only when the interaction worker is configured
  policy?: NotificationPolicy;
  destination?: string; // workspace/channel scope; never reuse history across destinations
  authorize?: (actor: NonNullable<Post['actor']>) => boolean;
}

const H = 3600_000;
const SENDER_LEASE_MS = 60_000; // renewed while sending; transport calls time out after 10 s

export class SlackOutbox {
  private readonly db: DatabaseSync;
  private readonly o: Required<Omit<OutboxOptions, 'policy' | 'authorize'>> & Pick<OutboxOptions, 'policy' | 'authorize'>;

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
      CREATE TABLE IF NOT EXISTS slack_health (id INTEGER PRIMARY KEY CHECK(id=1),at TEXT NOT NULL,bad_streak INTEGER NOT NULL,degraded_at TEXT,first_bad_at TEXT);
      CREATE TABLE IF NOT EXISTS slack_digest_items (digest_id INTEGER NOT NULL,post_id INTEGER NOT NULL UNIQUE,PRIMARY KEY(digest_id,post_id));
    `);
    const columns = new Set((this.db.prepare('PRAGMA table_info(slack_outbox)').all() as Array<{ name: string }>).map((c) => c.name));
    for (const column of ['target_ts', 'dedupe_key', 'destination', 'actor']) if (!columns.has(column)) this.db.exec(`ALTER TABLE slack_outbox ADD COLUMN ${column} TEXT`);
    const threadColumns = new Set((this.db.prepare('PRAGMA table_info(slack_threads)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!threadColumns.has('destination')) this.db.exec('ALTER TABLE slack_threads ADD COLUMN destination TEXT');
    if (!columns.has('urgent')) this.db.exec('ALTER TABLE slack_outbox ADD COLUMN urgent INTEGER NOT NULL DEFAULT 1');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS slack_outbox_dedupe ON slack_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL');
    this.o = {
      threadHours: 24,
      freshMinutes: 30,
      giveUpHours: 24,
      gapMs: 1100,
      maxWaitSec: 10,
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      controls: false,
      destination: 'local',
      ...opts,
    };
  }

  get threads(): boolean {
    return this.transport.threads;
  }
  get destination(): string {
    return this.o.destination;
  }

  enqueue(p: Post): number {
    if (p.targetTs && !/^\d{10,}\.\d{6}$/.test(p.targetTs)) throw new Error('invalid Slack timestamp');
    const urgent = p.urgent ?? ['rows', 'reply', 'update'].includes(p.kind);
    const dedupe = p.dedupeKey ? `${this.o.destination}:${p.dedupeKey}` : null;
    // Older images know only 'pending'. Keep interaction operations invisible
    // to them: a rollback must not turn chat.update into a new channel post.
    const status = !urgent && isQuiet(this.o.now(), this.o.policy) ? 'deferred' : ['reply', 'update'].includes(p.kind) ? 'pending_interaction' : 'pending';
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO slack_outbox (created_at, kind, keys, broadcast, message, file, status, target_ts, dedupe_key,urgent,destination,actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,?,?,?)`,
      )
      .run(
        this.o.now().toISOString(),
        p.kind,
        JSON.stringify(p.keys),
        p.broadcast ? 1 : 0,
        JSON.stringify(p.message),
        p.file ?? null,
        status,
        p.targetTs ?? null,
        dedupe,
        urgent ? 1 : 0,
        this.o.destination,
        p.actor ? JSON.stringify(p.actor) : null,
      );
    if (!r.changes && dedupe) return Number((this.db.prepare('SELECT id FROM slack_outbox WHERE dedupe_key = ?').get(dedupe) as { id: number }).id);
    return Number(r.lastInsertRowid);
  }

  // Only known, still-open engine roots can receive questions/actions. Context
  // comes from our own persisted messages, never arbitrary Slack history.
  threadInfo(ts: string): { keys: string[]; message: SlackMessage; context: string } | undefined {
    const since = new Date(this.o.now().getTime() - this.o.threadHours * H).toISOString();
    if (!this.db.prepare('SELECT 1 FROM slack_threads WHERE ts = ? AND last_at >= ? AND destination = ? LIMIT 1').get(ts, since, this.o.destination)) return undefined;
    const root = this.db
      .prepare(
        "SELECT message, keys FROM slack_outbox WHERE ts = ? AND thread_ts IS NULL AND status = 'sent' AND kind IN ('rows','report') AND destination = ? ORDER BY id LIMIT 1",
      )
      .get(ts, this.o.destination) as { message: string; keys: string } | undefined;
    if (!root) return undefined;
    const recent = this.db
      .prepare(
        "SELECT message FROM slack_outbox WHERE (ts = ? OR thread_ts = ?) AND status = 'sent' AND kind NOT IN ('update','reply') AND destination = ? ORDER BY id DESC LIMIT 8",
      )
      .all(ts, ts, this.o.destination) as Array<{ message: string }>;
    return {
      keys: JSON.parse(root.keys) as string[],
      message: JSON.parse(root.message) as SlackMessage,
      context: recent
        .reverse()
        .map((r) => r.message)
        .join('\n')
        .slice(0, 24000),
    };
  }

  private plain(title: string, body: string): SlackMessage {
    const text = slackEscape(cleanModelText(redact(`${title}\n${body}`)));
    return { text: text.slice(0, 3500), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } }] };
  }

  private prepareSchedule(): void {
    const now = this.o.now(),
      p = this.o.policy;
    this.db
      .prepare("UPDATE slack_outbox SET status='destination_review' WHERE status IN ('pending','pending_interaction','deferred') AND (destination IS NULL OR destination<>?)")
      .run(this.o.destination);
    if (isQuiet(now, p)) return;
    const local = localClock(now, p?.timezone ?? 'UTC');
    if (p?.quiet && local.minute < p.quiet.endMinute) return;
    const dedupeKey = `digest:${local.day}`;
    if (this.db.prepare('SELECT 1 FROM slack_outbox WHERE dedupe_key=?').get(`${this.o.destination}:${dedupeKey}`)) return;
    const rows = this.db.prepare("SELECT id,message FROM slack_outbox WHERE status='deferred' AND destination = ? ORDER BY id LIMIT 500").all(this.o.destination) as Array<{
      id: number;
      message: string;
    }>;
    if (!rows.length) return;
    const lines = rows.slice(0, 25).map((r) => {
      const m = JSON.parse(r.message) as SlackMessage;
      const run = /run (\d{8}T\d{6}Z-[a-z][a-z0-9-]*-[a-f0-9]{6})/.exec(r.message)?.[1];
      return `• ${m.text.slice(0, 180)}${run ? ` · get_run ${run}` : ''}`;
    });
    const body = [
      `${rows.length} nonurgent update(s) held during quiet hours.`,
      ...lines,
      rows.length > 25 ? `… ${rows.length - 25} more retained in engine records; use list_runs/get_run for full investigations.` : '',
      'This digest summarizes stored updates; it does not mark incidents resolved.',
    ]
      .filter(Boolean)
      .join('\n');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const id = this.enqueue({ kind: 'digest', keys: [], broadcast: false, message: this.plain(`Monitoring digest · ${local.day}`, body), dedupeKey, urgent: false });
      const record = this.db.prepare('INSERT OR IGNORE INTO slack_digest_items(digest_id,post_id) VALUES(?,?)');
      const mark = this.db.prepare("UPDATE slack_outbox SET status='digested' WHERE id=? AND status='deferred'");
      for (const row of rows) {
        record.run(id, row.id);
        mark.run(row.id);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  recordHealth(s: { at: string; sources: Array<{ source: string; ok: boolean }>; send?: unknown[]; known?: unknown[] }): void {
    const p = this.o.policy;
    if (!p || (!p.dailyHealth && !p.healthChanges)) return;
    const previous = this.db.prepare('SELECT * FROM slack_health WHERE id=1').get() as
      | { at: string; bad_streak: number; degraded_at: string | null; first_bad_at: string | null }
      | undefined;
    if (previous && previous.at >= s.at) return;
    const bad = s.sources.filter((x) => !x.ok).map((x) => x.source),
      streak = bad.length ? (previous?.bad_streak ?? 0) + 1 : 0;
    const first = bad.length ? (previous?.first_bad_at ?? s.at) : null;
    const degraded = bad.length ? (previous?.degraded_at ?? (streak >= 2 ? s.at : null)) : null;
    if (p.healthChanges && streak === 2)
      this.enqueue({
        kind: 'status',
        keys: [],
        broadcast: false,
        urgent: false,
        dedupeKey: `degraded:${first}`,
        message: this.plain('Monitoring coverage degraded', `Two patrols have blind sources: ${bad.join(', ')}. Other signals still run; missing data is not healthy.`),
      });
    if (p.healthChanges && !bad.length && previous?.degraded_at)
      this.enqueue({
        kind: 'status',
        keys: [],
        broadcast: false,
        urgent: false,
        dedupeKey: `restored:${previous.degraded_at}`,
        message: this.plain(
          'Monitoring coverage restored',
          `All configured collectors answered at ${s.at}. This describes observation coverage, not proof that every customer journey is healthy.`,
        ),
      });
    this.db
      .prepare(
        'INSERT INTO slack_health(id,at,bad_streak,degraded_at,first_bad_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,bad_streak=excluded.bad_streak,degraded_at=excluded.degraded_at,first_bad_at=excluded.first_bad_at',
      )
      .run(s.at, streak, degraded, first);
    const local = localClock(new Date(s.at), p.timezone);
    if (p.dailyHealth && local.minute >= p.dailyMinute) {
      const counts =
        this.status()
          .filter((x) => ['pending', 'pending_interaction', 'deferred', 'failed', 'gave_up', 'destination_review'].includes(x.status))
          .map((x) => `${x.status} ${x.n}`)
          .join(', ') || 'no waiting/failed entries';
      this.enqueue({
        kind: 'status',
        keys: [],
        broadcast: false,
        urgent: false,
        dedupeKey: `health:${local.day}`,
        message: this.plain(
          `Daily monitoring status · ${local.day}`,
          `Patrol ${s.at}: ${bad.length ? `blind sources ${bad.join(', ')}` : 'all configured collectors answered'}. ${s.send?.length ?? 0} new/worse, ${s.known?.length ?? 0} ongoing signals. Outbox: ${counts}. Coverage is not a declaration of customer journey health.`,
        ),
      });
    }
  }

  // The open thread these rows already have, if exactly one. Rows split across
  // threads (rare) get a fresh message that becomes their thread.
  private threadFor(keys: string[], now: Date): { ts: string; opened_at: string } | undefined {
    if (!this.transport.threads || !keys.length) return undefined;
    const since = new Date(now.getTime() - this.o.threadHours * H).toISOString();
    const rows = this.db
      .prepare(`SELECT DISTINCT ts, opened_at FROM slack_threads WHERE key IN (${keys.map(() => '?').join(',')}) AND last_at >= ? AND destination = ?`)
      .all(...keys, since, this.o.destination) as Array<{ ts: string; opened_at: string }>;
    return rows.length === 1 ? rows[0] : undefined;
  }

  // Of these rows, the ones with an open thread, grouped by thread: recoveries
  // only make sense as a reply where the problem was posted.
  groupByThread(keys: string[]): string[][] {
    if (!this.transport.threads || !keys.length) return [];
    const since = new Date(this.o.now().getTime() - this.o.threadHours * H).toISOString();
    const rows = this.db
      .prepare(`SELECT key, ts FROM slack_threads WHERE key IN (${keys.map(() => '?').join(',')}) AND last_at >= ? AND destination = ?`)
      .all(...keys, since, this.o.destination) as Array<{ key: string; ts: string }>;
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
    const claimed = this.db
      .prepare(
        `INSERT INTO slack_sender (id, owner, expires_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE slack_sender.expires_at <= ?`,
      )
      .run(owner, expiry(), now.toISOString()).changes;
    if (!claimed) return { sent: 0, pending: this.pendingCount(), failed: 0, skipped: 0 };
    let held = true;
    const renew = () => held && !!this.db.prepare(`UPDATE slack_sender SET expires_at = ? WHERE id = 1 AND owner = ?`).run(expiry(), owner).changes;
    const heartbeat = setInterval(() => {
      try {
        held = renew();
      } catch {
        held = false;
      }
    }, SENDER_LEASE_MS / 3);
    heartbeat.unref();
    try {
      this.prepareSchedule();
      return await this.sendPending(log, renew);
    } finally {
      clearInterval(heartbeat);
      this.db.prepare(`UPDATE slack_sender SET owner = '', expires_at = '1970-01-01T00:00:00.000Z' WHERE id = 1 AND owner = ?`).run(owner);
    }
  }

  private pendingCount(): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM slack_outbox WHERE status IN ('pending','pending_interaction')`).get() as { n: number }).n);
  }

  private async sendPending(log: (s: string) => void, renew: () => boolean): Promise<FlushResult> {
    const out: FlushResult = { sent: 0, pending: 0, failed: 0, skipped: 0 };
    const pending = this.db.prepare(`SELECT * FROM slack_outbox WHERE status IN ('pending','pending_interaction') ORDER BY id`).all() as Array<{
      id: number;
      created_at: string;
      kind: PostKind;
      keys: string;
      broadcast: number;
      message: string;
      attempts: number;
      target_ts: string | null;
      urgent: number;
      status: string;
      destination: string | null;
      actor: string | null;
    }>;
    let waits = 0; // Retry-After waits this flush, so a 429 storm can't hold the patrol
    for (let i = 0; i < pending.length; i++) {
      if (!renew()) {
        out.pending = this.pendingCount();
        return out;
      }
      const p = pending[i]!;
      const now = this.o.now();
      if (p.actor && !this.o.authorize?.(JSON.parse(p.actor) as NonNullable<Post['actor']>)) {
        this.db.prepare("UPDATE slack_outbox SET status='revoked' WHERE id=?").run(p.id);
        out.skipped++;
        continue;
      }
      if (p.destination !== this.o.destination) {
        this.db.prepare("UPDATE slack_outbox SET status='destination_review' WHERE id=?").run(p.id);
        log(`slack: post ${p.id} held for destination review`);
        continue;
      }
      if (!p.urgent && isQuiet(now, this.o.policy)) {
        this.db.prepare("UPDATE slack_outbox SET status='deferred' WHERE id=?").run(p.id);
        continue;
      }
      if (now.getTime() - Date.parse(p.created_at) > this.o.giveUpHours * H) {
        this.db.prepare(`UPDATE slack_outbox SET status = 'gave_up' WHERE id = ?`).run(p.id);
        log(`slack: gave up on ${p.kind} post ${p.id} after ${p.attempts} attempt(s)`);
        out.failed++;
        continue;
      }
      const keys = JSON.parse(p.keys) as string[];
      const thread = p.target_ts ? { ts: p.target_ts, opened_at: now.toISOString() } : this.threadFor(keys, now);
      if (p.kind === 'recovered' && !thread) {
        this.db.prepare(`UPDATE slack_outbox SET status = 'skipped' WHERE id = ?`).run(p.id);
        out.skipped++;
        continue;
      }
      const fresh = thread && now.getTime() - Date.parse(thread.opened_at) < this.o.freshMinutes * 60_000;
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
        const base = JSON.parse(p.message) as SlackMessage;
        const message = this.o.controls && !thread && keys.length && (p.kind === 'rows' || p.kind === 'report') ? withControls(base) : base;
        if (p.kind === 'update' && (!p.target_ts || !this.transport.update)) throw new SlackError('Slack updates are unavailable', undefined, true);
        const ts =
          p.kind === 'update'
            ? await this.transport.update!(p.target_ts!, message)
            : await this.transport.post({
                ...message,
                ...(thread ? { thread_ts: thread.ts, reply_broadcast: !!p.broadcast && !fresh } : {}),
              });
        const at = this.o.now().toISOString();
        this.db
          .prepare(`UPDATE slack_outbox SET status = 'sent', attempts = attempts + 1, sent_at = ?, ts = ?, thread_ts = ?, last_error = NULL WHERE id = ?`)
          .run(at, ts ?? null, thread?.ts ?? null, p.id);
        // Rows posted top-level start (or move to) this message's thread; a reply keeps the thread alive.
        const root = thread?.ts ?? ts;
        if (root && p.kind === 'reply') this.db.prepare('UPDATE slack_threads SET last_at = ? WHERE ts = ? AND destination = ?').run(at, root, this.o.destination);
        if (root && (p.kind === 'rows' || p.kind === 'report')) {
          const up = this.db.prepare(
            `INSERT INTO slack_threads (key, ts, opened_at, last_at,destination) VALUES (?, ?, ?, ?,?) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts, opened_at = CASE WHEN slack_threads.ts = excluded.ts THEN slack_threads.opened_at ELSE excluded.opened_at END, last_at = excluded.last_at,destination=excluded.destination`,
          );
          for (const k of keys) up.run(k, root, thread?.opened_at ?? at, at, this.o.destination);
        }
        out.sent++;
      } catch (e) {
        const err = e instanceof SlackError ? e : new SlackError((e as Error).message);
        const status = err.permanent ? 'failed' : p.status;
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
    return (this.db.prepare(`SELECT status, COUNT(*) AS n FROM slack_outbox GROUP BY status ORDER BY status`).all() as Array<{ status: string; n: number }>).map((r) => ({
      status: r.status,
      n: Number(r.n),
    }));
  }
}
