import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type RunStatus = 'running' | 'ok' | 'no_output' | 'error' | 'budget' | 'deadline' | 'stopped' | 'loop' | 'skipped' | 'crashed';

export interface RunRow {
  id: string;
  agent: string;
  version: string;
  trigger: string;
  day: string; // UTC day the run started; its spend counts there
  started_at: string;
  deadline_at: string;
  pid: number;
  reserve: number;
  status: RunStatus;
  cost: number | null;
  turns: number | null;
  outputs: number | null;
  challenge: string | null;
  note: string | null;
  ended_at: string | null;
  requested_by: string | null;
  heartbeat_at: string | null;
  build: string | null; // engine code version
}

export interface Admission {
  id: string;
  agent: string;
  version: string;
  trigger: string;
  now: Date;
  deadlineMs: number;
  reserve: number;
  agentCap: number;
  agentMonthlyCap?: number; // this agent, UTC calendar month: its share of monthlyCap
  globalCap: number;
  monthlyCap?: number; // across all agents, UTC calendar month
  concurrency?: number; // runs of this agent at once (default 1)
  user?: string; // who asked (MCP); scheduled runs have none
  userCap?: number; // that person's daily spend, across agents
  userMaxRunning?: number; // that person's runs at once
  build?: string; // engine code version
}

// How long past its deadline a "running" row may sit before it is reaped as
// crashed, even if its pid is (or was reused as) a live process.
const GRACE_MS = 5 * 60_000;
// A running run beats every 30 s. One silent this long is dead even if its pid
// is alive: in a container a restarted server is pid 1 again.
const STALE_MS = 2 * 60_000;

// Run admission, single flight and spend live in one SQLite file. Admission is
// one IMMEDIATE transaction: reap dead runs, refuse a second run of the same
// agent, check both caps (running runs count their reservation), insert. So two
// processes can't both pass a cap or both start the same agent.
export class Store {
  readonly db: DatabaseSync;

  constructor(readonly file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, version TEXT NOT NULL, trigger TEXT NOT NULL,
        day TEXT NOT NULL, started_at TEXT NOT NULL, deadline_at TEXT NOT NULL, pid INTEGER NOT NULL,
        reserve REAL NOT NULL, status TEXT NOT NULL, cost REAL, turns INTEGER, outputs INTEGER,
        challenge TEXT, note TEXT, ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_day ON runs (day, agent);
      CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at);
      CREATE INDEX IF NOT EXISTS runs_running ON runs (status) WHERE status = 'running';
    `);
    this.migrate();
  }

  private migrate(): void {
    const cols = new Set((this.db.prepare(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('requested_by')) this.db.exec(`ALTER TABLE runs ADD COLUMN requested_by TEXT`);
    if (!cols.has('heartbeat_at')) this.db.exec(`ALTER TABLE runs ADD COLUMN heartbeat_at TEXT`);
    if (!cols.has('build')) this.db.exec(`ALTER TABLE runs ADD COLUMN build TEXT`);
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

  // Running rows whose process is gone, that stopped beating, or that are far
  // past their deadline, are settled as crashed at their full reservation.
  private reap(now: Date): void {
    const rows = this.db.prepare(`SELECT id, pid, deadline_at, started_at, heartbeat_at FROM runs WHERE status = 'running'`).all() as Array<{ id: string; pid: number; deadline_at: string; started_at: string; heartbeat_at: string | null }>;
    const crash = this.db.prepare(`UPDATE runs SET status = 'crashed', cost = reserve, ended_at = ?, note = ? WHERE id = ? AND status = 'running'`);
    for (const r of rows) {
      const late = now.getTime() > Date.parse(r.deadline_at) + GRACE_MS;
      const silent = now.getTime() > Date.parse(r.heartbeat_at ?? r.started_at) + STALE_MS;
      const why = late ? 'past deadline, never settled' : !alive(r.pid) ? `process ${r.pid} gone` : silent ? 'no heartbeat for 2 min (process restarted or hung)' : undefined;
      if (why) crash.run(now.toISOString(), why, r.id);
    }
  }

  // Called every 30 s by a running run.
  beat(id: string, now: Date): void {
    this.db.prepare(`UPDATE runs SET heartbeat_at = ? WHERE id = ? AND status = 'running'`).run(now.toISOString(), id);
  }

  // `day` is a UTC day (2026-10-14) or a month prefix (2026-10).
  private spentIn(day: string, agent?: string, user?: string): number {
    const where = [`${day.length === 7 ? 'substr(day, 1, 7)' : 'day'} = ?`, ...(agent ? ['agent = ?'] : []), ...(user ? ['requested_by = ?'] : [])];
    const sql = `SELECT COALESCE(SUM(CASE WHEN status = 'running' THEN reserve ELSE COALESCE(cost, 0) END), 0) AS s FROM runs WHERE ${where.join(' AND ')}`;
    const row = this.db.prepare(sql).get(day, ...(agent ? [agent] : []), ...(user ? [user] : [])) as { s: number };
    return row.s;
  }

  private running(col: 'agent' | 'requested_by', v: string): string[] {
    return (this.db.prepare(`SELECT id FROM runs WHERE status = 'running' AND ${col} = ?`).all(v) as Array<{ id: string }>).map((r) => r.id);
  }

  admit(a: Admission): { ok: true } | { ok: false; reason: string } {
    const day = a.now.toISOString().slice(0, 10);
    return this.tx(() => {
      this.reap(a.now);
      const busy = this.running('agent', a.agent);
      if (busy.length >= (a.concurrency ?? 1)) return { ok: false as const, reason: `another run of this agent is in progress (${busy.join(', ')})` };
      if (a.user && a.userMaxRunning !== undefined && this.running('requested_by', a.user).length >= a.userMaxRunning) return { ok: false as const, reason: `you already have ${a.userMaxRunning} run(s) in progress` };
      if (a.user && a.userCap !== undefined && this.spentIn(day, undefined, a.user) + a.reserve > a.userCap) return { ok: false as const, reason: `your daily cap $${a.userCap} reached` };
      if (this.spentIn(day, a.agent) + a.reserve > a.agentCap) return { ok: false as const, reason: `agent daily cap $${a.agentCap} reached` };
      if (a.agentMonthlyCap !== undefined && this.spentIn(day.slice(0, 7), a.agent) + a.reserve > a.agentMonthlyCap) return { ok: false as const, reason: `agent monthly cap $${a.agentMonthlyCap} reached` };
      if (this.spentIn(day) + a.reserve > a.globalCap) return { ok: false as const, reason: `global daily cap $${a.globalCap} reached` };
      if (a.monthlyCap !== undefined && this.spentIn(day.slice(0, 7)) + a.reserve > a.monthlyCap) return { ok: false as const, reason: `monthly cap $${a.monthlyCap} reached` };
      this.db
        .prepare(`INSERT INTO runs (id, agent, version, trigger, day, started_at, deadline_at, pid, reserve, status, requested_by, heartbeat_at, build) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`)
        .run(a.id, a.agent, a.version, a.trigger, day, a.now.toISOString(), new Date(a.now.getTime() + a.deadlineMs).toISOString(), process.pid, a.reserve, a.user ?? null, a.now.toISOString(), a.build ?? null);
      return { ok: true as const };
    });
  }

  settle(id: string, s: { status: Exclude<RunStatus, 'running'>; cost: number; turns: number; outputs: number; challenge?: string; note?: string; now: Date }): void {
    this.db
      .prepare(`UPDATE runs SET status = ?, cost = ?, turns = ?, outputs = ?, challenge = ?, note = ?, ended_at = ? WHERE id = ?`)
      .run(s.status, s.cost, s.turns, s.outputs, s.challenge ?? null, s.note ?? null, s.now.toISOString(), id);
  }

  // A run that never started, recorded so `runs` shows why.
  skipped(a: { id: string; agent: string; version: string; trigger: string; now: Date; note: string; user?: string }): void {
    const at = a.now.toISOString();
    this.db
      .prepare(`INSERT INTO runs (id, agent, version, trigger, day, started_at, deadline_at, pid, reserve, status, cost, turns, outputs, note, ended_at, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'skipped', 0, 0, 0, ?, ?, ?)`)
      .run(a.id, a.agent, a.version, a.trigger, at.slice(0, 10), at, at, process.pid, a.note, at, a.user ?? null);
  }

  // `day` is a UTC day or a month prefix (2026-10).
  spent(day: string, agent?: string, user?: string): number {
    return this.spentIn(day, agent, user);
  }

  // visibleTo: only runs that person asked for, or runs of the given agents.
  recent(limit = 30, agentOrFilter?: string | { agent?: string; user?: string; visibleTo?: { user: string; agents: string[] } }): RunRow[] {
    const f = typeof agentOrFilter === 'string' ? { agent: agentOrFilter } : (agentOrFilter ?? {});
    const where: string[] = [];
    const args: string[] = [];
    if (f.agent) where.push('agent = ?'), args.push(f.agent);
    if (f.user) where.push('requested_by = ?'), args.push(f.user);
    if (f.visibleTo) {
      where.push(`(requested_by = ?${f.visibleTo.agents.length ? ` OR agent IN (${f.visibleTo.agents.map(() => '?').join(', ')})` : ''})`);
      args.push(f.visibleTo.user, ...f.visibleTo.agents);
    }
    const sql = `SELECT * FROM runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit) as unknown as RunRow[];
  }

  // Runs started on a UTC day, by agent and status (metrics).
  counts(day: string): Array<{ agent: string; status: string; n: number }> {
    return this.db.prepare(`SELECT agent, status, COUNT(*) AS n FROM runs WHERE day = ? GROUP BY agent, status ORDER BY agent, status`).all(day) as unknown as Array<{ agent: string; status: string; n: number }>;
  }

  get(id: string): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as unknown as RunRow | undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
