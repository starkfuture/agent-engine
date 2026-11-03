import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanModelText, redact } from '../engine/text.js';

// What the engine remembers about a problem the investigator reported, across
// patrols, so the same cause is one record (and one Slack thread), not a new
// report every time a row comes back or a sibling row fires. An issue is the
// bot's finding, not an incident: a person may later promote it to one in the
// team's board. It lives in the engine's SQLite file next to the Slack outbox
// and knows nothing about Slack: the outbox maps an issue to its thread.

export type Severity = 'critical' | 'major' | 'minor' | 'noise';
export const RANK: Record<Severity, number> = { noise: 0, minor: 1, major: 2, critical: 3 };

export interface Issue {
  id: string; // I-7f3a: short, stable, shown in Slack and get_run
  opened_at: string;
  last_at: string; // the last report linked to it
  resolved_at: string | null;
  status: 'open' | 'resolved';
  severity: Severity;
  title: string;
  rows: string[];
  hypothesis: string; // the latest report's likely cause, one line
}

export type IssueEventType = 'opened' | 'report_linked' | 'severity_raised' | 'resolved' | 'reopened' | 'reminded' | 'rows_posted';
export interface IssueEvent {
  id: number;
  issue_id: string;
  type: IssueEventType;
  at: string;
  data: Record<string, unknown>;
}

// The part of a monitor report the record keeps.
export interface Filed {
  title: string;
  severity: Severity;
  rows: string[];
  hypothesis: string;
  run?: string | undefined;
}

export interface Linked {
  issue: Issue;
  raisedFrom?: Severity; // set when this report raised the severity
  reopenedFrom?: string; // when it reopened a resolved issue: its resolved_at
  lastNewsAt?: string; // before this report: when the channel last heard about it (opened, raised, reopened, reminded, urgent rows)
}

const H = 3600_000;
export const ISSUE_ID = /^I-[0-9a-f]{4,6}$/;

// Model text is stored redacted and on one line; the cards clean it again for Slack.
const line = (s: string, n: number) => {
  const t = cleanModelText(redact(s)).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

interface IssueRow {
  id: string;
  opened_at: string;
  last_at: string;
  resolved_at: string | null;
  status: 'open' | 'resolved';
  severity: Severity;
  title: string;
}

export class Issues {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // Additive: new tables only. issue_events is append-only.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY, opened_at TEXT NOT NULL, last_at TEXT NOT NULL, resolved_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')), severity TEXT NOT NULL, title TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS issues_status ON issues (status, last_at);
      CREATE TABLE IF NOT EXISTS issue_rows (issue_id TEXT NOT NULL REFERENCES issues (id), row_key TEXT NOT NULL, PRIMARY KEY (issue_id, row_key));
      CREATE INDEX IF NOT EXISTS issue_rows_key ON issue_rows (row_key);
      CREATE TABLE IF NOT EXISTS issue_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL REFERENCES issues (id),
        type TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS issue_events_issue ON issue_events (issue_id, id);
      CREATE TRIGGER IF NOT EXISTS issue_events_no_update BEFORE UPDATE ON issue_events BEGIN SELECT RAISE(ABORT, 'issue_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS issue_events_no_delete BEFORE DELETE ON issue_events BEGIN SELECT RAISE(ABORT, 'issue_events is append-only'); END;
    `);
  }

  static memory(): Issues {
    return new Issues(':memory:');
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private event(id: string, type: IssueEventType, at: Date, data: Record<string, unknown>): void {
    this.db.prepare(`INSERT INTO issue_events (issue_id, type, at, data) VALUES (?, ?, ?, ?)`).run(id, type, at.toISOString(), JSON.stringify(data));
  }

  private addRows(id: string, rows: string[]): void {
    const add = this.db.prepare(`INSERT OR IGNORE INTO issue_rows (issue_id, row_key) VALUES (?, ?)`);
    for (const k of rows) add.run(id, k);
  }

  private report(r: Filed) {
    return { ...(r.run ? { run: r.run } : {}), title: line(r.title, 140), severity: r.severity, rows: r.rows, hypothesis: line(r.hypothesis, 240) };
  }

  // Short and readable: I- and four hex characters of a hash, longer only on a clash.
  private newId(at: Date, title: string): string {
    const taken = this.db.prepare(`SELECT 1 FROM issues WHERE id = ?`);
    for (let n = 0; ; n++) {
      const id = `I-${createHash('sha1').update(`${at.toISOString()}|${title}|${n}`).digest('hex').slice(0, n < 16 ? 4 : 6)}`;
      if (!taken.get(id)) return id;
    }
  }

  open(r: Filed, at: Date): Issue {
    const id = this.tx(() => {
      const title = line(r.title, 140);
      const id = this.newId(at, title);
      this.db.prepare(`INSERT INTO issues (id, opened_at, last_at, status, severity, title) VALUES (?, ?, ?, 'open', ?, ?)`).run(id, at.toISOString(), at.toISOString(), r.severity, title);
      this.addRows(id, r.rows);
      this.event(id, 'opened', at, this.report(r));
      return id;
    });
    return this.get(id)!;
  }

  // A report with the same cause. Its rows join the issue. A resolved issue is
  // reopened only when `reopen` (the caller posts recurrences, not quiet ones).
  link(id: string, r: Filed, at: Date, o: { reopen: boolean }): Linked {
    const out = this.tx(() => {
      const before = this.row(id);
      if (!before) throw new Error(`no issue ${id}`);
      const iso = at.toISOString();
      const res: Omit<Linked, 'issue'> = {};
      const news = this.db.prepare(`SELECT MAX(at) AS at FROM issue_events WHERE issue_id = ? AND type IN ('opened', 'severity_raised', 'reopened', 'reminded', 'rows_posted')`).get(id) as { at: string | null };
      if (news.at) res.lastNewsAt = news.at;
      if (before.status === 'resolved' && o.reopen) {
        // A new episode: its severity starts from this report.
        this.db.prepare(`UPDATE issues SET status = 'open', resolved_at = NULL, severity = ? WHERE id = ?`).run(r.severity, id);
        this.event(id, 'reopened', at, { ...(r.run ? { run: r.run } : {}), severity: r.severity, resolved_at: before.resolved_at });
        res.reopenedFrom = before.resolved_at ?? iso;
      }
      this.addRows(id, r.rows);
      this.db.prepare(`UPDATE issues SET last_at = ? WHERE id = ?`).run(iso, id);
      this.event(id, 'report_linked', at, this.report(r));
      if (!res.reopenedFrom && before.status === 'open' && RANK[r.severity] > RANK[before.severity]) {
        this.db.prepare(`UPDATE issues SET severity = ? WHERE id = ?`).run(r.severity, id);
        this.event(id, 'severity_raised', at, { ...(r.run ? { run: r.run } : {}), from: before.severity, to: r.severity });
        res.raisedFrom = before.severity;
      }
      return res;
    });
    return { issue: this.get(id)!, ...out };
  }

  // A linked report shown in the channel only because the issue has been open
  // a long time without news there.
  remind(id: string, at: Date, run?: string): void {
    this.event(id, 'reminded', at, run ? { run } : {});
  }

  // The urgent rows card went to the channel in this issue's thread.
  rowsPosted(id: string, at: Date, rows: string[]): void {
    this.event(id, 'rows_posted', at, { rows });
  }

  resolve(id: string, at: Date): void {
    this.tx(() => {
      const changed = this.db.prepare(`UPDATE issues SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'`).run(at.toISOString(), id).changes;
      if (changed) this.event(id, 'resolved', at, { rows: this.rowsOf(id) });
    });
  }

  private row(id: string): IssueRow | undefined {
    return this.db.prepare(`SELECT * FROM issues WHERE id = ?`).get(id) as unknown as IssueRow | undefined;
  }

  private rowsOf(id: string): string[] {
    return (this.db.prepare(`SELECT row_key FROM issue_rows WHERE issue_id = ? ORDER BY row_key`).all(id) as Array<{ row_key: string }>).map((r) => r.row_key);
  }

  private full(r: IssueRow): Issue {
    const last = this.db.prepare(`SELECT data FROM issue_events WHERE issue_id = ? AND type IN ('opened', 'report_linked') ORDER BY id DESC LIMIT 1`).get(r.id) as { data: string } | undefined;
    const hypothesis = last ? String((JSON.parse(last.data) as { hypothesis?: unknown }).hypothesis ?? '') : '';
    return { ...r, rows: this.rowsOf(r.id), hypothesis };
  }

  get(id: string): Issue | undefined {
    const r = this.row(id);
    return r && this.full(r);
  }

  events(id: string): IssueEvent[] {
    return (this.db.prepare(`SELECT * FROM issue_events WHERE issue_id = ? ORDER BY id`).all(id) as Array<Omit<IssueEvent, 'data'> & { data: string }>).map((e) => ({ ...e, id: Number(e.id), data: JSON.parse(e.data) as Record<string, unknown> }));
  }

  openIssues(): Issue[] {
    return (this.db.prepare(`SELECT * FROM issues WHERE status = 'open' ORDER BY last_at DESC`).all() as unknown as IssueRow[]).map((r) => this.full(r));
  }

  // What the investigator is shown: open issues and those resolved in the last
  // `resolvedHours`, most recently reported first, at most `max`.
  listed(at: Date, o: { max?: number; resolvedHours?: number } = {}): { issues: Issue[]; more: number } {
    const since = new Date(at.getTime() - (o.resolvedHours ?? 24) * H).toISOString();
    const rows = this.db.prepare(`SELECT * FROM issues WHERE status = 'open' OR resolved_at >= ? ORDER BY last_at DESC`).all(since) as unknown as IssueRow[];
    const max = o.max ?? 20;
    return { issues: rows.slice(0, max).map((r) => this.full(r)), more: Math.max(0, rows.length - max) };
  }

  // The one open issue that already holds all these rows, if any.
  holding(keys: string[]): Issue | undefined {
    if (!keys.length) return undefined;
    const ids = this.db
      .prepare(`SELECT r.issue_id AS id FROM issue_rows r JOIN issues i ON i.id = r.issue_id WHERE i.status = 'open' AND r.row_key IN (${keys.map(() => '?').join(',')}) GROUP BY r.issue_id HAVING COUNT(DISTINCT r.row_key) = ?`)
      .all(...keys, new Set(keys).size) as Array<{ id: string }>;
    return ids.length === 1 ? this.get(ids[0]!.id) : undefined;
  }
}
