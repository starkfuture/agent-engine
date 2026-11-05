import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { cleanModelText, redact } from '../engine/text.js';

// The findings feed: the engine's issues (patrol/issues.ts), read for local
// tools. A finding is an issue: one cause an AI report rated critical or major
// (the reports the engine itself posts), with an id like I-7f3a. Minor and
// noise reports, the code-only urgent rows cards and raw patrol rows are not
// findings. Reads go through a read-only connection to the engine's SQLite
// file, so this module cannot change anything.
//
// The cursor is in write order, not a time: events carry their patrol
// window's time, which is up to ~15 min (plus the investigation) older than
// when they are written, and many share one time, so a time cursor would skip
// what was written after a poll. It has two parts: the issue_events id, and
// the rowid of slack_issue_threads (an issue's Slack thread arrives after the
// event that opened it, when the outbox delivers; rows there are never deleted).

export type Level = 'critical' | 'major';
export type Status = 'open' | 'resolved';
export type Ack = 'on_it' | 'not_an_issue';

export interface Finding {
  id: string;
  level: Level;
  status: Status;
  title: string;
  summary: string; // the latest report's likely cause, one line; model-written, so plain untrusted text
  services: string[];
  repos: string[]; // GitHub owner/name; the engine has no service→repo map yet, so []
  runId: string | null; // the latest monitor run about it (MCP get_run)
  url: string | null; // its Slack thread, when it reached Slack through the bot
  ack: Ack | null; // On it, or Not an issue while its mute lasts
  at: string; // the latest report linked to it (patrol window time)
  openedAt: string;
  resolvedAt: string | null;
}

export interface Cursor {
  e: number; // issue_events id
  t: number; // slack_issue_threads rowid
}

export interface FeedQuery {
  after: Cursor; // from the cursor; zeros at the start
  since?: string | undefined; // ISO, first call only: changes at or after this patrol time
  minLevel: Level;
  status: Status | 'all';
  limit: number;
}

export interface FeedPage {
  findings: Array<{ finding: Finding; thread: string | null }>; // url is null here; the caller makes it from the Slack thread ts
  next: Cursor;
  more: boolean;
}

// What counts as a change a reader cares about: the issue's state, its latest
// report, or its button state. Reminders, rows cards and "worse" notes in its
// thread are not.
const CHANGES = ['opened', 'report_linked', 'severity_raised', 'resolved', 'reopened', 'acknowledged', 'dismissed', 'undone', 'mute_lifted'];
const LEVELS: Record<Level, Level[]> = { major: ['critical', 'major'], critical: ['critical'] };
const RUN_ID = /^\d{8}T\d{6}Z-[a-z][a-z0-9-]*-[0-9a-f]{6}$/;
// A service as patrol rows name it (a workload or app label). Anything else
// (a placeholder, or text that looks personal) is left out.
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const SCAN = 500;

// Stored text was redacted when written; redact again on the way out, since
// the rules have grown since (names and addresses, #25). Slack controls
// (<@U…>, <!channel>, <#C…>) and the issue's own row keys (a model may quote
// them; their subjects could hold a name before #25) don't leave either.
const clean = (s: string, n: number, keys: string[]) => {
  let t = cleanModelText(redact(s));
  for (const k of keys) if (k.length > 3) t = t.split(k).join('<row>');
  t = t
    .replace(/<[@#!][^<>\s]{1,80}>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

interface IssueRow {
  id: string;
  opened_at: string;
  last_at: string;
  resolved_at: string | null;
  status: Status;
  severity: string;
  title: string;
  disposition?: string | null;
  muted_until?: string | null;
}

export class FindingsFeed {
  private db: DatabaseSync | undefined;

  constructor(private readonly file: string) {}

  // Opened on first use: the issue record creates the file and its tables.
  private conn(): DatabaseSync {
    if (this.db) return this.db;
    if (!existsSync(this.file)) throw new Error('the engine database does not exist yet');
    const db = new DatabaseSync(this.file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    return (this.db = db);
  }

  private has(db: DatabaseSync, table: string): boolean {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  }

  // One page of issues that changed after the cursor, each once, with its
  // current state, in the order of its first change after the cursor (issue
  // events first, then Slack threads that arrived). `next` covers every change
  // before the first one not returned, so nothing is skipped; an issue that
  // changes again later comes again.
  page(q: FeedQuery, now = new Date()): FeedPage {
    const db = this.conn();
    // One read transaction: every query sees the same snapshot.
    db.exec('BEGIN');
    try {
      if (!this.has(db, 'issues') || !this.has(db, 'issue_events')) return { findings: [], next: q.after, more: false };
      const threads = this.has(db, 'slack_issue_threads');
      const head: Cursor = {
        e: Number((db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM issue_events`).get() as { n: number }).n),
        t: threads ? Number((db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM slack_issue_threads`).get() as { n: number }).n) : 0,
      };
      // A cursor past the end (the database was replaced): start again from its end.
      if (q.after.e > head.e || q.after.t > head.t) return { findings: [], next: head, more: false };
      const levels = LEVELS[q.minLevel];
      const statuses = q.status === 'all' ? ['open', 'resolved'] : [q.status];
      const filter = `i.severity IN (${levels.map(() => '?').join(',')}) AND i.status IN (${statuses.map(() => '?').join(',')})`;
      const ids: string[] = [];
      // Issues from one change stream, in order, until the page is full: then
      // the position just before the first change of an issue that didn't fit.
      const take = (sql: string, from: number, to: number, args: Array<string | number>): number | undefined => {
        const scan = db.prepare(`${sql} ORDER BY 1 LIMIT ${SCAN}`);
        for (;;) {
          const rows = scan.all(from, to, ...args) as Array<{ n: number; issue: string }>;
          for (const r of rows) {
            if (!ids.includes(r.issue)) {
              if (ids.length === q.limit) return Number(r.n) - 1;
              ids.push(r.issue);
            }
            from = Number(r.n);
          }
          if (rows.length < SCAN) return undefined;
        }
      };
      const stopE = take(
        `SELECT e.id AS n, e.issue_id AS issue FROM issue_events e JOIN issues i ON i.id = e.issue_id
         WHERE e.id > ? AND e.id <= ? AND e.type IN (${CHANGES.map(() => '?').join(',')}) AND ${filter} ${q.since ? 'AND e.at >= ?' : ''}`,
        q.after.e,
        head.e,
        [...CHANGES, ...levels, ...statuses, ...(q.since ? [q.since] : [])],
      );
      let next: Cursor = head;
      let more = false;
      if (stopE !== undefined) {
        next = { e: stopE, t: q.after.t };
        more = true;
      } else if (threads) {
        const stopT = take(
          `SELECT t.rowid AS n, t.issue AS issue FROM slack_issue_threads t JOIN issues i ON i.id = t.issue
           WHERE t.rowid > ? AND t.rowid <= ? AND t.ts IS NOT NULL AND ${filter} ${q.since ? 'AND t.opened_at >= ?' : ''}`,
          q.after.t,
          head.t,
          [...levels, ...statuses, ...(q.since ? [q.since] : [])],
        );
        if (stopT !== undefined) {
          next = { e: head.e, t: stopT };
          more = true;
        }
      }
      return { findings: ids.map((id) => this.finding(db, id, threads, now)), next, more };
    } finally {
      // A read transaction; never leave one open, or every later BEGIN fails.
      try {
        db.exec('COMMIT');
      } catch {
        db.exec('ROLLBACK');
      }
    }
  }

  private finding(db: DatabaseSync, id: string, threads: boolean, now: Date): FeedPage['findings'][number] {
    const i = db.prepare(`SELECT * FROM issues WHERE id = ?`).get(id) as unknown as IssueRow;
    const latest = db.prepare(`SELECT data FROM issue_events WHERE issue_id = ? AND type IN ('opened', 'report_linked') ORDER BY id DESC LIMIT 1`).get(id) as { data: string } | undefined;
    const hypothesis = latest ? String((JSON.parse(latest.data) as { hypothesis?: unknown }).hypothesis ?? '') : '';
    const run = db.prepare(`SELECT json_extract(data, '$.run') AS run FROM issue_events WHERE issue_id = ? AND json_extract(data, '$.run') IS NOT NULL ORDER BY id DESC LIMIT 1`).get(id) as { run: unknown } | undefined;
    const keys = (db.prepare(`SELECT row_key FROM issue_rows WHERE issue_id = ?`).all(id) as Array<{ row_key: string }>).map((r) => r.row_key);
    // Row keys are section|service|subject|status. Only the service leaves: a
    // subject could hold a name or an address (before #25).
    const services = [...new Set(keys.map((k) => k.split('|')[1] ?? '').filter((s) => SERVICE.test(s) && redact(s) === s))].sort();
    const thread = threads ? ((db.prepare(`SELECT ts FROM slack_issue_threads WHERE issue = ?`).get(id) as { ts: string | null } | undefined)?.ts ?? null) : null;
    const ack: Ack | null = i.disposition === 'acknowledged' ? 'on_it' : i.disposition === 'dismissed' && i.muted_until && Date.parse(i.muted_until) > now.getTime() ? 'not_an_issue' : null;
    const finding: Finding = {
      id: i.id,
      level: i.severity === 'critical' ? 'critical' : 'major',
      status: i.status,
      title: clean(i.title, 140, keys),
      summary: clean(hypothesis, 240, keys),
      services,
      repos: [],
      runId: typeof run?.run === 'string' && RUN_ID.test(run.run) ? run.run : null,
      url: null,
      ack,
      at: i.last_at,
      openedAt: i.opened_at,
      resolvedAt: i.resolved_at,
    };
    return { finding, thread };
  }
}

// The cursor is opaque to clients: a version and its two positions.
export const encodeCursor = (c: Cursor): string => Buffer.from(`v1:${c.e}.${c.t}`).toString('base64url');
export function decodeCursor(s: string): Cursor | undefined {
  if (s.length > 60 || !/^[A-Za-z0-9_-]+$/.test(s)) return undefined;
  const m = /^v1:(\d{1,15})\.(\d{1,15})$/.exec(Buffer.from(s, 'base64url').toString('utf8'));
  return m ? { e: Number(m[1]), t: Number(m[2]) } : undefined;
}
