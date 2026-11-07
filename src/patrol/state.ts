import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Notices } from '../output/notices.js';
import type { Row } from './types.js';

// What the patrol remembers between runs. Small JSON file locally; a table later.
export interface RowMemory {
  firstSeen: string;
  lastSeen: string;
  lastFiredAt?: string; // also while a noise rule hides it: the recovery hold counts from here
  lastReportedAt?: string;
  lastReportedNow?: number;
  sources?: string[]; // collectors that observed the row; absent in older state files
  recoveredAt?: string;
  lastRecoveredAt?: string; // the last confirmed recovery; kept when the row fires again
  investigation?: Investigation; // absent in state files from before it was kept
  // News (fresh or worse) in patrols in a row, not sent yet: the first and the
  // latest. A blip of one patrol gets no AI run (see seen()).
  streak?: { since: string; last: string };
}

// How long news must hold before the investigator sees it.
export interface Confirm {
  windowMin: number;
  patrols: number; // 1: at once, as before
}

// Whether the investigator still owes this row an answer. Pending until a
// report covers it; given up after ATTEMPTS runs that didn't. A run that was
// not admitted (caps, the kill switch on) or was stopped (the kill switch, a
// cancel) is a deferral, not an attempt.
export interface Investigation {
  status: 'pending' | 'complete' | 'gave_up';
  attempts: number;
  outcome?: string; // the last run's status or note
  runId?: string; // the last run
}
export const ATTEMPTS = 2;

export interface StateData {
  rows: Record<string, RowMemory>;
  spend?: Record<string, number>; // legacy; spend is in the engine ledger now
  // The investigator's last run was refused (a cap, the kill switch): the
  // skipped run that recorded it. Ends with the next run that is admitted.
  held?: { reason: string; since: string; runId: string };
  notices?: Notices; // what was said about pauses and blind sources (output/notices.ts)
  // The patrol time of the last AI run that started (was admitted). Rows that
  // aren't likely major wait for an hour after it (runner.ts aiGate). Absent in
  // older state files: no run is that recent.
  lastRunAt?: string;
}

const H = 3600_000;
const STALLED = /^rollout\|[^|]+\|stalled\|/;

export interface NoveltyPolicy {
  renotifyAfterHours: number; // a still-firing row comes back to the LLM after this
  worsenFactor: number; // or sooner if it got this much worse
  forgetAfterHours: number; // a row unseen this long is new again
}
export const DEFAULT_NOVELTY: NoveltyPolicy = { renotifyAfterHours: 6, worsenFactor: 2, forgetAfterHours: 48 };

export type Novelty = 'fresh' | 'worse' | 'reminder' | 'known';

export class State {
  constructor(
    readonly data: StateData = { rows: {} },
    private readonly file?: string,
  ) {}

  static load(file: string): State {
    if (!existsSync(file)) return new State(undefined, file);
    return new State(JSON.parse(readFileSync(file, 'utf8')) as StateData, file);
  }

  static memory(): State {
    return new State();
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }

  // Classify a flagged row against memory. Does not mutate.
  novelty(r: Row, at: Date, p: NoveltyPolicy = DEFAULT_NOVELTY): Novelty {
    const m = this.data.rows[r.key];
    if (!m || at.getTime() - Date.parse(m.lastSeen) > p.forgetAfterHours * H) return 'fresh';
    if (!m.lastReportedAt) return 'fresh';
    if (m.lastReportedNow !== undefined && r.counts.now >= Math.max(1, m.lastReportedNow) * p.worsenFactor) return 'worse';
    if (at.getTime() - Date.parse(m.lastReportedAt) > p.renotifyAfterHours * H) return 'reminder';
    return 'known';
  }

  // Records a sighting. With `confirm`, news (fresh or worse) must hold for
  // confirm.patrols patrols in a row: until then it is held (returns true),
  // and owes the investigator nothing yet. A patrol in which it wasn't news
  // starts the count over.
  seen(r: Row, at: Date, sources: string[], confirm?: Confirm): boolean {
    const iso = at.toISOString();
    const novelty = this.novelty(r, at);
    const m = this.data.rows[r.key];
    if (!m || at.getTime() - Date.parse(m.lastSeen) > DEFAULT_NOVELTY.forgetAfterHours * H) this.data.rows[r.key] = { firstSeen: iso, lastSeen: iso, investigation: { status: 'pending', attempts: 0 } };
    else m.lastSeen = iso;
    const current = this.data.rows[r.key]!;
    current.sources = sources;
    current.lastFiredAt = iso;
    delete current.recoveredAt;
    let held = false;
    if (novelty === 'fresh' || novelty === 'worse') {
      const s = current.streak;
      if (!s || !confirm || at.getTime() - Date.parse(s.last) > 1.5 * confirm.windowMin * 60_000) current.streak = { since: iso, last: iso };
      else s.last = iso;
      held = !!confirm && at.getTime() - Date.parse(current.streak!.since) < (confirm.patrols - 1) * confirm.windowMin * 60_000;
    }
    // A patrol that isn't news doesn't touch the count: the next news after it
    // finds a gap and starts over. So a sighting of the same key that isn't
    // news (a same-named workload in another namespace) can't reset it.
    if (held) return true;
    // New work: a worse row, or one back after a confirmed recovery since it was
    // last reported (a new episode). The new episode waits for its reminder, as
    // before, so a flickering row isn't investigated every other patrol. A row
    // from older state was reported, but nothing says whether it was explained:
    // it gets one investigation at its next reminder too.
    const recurred = !!current.lastRecoveredAt && current.lastRecoveredAt > (current.lastReportedAt ?? '');
    if (novelty === 'worse' || (novelty === 'reminder' && (recurred || !current.investigation)) || (!current.investigation && !current.lastReportedAt)) current.investigation = { status: 'pending', attempts: 0 };
    return false;
  }

  reported(r: Row, at: Date): void {
    const m = this.data.rows[r.key];
    if (!m) return;
    m.lastReportedAt = at.toISOString();
    m.lastReportedNow = r.counts.now;
    delete m.streak;
  }

  firstSeen(key: string): string | undefined {
    return this.data.rows[key]?.firstSeen;
  }

  needsInvestigation(key: string): boolean {
    return this.data.rows[key]?.investigation?.status === 'pending';
  }

  // An AI run started at this patrol (it was admitted): the hourly pass counts from here.
  runStarted(at: Date): void {
    this.data.lastRunAt = at.toISOString();
  }

  // After a run over these rows: the ones a report covers are done; the rest
  // stay pending, and are given up after ATTEMPTS attempts. Returns those.
  // Rows can share a key (same-named workloads in two namespaces): one run is
  // one attempt per key.
  investigated(rows: Row[], covered: Set<string>, outcome: string, attempted: boolean, runId?: string): string[] {
    const gaveUp: string[] = [];
    for (const key of new Set(rows.map((r) => r.key))) {
      const m = this.data.rows[key];
      if (!m) continue;
      const i = (m.investigation ??= { status: 'pending', attempts: 0 });
      if (attempted) i.attempts++;
      i.outcome = outcome;
      if (runId) i.runId = runId;
      if (covered.has(key)) i.status = 'complete';
      else if (i.attempts >= ATTEMPTS) {
        i.status = 'gave_up';
        gaveUp.push(key);
      }
    }
    return gaveUp;
  }

  // A row a noise rule hides still fires: it is not back to normal. Only its
  // recovery marker changes; novelty and the Slack window stay as they were.
  firing(key: string, at: Date): void {
    const m = this.data.rows[key];
    if (!m) return;
    delete m.recoveredAt;
    m.lastFiredAt = at.toISOString();
  }

  // Set once a reported row is seen healthy again; cleared when it fires again.
  recoveredAt(key: string): string | undefined {
    return this.data.rows[key]?.recoveredAt;
  }

  // Missing observations leave an issue open, even across several patrols or
  // a restart. Only a successful observation can resolve it, once. Older state
  // has no source/lifecycle markers: consider only the previous patrol's rows.
  // A row is back only once it has not fired for holdMin: one that flickers
  // stays one problem. A stalled rollout is back when it completes: it doesn't flicker.
  recovered(flaggedKeys: Set<string>, at: Date, windowMin: number, holdMin: number, observe: (key: string, sources: string[] | undefined) => { sources: string[]; ok: boolean }): string[] {
    const cutoff = at.getTime() - 1.5 * windowMin * 60_000;
    const recovered: string[] = [];
    for (const [key, m] of Object.entries(this.data.rows)) {
      if (flaggedKeys.has(key) || !m.lastReportedAt || m.recoveredAt || Date.parse(m.lastSeen) >= at.getTime()) continue;
      if (!m.sources?.length && Date.parse(m.lastSeen) < cutoff) continue;
      const observation = observe(key, m.sources);
      // Remember the conservative ownership inferred for a recent legacy row
      // even when its observers are down, so it can resolve after they return.
      m.sources = observation.sources;
      if (!observation.ok) continue;
      if (at.getTime() - Date.parse(m.lastFiredAt ?? m.lastSeen) < holdMin * 60_000 && !STALLED.test(key)) continue;
      m.recoveredAt = m.lastRecoveredAt = at.toISOString();
      // Work still owed ends with its episode. If the row fires again, that is a
      // new one (see seen()): owed at its reminder or when worse, with fresh attempts.
      if (m.investigation?.status === 'pending') delete m.investigation;
      recovered.push(key);
    }
    return recovered;
  }
}
