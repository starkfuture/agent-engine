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
  globalCap: number;
}

// How long past its deadline a "running" row may sit before it is reaped as
// crashed, even if its pid is (or was reused as) a live process.
const GRACE_MS = 5 * 60_000;

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
      CREATE INDEX IF NOT EXISTS runs_running ON runs (status) WHERE status = 'running';
    `);
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

  // Running rows whose process is gone, or that are far past their deadline,
  // are settled as crashed at their full reservation.
  private reap(now: Date): void {
    const rows = this.db.prepare(`SELECT id, pid, deadline_at FROM runs WHERE status = 'running'`).all() as Array<{ id: string; pid: number; deadline_at: string }>;
    const crash = this.db.prepare(`UPDATE runs SET status = 'crashed', cost = reserve, ended_at = ?, note = ? WHERE id = ? AND status = 'running'`);
    for (const r of rows) {
      const late = now.getTime() > Date.parse(r.deadline_at) + GRACE_MS;
      if (late || !alive(r.pid)) crash.run(now.toISOString(), late ? 'past deadline, never settled' : `process ${r.pid} gone`, r.id);
    }
  }

  private spentIn(day: string, agent?: string): number {
    const sql = `SELECT COALESCE(SUM(CASE WHEN status = 'running' THEN reserve ELSE COALESCE(cost, 0) END), 0) AS s FROM runs WHERE day = ?${agent ? ' AND agent = ?' : ''}`;
    const row = (agent ? this.db.prepare(sql).get(day, agent) : this.db.prepare(sql).get(day)) as { s: number };
    return row.s;
  }

  admit(a: Admission): { ok: true } | { ok: false; reason: string } {
    const day = a.now.toISOString().slice(0, 10);
    return this.tx(() => {
      this.reap(a.now);
      const busy = this.db.prepare(`SELECT id FROM runs WHERE status = 'running' AND agent = ?`).get(a.agent) as { id: string } | undefined;
      if (busy) return { ok: false as const, reason: `another run of this agent is in progress (${busy.id})` };
      if (this.spentIn(day, a.agent) + a.reserve > a.agentCap) return { ok: false as const, reason: `agent daily cap $${a.agentCap} reached` };
      if (this.spentIn(day) + a.reserve > a.globalCap) return { ok: false as const, reason: `global daily cap $${a.globalCap} reached` };
      this.db
        .prepare(`INSERT INTO runs (id, agent, version, trigger, day, started_at, deadline_at, pid, reserve, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`)
        .run(a.id, a.agent, a.version, a.trigger, day, a.now.toISOString(), new Date(a.now.getTime() + a.deadlineMs).toISOString(), process.pid, a.reserve);
      return { ok: true as const };
    });
  }

  settle(id: string, s: { status: Exclude<RunStatus, 'running'>; cost: number; turns: number; outputs: number; challenge?: string; note?: string; now: Date }): void {
    this.db
      .prepare(`UPDATE runs SET status = ?, cost = ?, turns = ?, outputs = ?, challenge = ?, note = ?, ended_at = ? WHERE id = ?`)
      .run(s.status, s.cost, s.turns, s.outputs, s.challenge ?? null, s.note ?? null, s.now.toISOString(), id);
  }

  // A run that never started, recorded so `runs` shows why.
  skipped(a: { id: string; agent: string; version: string; trigger: string; now: Date; note: string }): void {
    const at = a.now.toISOString();
    this.db
      .prepare(`INSERT INTO runs (id, agent, version, trigger, day, started_at, deadline_at, pid, reserve, status, cost, turns, outputs, note, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'skipped', 0, 0, 0, ?, ?)`)
      .run(a.id, a.agent, a.version, a.trigger, at.slice(0, 10), at, at, process.pid, a.note, at);
  }

  spent(day: string, agent?: string): number {
    return this.spentIn(day, agent);
  }

  recent(limit = 30, agent?: string): RunRow[] {
    const sql = `SELECT * FROM runs${agent ? ' WHERE agent = ?' : ''} ORDER BY started_at DESC LIMIT ?`;
    return (agent ? this.db.prepare(sql).all(agent, limit) : this.db.prepare(sql).all(limit)) as unknown as RunRow[];
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
