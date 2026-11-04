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
// tracked, past the 24 h row window, and broadcasts exactly when asked. With
// the buttons on (Socket Mode, slack/buttons.ts), an issue's first message
// carries them and is updated in place (chat.update) when they are clicked.

export interface SlackMessage {
  text: string; // notification fallback
  blocks: unknown[];
}

export interface Transport {
  readonly threads: boolean;
  // Resolves with the message ts (bot) or nothing (webhook). Throws SlackError.
  post(m: SlackMessage & { thread_ts?: string; reply_broadcast?: boolean }): Promise<string | undefined>;
  // Replaces a message the bot posted (chat.update). The bot only.
  update?(ts: string, m: SlackMessage): Promise<void>;
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
const PERMANENT = new Set(['invalid_blocks', 'invalid_blocks_format', 'msg_too_long', 'no_text', 'invalid_arguments', 'too_many_attachments', 'message_not_found', 'cant_update_message', 'edit_window_closed']);

const NO_UNFURL = { unfurl_links: false, unfurl_media: false }; // link previews are an outbound channel

export function botTransport(token: string, channel: string, timeoutMs = 10_000): Transport & { team(): Promise<string> } {
  const call = async (method: string, body: Record<string, unknown>) => {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429) throw new SlackError('Slack: rate limited', Number(res.headers.get('retry-after') ?? 30));
    if (!res.ok) throw new SlackError(`Slack: HTTP ${res.status}`);
    const j = (await res.json()) as { ok: boolean; ts?: string; team_id?: string; error?: string };
    if (!j.ok) throw new SlackError(`Slack: ${j.error ?? 'unknown error'}`, j.error === 'ratelimited' ? 30 : undefined, PERMANENT.has(j.error ?? ''));
    return j;
  };
  return {
    threads: true,
    async post(m) {
      return (await call('chat.postMessage', { channel, text: m.text, blocks: m.blocks, ...(m.thread_ts ? { thread_ts: m.thread_ts, reply_broadcast: !!m.reply_broadcast } : {}), ...NO_UNFURL })).ts;
    },
    async update(ts, m) {
      await call('chat.update', { channel, ts, text: m.text, blocks: m.blocks });
    },
    // The workspace the bot is in (auth.test needs no scope): button clicks from elsewhere are refused.
    async team() {
      const j = await call('auth.test', {});
      if (!j.team_id) throw new SlackError('Slack: auth.test returned no team');
      return j.team_id;
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

// rows: an urgent rows card (or code's line on an issue someone is on).
// report: an AI report. recovered: a thread reply that rows are back to normal
// (only when they have a thread). root: an issue's first message again, with
// its buttons as they now stand (chat.update, not a new message).
export type PostKind = 'rows' | 'report' | 'recovered' | 'root';

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
  // The buttons (Socket Mode on): the blocks shown under an issue's first
  // message, as the issue now stands. Absent: no buttons, no updates.
  controls?: ((issue: string) => unknown[] | undefined) | undefined;
}

const H = 3600_000;
const SENDER_LEASE_MS = 60_000; // renewed while sending; transport calls time out after 10 s
const BACKOFF_CAP_MS = 15 * 60_000; // one patrol

// After a failed attempt, the post waits before the next one: the outbox is
// flushed after every button click too, not only by the patrol. The first retry
// may go at the next flush, then 30 s, 1 min, 2 min… up to 15 min (±20 %), and
// never before Slack's Retry-After.
function retryDelayMs(attempts: number, retryAfterSec?: number): number {
  const backoff = attempts <= 1 ? 0 : Math.min(BACKOFF_CAP_MS, 30_000 * 2 ** (attempts - 2) * (0.8 + 0.4 * Math.random()));
  const after = retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
  return Math.max(backoff, after);
}

// Queue an update of the issue's first message on any connection to
// engine.db, inside the caller's transaction: a click commits together with
// its update (patrol/issues.ts click()).
export function queueRootUpdate(db: DatabaseSync, issue: string, at: Date): void {
  // The update it replaces may be waiting for Slack's Retry-After: so does this one.
  const was = db.prepare(`SELECT attempts, next_attempt_at FROM slack_outbox WHERE kind = 'root' AND issue = ? AND status = 'pending_update' ORDER BY id DESC LIMIT 1`).get(issue) as { attempts: number; next_attempt_at: string | null } | undefined;
  db.prepare(`UPDATE slack_outbox SET status = 'superseded' WHERE kind = 'root' AND issue = ? AND status = 'pending_update'`).run(issue);
  db.prepare(`INSERT INTO slack_outbox (created_at, kind, keys, broadcast, message, status, issue, attempts, next_attempt_at) VALUES (?, 'root', '[]', 0, '{"text":"","blocks":[]}', 'pending_update', ?, ?, ?)`).run(
    at.toISOString(),
    issue,
    was?.attempts ?? 0,
    was?.next_attempt_at ?? null,
  );
}

type Pending = {
  id: number; created_at: string; kind: PostKind; keys: string; broadcast: number; message: string; attempts: number; issue: string | null; repeat: number; next_attempt_at: string | null;
};

export class SlackOutbox {
  private readonly db: DatabaseSync;
  private readonly o: Required<Omit<OutboxOptions, 'controls'>> & Pick<OutboxOptions, 'controls'>;

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
    // Not before this time (a failed post's backoff), and whether the channel saw it (top-level or broadcast).
    if (!cols.has('next_attempt_at')) this.db.exec(`ALTER TABLE slack_outbox ADD COLUMN next_attempt_at TEXT`);
    if (!cols.has('in_channel')) this.db.exec(`ALTER TABLE slack_outbox ADD COLUMN in_channel INTEGER`);
    // When the issue's first message last showed its buttons.
    const threadCols = new Set((this.db.prepare(`PRAGMA table_info(slack_issue_threads)`).all() as Array<{ name: string }>).map((c) => c.name));
    if (!threadCols.has('controls_at')) this.db.exec(`ALTER TABLE slack_issue_threads ADD COLUMN controls_at TEXT`);
    // When a row's recovery note was last posted. A row owes one only after a
    // later post about it: a row that came back without a post goes back quietly too.
    const rowCols = new Set((this.db.prepare(`PRAGMA table_info(slack_threads)`).all() as Array<{ name: string }>).map((c) => c.name));
    if (!rowCols.has('recovered_at')) this.db.exec(`ALTER TABLE slack_threads ADD COLUMN recovered_at TEXT`);
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

  get buttons(): boolean {
    return !!this.o.controls;
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
  private issueThread(issue: string): { ts: string | null; opened_at: string; controls_at: string | null } | undefined {
    return this.db.prepare(`SELECT ts, opened_at, controls_at FROM slack_issue_threads WHERE issue = ?`).get(issue) as { ts: string | null; opened_at: string; controls_at: string | null } | undefined;
  }

  // Whether anything about the issue was delivered. Until then a repeat about
  // it is sent as its first post, shown in the channel (see sendPost).
  reached(issue: string): boolean {
    return !!this.issueThread(issue);
  }

  // The issue whose first message this is (a button click names the message).
  issueAt(ts: string): string | undefined {
    const rows = this.db.prepare(`SELECT issue FROM slack_issue_threads WHERE ts = ?`).all(ts) as Array<{ issue: string }>;
    return rows.length === 1 ? rows[0]!.issue : undefined;
  }

  // When the channel last saw a post about this issue, by Slack's answer, not
  // by when it was queued: the issue's first message (or the rows card it
  // started under), or a later post shown in the channel. The reminder clock.
  // Posts sent before in_channel existed count when top-level or broadcast.
  newsAt(issue: string): string | undefined {
    const r = this.db
      .prepare(
        `SELECT MAX(at) AS at FROM (SELECT opened_at AS at FROM slack_issue_threads WHERE issue = ?
         UNION ALL SELECT sent_at FROM slack_outbox WHERE issue = ? AND status = 'sent' AND kind <> 'root' AND (in_channel = 1 OR (in_channel IS NULL AND (thread_ts IS NULL OR broadcast = 1))))`,
      )
      .get(issue, issue) as { at: string | null };
    return r.at ?? undefined;
  }

  // News about this issue for the channel (top-level or broadcast) still
  // queued: Slack hasn't taken it yet, so a reminder would only add to it.
  newsPending(issue: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM slack_outbox WHERE issue = ? AND status = 'pending' AND broadcast = 1 AND kind <> 'recovered'`).get(issue);
  }

  // Show the issue's first message again with its buttons as they now stand
  // (a click, resolved, a mute ended). Rendered when sent, so the latest state
  // wins and two clicks before a flush make one update. Its own status:
  // an older image would post a queued 'pending' row as a new message.
  updateRoot(issue: string): void {
    if (!this.o.controls) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      queueRootUpdate(this.db, issue, this.o.now());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // The issue's first message as posted, with the buttons' blocks under it.
  private rootView(issue: string): { ts: string; message: SlackMessage } | undefined {
    const t = this.issueThread(issue);
    if (!t?.ts || !this.o.controls) return undefined;
    const root = this.db.prepare(`SELECT message FROM slack_outbox WHERE ts = ? AND thread_ts IS NULL AND status = 'sent' AND kind IN ('rows', 'report') ORDER BY id LIMIT 1`).get(t.ts) as { message: string } | undefined;
    const extra = root && this.o.controls(issue);
    if (!root || !extra) return undefined;
    const m = JSON.parse(root.message) as SlackMessage;
    return { ts: t.ts, message: { text: m.text, blocks: [...m.blocks, ...extra] } };
  }

  // Of these rows, the ones with an open thread, grouped by thread: recoveries
  // only make sense as a reply where the problem was posted. One post, one
  // recovery note at most: a row already noted back isn't again until posted
  // again. A note listing it answers it, also an issue's resolved note and
  // one sent before recovered_at was kept. A post still queued for it counts:
  // the note goes out after it.
  groupByThread(keys: string[]): string[][] {
    if (!this.transport.threads || !keys.length) return [];
    const since = new Date(this.o.now().getTime() - this.o.threadHours * H).toISOString();
    const queued = `EXISTS (SELECT 1 FROM slack_outbox o, json_each(o.keys) j WHERE o.status = 'pending' AND o.kind IN ('rows', 'report') AND j.value = slack_threads.key)`;
    const noted = `EXISTS (SELECT 1 FROM slack_outbox o, json_each(o.keys) j WHERE o.kind = 'recovered' AND o.status IN ('sent', 'pending') AND j.value = slack_threads.key AND o.created_at >= slack_threads.last_at)`;
    const rows = this.db
      .prepare(`SELECT key, ts FROM slack_threads WHERE key IN (${keys.map(() => '?').join(',')}) AND last_at >= ? AND (${queued} OR ((recovered_at IS NULL OR recovered_at < last_at) AND NOT ${noted}))`)
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

  // What this sender would send. Message updates wait for one with the buttons.
  private pendingCount(): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM slack_outbox WHERE status IN ('pending', ${this.o.controls ? `'pending_update'` : `''`})`).get() as { n: number }).n);
  }

  private async sendPending(log: (s: string) => void, renew: () => boolean): Promise<FlushResult> {
    const out: FlushResult = { sent: 0, pending: 0, failed: 0, skipped: 0 };
    let waits = 0; // Retry-After waits this flush, so a 429 storm can't hold the patrol
    let last = 0;
    // Oldest first, one at a time, so a post queued while this flush runs (a
    // click's update) goes out in it too instead of waiting for the next patrol.
    const next = () => this.db.prepare(`SELECT * FROM slack_outbox WHERE status IN ('pending', 'pending_update') AND id > ? ORDER BY id LIMIT 1`).get(last) as Pending | undefined;
    for (let p = next(); p; p = next()) {
      if (!renew()) break;
      const now = this.o.now();
      if (now.getTime() - Date.parse(p.created_at) > this.o.giveUpHours * H) {
        this.db.prepare(`UPDATE slack_outbox SET status = 'gave_up' WHERE id = ?`).run(p.id);
        log(`slack: gave up on ${p.kind} post ${p.id} after ${p.attempts} attempt(s)`);
        out.failed++;
        last = p.id;
        continue;
      }
      // A sender without the buttons (a one-shot `patrol --post`) leaves message
      // updates queued for the one that has them, and holds nothing back for them.
      if (p.kind === 'root' && !this.o.controls) {
        last = p.id;
        continue;
      }
      // Posts go out in order (a reply needs its root): one that isn't due yet holds the rest.
      if (p.next_attempt_at && Date.parse(p.next_attempt_at) > now.getTime()) break;
      const step = p.kind === 'root' ? await this.sendRoot(p, out, log, renew) : await this.sendPost(p, now, out, log, renew);
      if (step === 'stop') break;
      if (step === 'sent' || step === 'done') {
        last = p.id;
        continue;
      }
      // Failed, and Slack can be retried.
      const err = step;
      if (err.retryAfterSec !== undefined && err.retryAfterSec <= this.o.maxWaitSec && waits++ < 2) {
        await this.o.sleep(err.retryAfterSec * 1000);
        continue; // the same post again, once the wait is over
      }
      // Rate limited for long, or Slack unreachable: not again before its backoff.
      // A message update a click replaced while it was out hands that wait to its replacement.
      const attempts = p.attempts + 1;
      const waiting = p.kind === 'root' ? (this.db.prepare(`SELECT id FROM slack_outbox WHERE kind = 'root' AND issue = ? AND status = 'pending_update' AND id >= ? ORDER BY id DESC LIMIT 1`).get(p.issue, p.id) as { id: number } | undefined) : undefined;
      this.db
        .prepare(`UPDATE slack_outbox SET next_attempt_at = ?, attempts = MAX(attempts, ?) WHERE id = ?`)
        .run(new Date(this.o.now().getTime() + retryDelayMs(attempts, err.retryAfterSec)).toISOString(), attempts, waiting?.id ?? p.id);
      break;
    }
    out.pending = this.pendingCount();
    return out;
  }

  // Wait for the channel's gap, then call Slack. 'stop' when the lease is gone.
  private async attempt<T>(renew: () => boolean, call: () => Promise<T>): Promise<{ ok: T } | { err: SlackError } | 'stop'> {
    // Persist the gap across flushes too: an urgent card is flushed before
    // the model, and a fast investigation may finish less than a second later.
    const last = this.db.prepare(`SELECT last_attempt_at FROM slack_sender WHERE id = 1`).get() as { last_attempt_at: number | null };
    const wait = last.last_attempt_at === null ? 0 : this.o.gapMs - (this.o.now().getTime() - last.last_attempt_at);
    if (wait > 0) await this.o.sleep(wait);
    if (!renew()) return 'stop';
    this.db.prepare(`UPDATE slack_sender SET last_attempt_at = ? WHERE id = 1`).run(this.o.now().getTime());
    try {
      return { ok: await call() };
    } catch (e) {
      return { err: e instanceof SlackError ? e : new SlackError((e as Error).message) };
    }
  }

  // A failure is recorded; a permanent one is final ('done'), the others are
  // returned for a retry. A message update replaced while it was out stays replaced.
  private failed(p: Pending, err: SlackError, out: FlushResult, log: (s: string) => void): 'done' | SlackError {
    this.db
      .prepare(`UPDATE slack_outbox SET status = CASE WHEN status = 'superseded' THEN status ELSE ? END, attempts = attempts + 1, last_error = ? WHERE id = ?`)
      .run(err.permanent ? 'failed' : p.kind === 'root' ? 'pending_update' : 'pending', err.message.slice(0, 300), p.id);
    log(`slack: ${p.kind} post ${p.id} ${err.permanent ? 'failed' : 'will retry'}: ${err.message.slice(0, 160)}`);
    if (!err.permanent) return err;
    out.failed++;
    return 'done';
  }

  private async sendPost(p: Pending, now: Date, out: FlushResult, log: (s: string) => void, renew: () => boolean): Promise<'sent' | 'done' | 'stop' | SlackError> {
    const keys = JSON.parse(p.keys) as string[];
    // An issue already in Slack keeps its thread, however old, and the caller
    // decides the broadcast. A repeat where it can't thread (the webhook, or
    // its thread is unknown) isn't posted: it says nothing new. One about an
    // issue that never reached Slack is its first post, so it goes out as one.
    const known = p.issue ? this.issueThread(p.issue) : undefined;
    const inIssue = known?.ts && this.transport.threads ? { ts: known.ts, opened_at: known.opened_at } : undefined;
    // A new issue may start in its rows' thread (this patrol's urgent card),
    // never in another issue's: a different cause gets its own message.
    const rowThread = inIssue ? undefined : this.threadFor(keys, now);
    const taken = !!(p.issue && rowThread && this.db.prepare(`SELECT 1 FROM slack_issue_threads WHERE ts = ? AND issue <> ?`).get(rowThread.ts, p.issue));
    const thread = inIssue ?? (taken ? undefined : rowThread);
    const noThread = p.kind === 'recovered' ? !thread : !!(p.repeat && known && !inIssue);
    if (noThread) {
      this.db.prepare(`UPDATE slack_outbox SET status = 'skipped' WHERE id = ?`).run(p.id);
      if (p.kind !== 'recovered') log(`slack: ${p.kind} post ${p.id} about ${p.issue} not sent: a repeat, and there is no thread to reply in`);
      out.skipped++;
      return 'done';
    }
    const fresh = !inIssue && thread && now.getTime() - Date.parse(thread.opened_at) < this.o.freshMinutes * 60_000;
    const broadcast = !!thread && !!p.broadcast && !fresh;
    // The buttons go on an issue's first message, when it is one.
    const buttons = !thread && p.issue && p.kind !== 'recovered' && this.transport.threads ? this.o.controls?.(p.issue) : undefined;
    const base = JSON.parse(p.message) as SlackMessage;
    const r = await this.attempt(renew, () => this.transport.post({ ...base, ...(buttons ? { blocks: [...base.blocks, ...buttons] } : {}), ...(thread ? { thread_ts: thread.ts, reply_broadcast: broadcast } : {}) }));
    if (r === 'stop') return 'stop';
    if ('err' in r) return this.failed(p, r.err, out, log);
    const ts = r.ok;
    const at = this.o.now().toISOString();
    this.db
      .prepare(`UPDATE slack_outbox SET status = 'sent', attempts = attempts + 1, sent_at = ?, ts = ?, thread_ts = ?, in_channel = ?, last_error = NULL WHERE id = ?`)
      .run(at, ts ?? null, thread?.ts ?? null, !thread || broadcast ? 1 : 0, p.id);
    // Rows posted top-level start (or move to) this message's thread; a reply keeps the thread alive.
    const root = thread?.ts ?? ts;
    // The first post about an issue gives it its thread (none with the webhook).
    if (p.issue && p.kind !== 'recovered') {
      this.db
        .prepare(`INSERT INTO slack_issue_threads (issue, ts, opened_at) VALUES (?, ?, ?) ON CONFLICT(issue) DO UPDATE SET ts = excluded.ts, opened_at = excluded.opened_at WHERE slack_issue_threads.ts IS NULL AND excluded.ts IS NOT NULL`)
        .run(p.issue, root ?? null, thread?.opened_at ?? at);
      if (buttons) this.db.prepare(`UPDATE slack_issue_threads SET controls_at = ? WHERE issue = ? AND ts = ?`).run(at, p.issue, ts ?? null);
      // Its first message was not this one (the rows card it started under,
      // or one posted before the buttons): show them there, once.
      else if (this.o.controls && this.issueThread(p.issue)?.controls_at === null && !this.db.prepare(`SELECT 1 FROM slack_outbox WHERE kind = 'root' AND issue = ?`).get(p.issue)) this.updateRoot(p.issue);
    }
    if (root && p.kind === 'recovered') {
      const noted = this.db.prepare(`UPDATE slack_threads SET recovered_at = ? WHERE key = ?`);
      for (const k of keys) noted.run(at, k);
    }
    if (root && p.kind !== 'recovered') {
      const up = this.db.prepare(
        `INSERT INTO slack_threads (key, ts, opened_at, last_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts, opened_at = CASE WHEN slack_threads.ts = excluded.ts THEN slack_threads.opened_at ELSE excluded.opened_at END, last_at = excluded.last_at`,
      );
      for (const k of keys) up.run(k, root, thread?.opened_at ?? at, at);
    }
    out.sent++;
    return 'sent';
  }

  private async sendRoot(p: Pending, out: FlushResult, log: (s: string) => void, renew: () => boolean): Promise<'sent' | 'done' | 'stop' | SlackError> {
    const view = p.issue ? this.rootView(p.issue) : undefined;
    const update = this.transport.update?.bind(this.transport);
    if (!view || !update) {
      this.db.prepare(`UPDATE slack_outbox SET status = 'skipped' WHERE id = ?`).run(p.id);
      out.skipped++;
      return 'done';
    }
    const r = await this.attempt(renew, () => update(view.ts, view.message));
    if (r === 'stop') return 'stop';
    if ('err' in r) return this.failed(p, r.err, out, log);
    const at = this.o.now().toISOString();
    this.db.prepare(`UPDATE slack_outbox SET status = 'sent', attempts = attempts + 1, sent_at = ?, ts = ?, in_channel = 0, last_error = NULL WHERE id = ?`).run(at, view.ts, p.id);
    this.db.prepare(`UPDATE slack_issue_threads SET controls_at = ? WHERE issue = ?`).run(at, p.issue);
    out.sent++;
    return 'sent';
  }

  // For get_run and the daily status line.
  status(): Array<{ status: string; n: number }> {
    return (this.db.prepare(`SELECT status, COUNT(*) AS n FROM slack_outbox GROUP BY status ORDER BY status`).all() as Array<{ status: string; n: number }>).map((r) => ({ status: r.status, n: Number(r.n) }));
  }
}
