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

export type IssueEventType =
  | 'opened'
  | 'report_linked'
  | 'severity_raised'
  | 'resolved'
  | 'reopened'
  | 'reminded'
  | 'rows_posted'
  // The buttons on the issue's Slack message (see Disposition), and what they did.
  | 'acknowledged'
  | 'dismissed'
  | 'undone'
  | 'mute_lifted'
  | 'worse_noted'
  // Nobody clicked On it in time: the backup was asked in its thread (owners.yaml escalation).
  | 'escalated';
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
  lastNewsAt?: string; // before this report: when the record last sent the channel news (opened, raised, reopened, reminded, urgent rows), queued, not delivered
}

// What a person said with the buttons on the issue's Slack message, for this
// episode: "On it" (acknowledged) or "Not an issue" (dismissed: a mute, which
// ends at `until` at the latest). One at a time; resolving the issue ends On
// it, and Not an issue only once its mute is over (see resolve).
export interface Disposition {
  kind: 'acknowledged' | 'dismissed';
  by: string; // Slack user id
  at: string;
  until?: string | undefined;
}
export const MUTE_DAYS = 7;

// A click: On it, Not an issue, or Undo (back to nobody).
export type Click = Disposition['kind'] | 'undo';
export type Clicked =
  | { result: 'unknown' }
  | { result: 'resolved'; issue: Issue }
  | { result: 'stale'; issue: Issue } // this click, or a later one, is already recorded
  | { result: 'unchanged' | 'changed'; issue: Issue; now?: Disposition | undefined };

// A noise-rule candidate: an issue someone marked Not an issue (an Undo takes
// the click back). A permanent rule stays a reviewed noise.yaml change.
export interface Dismissal {
  by: string;
  at: string;
  rows: string[];
}

const H = 3600_000;
const DAY = 24 * H;
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
    // Additive: new tables and columns only. issue_events is append-only.
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
    // The current click on an open issue (On it or Not an issue); its history is
    // in issue_events. click_ts: Slack's time of the latest click, even one that changed nothing.
    const cols = new Set((this.db.prepare(`PRAGMA table_info(issues)`).all() as Array<{ name: string }>).map((c) => c.name));
    for (const c of ['disposition', 'disposed_by', 'disposed_at', 'muted_until', 'click_ts']) if (!cols.has(c)) this.db.exec(`ALTER TABLE issues ADD COLUMN ${c} TEXT`);
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
  // A Not an issue kept from before it resolved stays on it when `muted` (the
  // caller found the return quiet enough, see keptMute), and ends otherwise.
  link(id: string, r: Filed, at: Date, o: { reopen: boolean; muted?: boolean }): Linked {
    const out = this.tx(() => {
      const before = this.row(id);
      if (!before) throw new Error(`no issue ${id}`);
      const iso = at.toISOString();
      const res: Omit<Linked, 'issue'> = {};
      const news = this.lastNewsAt(id);
      if (news) res.lastNewsAt = news;
      if (before.status === 'resolved' && o.reopen) {
        // A new episode: its severity starts from this report.
        this.db.prepare(`UPDATE issues SET status = 'open', resolved_at = NULL, severity = ? WHERE id = ?`).run(r.severity, id);
        // Not an issue kept from before it resolved (see resolve), while its mute lasts.
        const kept = this.lasting(id, at);
        const muted = !!o.muted && kept?.kind === 'dismissed';
        this.event(id, 'reopened', at, { ...(r.run ? { run: r.run } : {}), severity: r.severity, resolved_at: before.resolved_at, ...(muted ? { muted: true } : {}) });
        if (!muted && this.current(id)) {
          this.clear(id);
          if (kept) this.event(id, 'mute_lifted', at, { reason: r.severity === 'critical' ? 'critical' : 'came back', ...(r.run ? { run: r.run } : {}) });
        }
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

  // When the channel last heard about the issue: opened, raised, reopened,
  // reminded, or an urgent rows card in its thread. A return Not an issue kept
  // quiet is not news.
  lastNewsAt(id: string): string | undefined {
    const news = this.db
      .prepare(`SELECT MAX(at) AS at FROM issue_events WHERE issue_id = ? AND type IN ('opened', 'severity_raised', 'reopened', 'reminded', 'rows_posted') AND json_extract(data, '$.muted') IS NULL`)
      .get(id) as { at: string | null };
    return news.at ?? undefined;
  }

  // A linked report shown in the channel only because the issue has been open
  // a long time without news there.
  remind(id: string, at: Date, run?: string): void {
    this.event(id, 'reminded', at, run ? { run } : {});
  }

  // The urgent rows card was queued for the channel in this issue's thread.
  // (The reminder clock counts what Slack accepted, from the outbox; this and
  // the other queued news only count where nothing was delivered.)
  rowsPosted(id: string, at: Date, rows: string[]): void {
    this.event(id, 'rows_posted', at, { rows });
  }

  // Resolving ends the episode, and with it On it. Not an issue outlasts it
  // while its mute lasts (MUTE_DAYS from the click): a person's judgement
  // shouldn't end when the rows go quiet for an hour. The event keeps the rows
  // it covered then (see keptMute).
  resolve(id: string, at: Date): void {
    this.tx(() => {
      const changed = this.db.prepare(`UPDATE issues SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'`).run(at.toISOString(), id).changes;
      if (!changed) return;
      const d = this.current(id);
      const kept = this.lasting(id, at)?.kind === 'dismissed';
      if (!kept) this.clear(id);
      this.event(id, 'resolved', at, { rows: this.rowsOf(id), ...(d ? (kept ? { kept: d.kind, until: d.until } : { ended: d.kind }) : {}) });
    });
  }

  // A click on the issue's Slack message. Only an open issue changes, and the
  // same click again changes nothing (so Slack is updated once). A later click
  // replaces an earlier one: the last person to say On it is on it.
  // `actionTs` is Slack's time of the click: a click Slack delivers again, or
  // one not newer than the latest click, changes nothing. `alongside`: more
  // writes to engine.db that commit with a change, or not at all (its Slack
  // message update).
  click(id: string, click: Click, by: string, at: Date, actionTs?: string, alongside?: (db: DatabaseSync) => void): Clicked {
    return this.tx((): Clicked => {
      const row = this.row(id);
      if (!row) return { result: 'unknown' };
      const issue = this.full(row);
      if (row.status !== 'open') return { result: 'resolved', issue };
      // Slack's times compare as text: ten digits, a dot, six digits.
      if (actionTs) {
        const mark = (this.db.prepare(`SELECT click_ts FROM issues WHERE id = ?`).get(id) as { click_ts: string | null }).click_ts;
        const recorded = this.db.prepare(`SELECT 1 FROM issue_events WHERE issue_id = ? AND type IN ('acknowledged', 'dismissed', 'undone') AND (json_extract(data, '$.action_ts') > ? OR (json_extract(data, '$.action_ts') = ? AND json_extract(data, '$.by') = ?))`).get(id, actionTs, actionTs, by);
        if ((mark && mark >= actionTs) || recorded) return { result: 'stale', issue };
        // The mark older clicks must beat, also when this one changes nothing.
        this.db.prepare(`UPDATE issues SET click_ts = ? WHERE id = ?`).run(actionTs, id);
      }
      const before = this.disposition(id, at);
      const ts = actionTs ? { action_ts: actionTs } : {};
      if (click === 'undo') {
        if (!before) return { result: 'unchanged', issue };
        this.clear(id);
        this.event(id, 'undone', at, { by, ...ts, was: before.kind, was_by: before.by });
        alongside?.(this.db);
        return { result: 'changed', issue };
      }
      if (before?.kind === click && before.by === by) return { result: 'unchanged', issue, now: before };
      const now: Disposition = { kind: click, by, at: at.toISOString(), ...(click === 'dismissed' ? { until: new Date(at.getTime() + MUTE_DAYS * DAY).toISOString() } : {}) };
      this.db.prepare(`UPDATE issues SET disposition = ?, disposed_by = ?, disposed_at = ?, muted_until = ? WHERE id = ?`).run(now.kind, by, now.at, now.until ?? null, id);
      // A dismissal is a noise-rule candidate: it keeps the rows it was about.
      this.event(id, click, at, { by, ...ts, ...(now.until ? { until: now.until, rows: issue.rows } : {}) });
      alongside?.(this.db);
      return { result: 'changed', issue, now };
    });
  }

  private current(id: string): Disposition | undefined {
    const d = this.db.prepare(`SELECT disposition AS kind, disposed_by AS actor, disposed_at AS at, muted_until AS until FROM issues WHERE id = ?`).get(id) as { kind: Disposition['kind'] | null; actor: string; at: string; until: string | null } | undefined;
    return d?.kind ? { kind: d.kind, by: d.actor, at: d.at, ...(d.until ? { until: d.until } : {}) } : undefined;
  }

  private clear(id: string): void {
    this.db.prepare(`UPDATE issues SET disposition = NULL, disposed_by = NULL, disposed_at = NULL, muted_until = NULL WHERE id = ?`).run(id);
  }

  // On it or Not an issue, as it stands at `at`: a mute past its end is over.
  // A resolved issue has none in force (one kept for its return: keptMute).
  disposition(id: string, at: Date): Disposition | undefined {
    return this.row(id)?.status === 'open' ? this.lasting(id, at) : undefined;
  }

  private lasting(id: string, at: Date): Disposition | undefined {
    const d = this.current(id);
    return d && !(d.until && Date.parse(d.until) <= at.getTime()) ? d : undefined;
  }

  // Not an issue on a resolved issue, kept while its mute lasts (see resolve),
  // with the rows the issue held when it resolved: the rows the mute covered.
  keptMute(id: string, at: Date): (Disposition & { rows: string[] }) | undefined {
    const d = this.row(id)?.status === 'resolved' ? this.lasting(id, at) : undefined;
    if (d?.kind !== 'dismissed') return undefined;
    const resolved = this.db.prepare(`SELECT data FROM issue_events WHERE issue_id = ? AND type = 'resolved' ORDER BY id DESC LIMIT 1`).get(id) as { data: string } | undefined;
    const rows = resolved ? (JSON.parse(resolved.data) as { rows?: string[] }).rows : undefined;
    return { ...d, rows: rows ?? [] };
  }

  // A rise to critical ends Not an issue: the channel hears about it again.
  liftMute(id: string, at: Date, run?: string): void {
    this.tx(() => {
      if (this.current(id)?.kind !== 'dismissed') return;
      this.clear(id);
      this.event(id, 'mute_lifted', at, { reason: 'critical', ...(run ? { run } : {}) });
    });
  }

  // Mutes of open issues past their hard end (MUTE_DAYS), ended now. The
  // issues they were on. One kept on a resolved issue just runs out.
  endMutes(at: Date): string[] {
    return this.tx(() => {
      const ids = (this.db.prepare(`SELECT id FROM issues WHERE status = 'open' AND disposition = 'dismissed' AND muted_until <= ? ORDER BY id`).all(at.toISOString()) as Array<{ id: string }>).map((r) => r.id);
      for (const id of ids) {
        this.clear(id);
        this.event(id, 'mute_lifted', at, { reason: `${MUTE_DAYS} days` });
      }
      return ids;
    });
  }

  // Rows of an issue someone is on got worse: code wrote one line in its thread
  // instead of an AI run.
  noteWorse(id: string, at: Date, rows: string[]): void {
    this.event(id, 'worse_noted', at, { rows });
  }

  // The escalation clock (owners.yaml, see runner): when this episode of the
  // issue first stood at one of these severities (opened or reopened at one,
  // or raised to one). None when it never did, or once its backup was asked
  // in this episode: that happens once per episode.
  escalationSince(id: string, severities: ReadonlySet<Severity>): string | undefined {
    const events = this.db
      .prepare(
        `SELECT type, at, data FROM issue_events WHERE issue_id = ? AND type IN ('opened', 'reopened', 'severity_raised', 'escalated')
         AND id >= (SELECT MAX(id) FROM issue_events WHERE issue_id = ? AND type IN ('opened', 'reopened')) ORDER BY id`,
      )
      .all(id, id) as Array<{ type: IssueEventType; at: string; data: string }>;
    let since: string | undefined;
    for (const e of events) {
      if (e.type === 'escalated') return undefined;
      const d = JSON.parse(e.data) as { severity?: Severity; to?: Severity };
      const severity = e.type === 'severity_raised' ? d.to : d.severity;
      if (!since && severity && severities.has(severity)) since = e.at;
    }
    return since;
  }

  // Nobody clicked On it in time: code asked the backups in the issue's thread.
  escalated(id: string, at: Date, data: { to: string[]; after_minutes: number }): void {
    this.event(id, 'escalated', at, data);
  }

  // Of these rows, those that belong only to open issues someone clicked, with
  // that click: On it, or Not an issue while its mute lasts. A row that is also
  // in an open issue nobody clicked is not claimed. On it wins over Not an issue.
  claims(keys: string[], at: Date): Map<string, Disposition & { issue: string }> {
    const out = new Map<string, Disposition & { issue: string }>();
    if (!keys.length) return out;
    const rows = this.db
      .prepare(
        `SELECT r.row_key AS key, i.id AS issue, CASE WHEN i.disposition = 'acknowledged' OR i.muted_until > ? THEN i.disposition END AS kind,
         i.disposed_by AS actor, i.disposed_at AS at, i.muted_until AS until
         FROM issue_rows r JOIN issues i ON i.id = r.issue_id AND i.status = 'open'
         WHERE r.row_key IN (${keys.map(() => '?').join(',')}) ORDER BY i.id`,
      )
      .all(at.toISOString(), ...keys) as Array<{ key: string; issue: string; kind: Disposition['kind'] | null; actor: string | null; at: string | null; until: string | null }>;
    const free = new Set(rows.filter((r) => !r.kind).map((r) => r.key));
    for (const r of rows) {
      if (free.has(r.key) || !r.kind || out.get(r.key)?.kind === 'acknowledged') continue;
      out.set(r.key, { issue: r.issue, kind: r.kind, by: r.actor!, at: r.at!, ...(r.until ? { until: r.until } : {}) });
    }
    return out;
  }

  // Not an issue clicks that stand (an Undo right after one takes it back).
  dismissals(id?: string): Array<Dismissal & { issue: string }> {
    const events = this.db
      .prepare(`SELECT issue_id, type, at, data FROM issue_events WHERE type IN ('dismissed', 'undone') ${id ? 'AND issue_id = ?' : ''} ORDER BY id`)
      .all(...(id ? [id] : [])) as Array<{ issue_id: string; type: string; at: string; data: string }>;
    const kept: Array<Dismissal & { issue: string }> = [];
    for (const e of events) {
      const d = JSON.parse(e.data) as { by?: string; rows?: string[]; was?: string };
      if (e.type === 'dismissed') kept.push({ issue: e.issue_id, by: String(d.by), at: e.at, rows: d.rows ?? [] });
      else if (d.was === 'dismissed') {
        const i = kept.findLastIndex((k) => k.issue === e.issue_id);
        if (i >= 0) kept.splice(i, 1);
      }
    }
    return kept;
  }

  // For an admin: issues marked Not an issue, most often first. The rows are
  // the ones the latest click was about.
  noiseCandidates(): Array<{ issue: string; title: string; status: Issue['status']; rows: string[]; dismissals: Dismissal[] }> {
    const by = new Map<string, Dismissal[]>();
    for (const d of this.dismissals()) by.set(d.issue, [...(by.get(d.issue) ?? []), d]);
    return [...by]
      .map(([id, ds]) => {
        const i = this.row(id)!;
        return { issue: id, title: i.title, status: i.status, rows: ds.at(-1)!.rows, dismissals: ds.map(({ by, at, rows }) => ({ by, at, rows })) };
      })
      .sort((a, b) => b.dismissals.length - a.dismissals.length || b.dismissals.at(-1)!.at.localeCompare(a.dismissals.at(-1)!.at));
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
    const { id, opened_at, last_at, resolved_at, status, severity, title } = r;
    return { id, opened_at, last_at, resolved_at, status, severity, title, rows: this.rowsOf(r.id), hypothesis };
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
  // `resolvedHours`, most recently reported first, at most `max`. Also a
  // resolved one whose Not an issue still lasts, so a return can link to it.
  listed(at: Date, o: { max?: number; resolvedHours?: number } = {}): { issues: Issue[]; more: number } {
    const since = new Date(at.getTime() - (o.resolvedHours ?? 24) * H).toISOString();
    const rows = this.db
      .prepare(`SELECT * FROM issues WHERE status = 'open' OR resolved_at >= ? OR (disposition = 'dismissed' AND muted_until > ?) ORDER BY last_at DESC`)
      .all(since, at.toISOString()) as unknown as IssueRow[];
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
