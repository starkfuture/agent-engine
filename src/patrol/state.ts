import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Row } from './types.js';

// What the patrol remembers between runs. Small JSON file locally; a table later.
export interface RowMemory {
  firstSeen: string;
  lastSeen: string;
  lastReportedAt?: string;
  lastReportedNow?: number;
  sources?: string[]; // collectors that observed the row; absent in older state files
  recoveredAt?: string;
}
export interface StateData {
  rows: Record<string, RowMemory>;
  spend?: Record<string, number>; // legacy; spend is in the engine ledger now
}

const H = 3600_000;

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

  seen(r: Row, at: Date, sources: string[]): void {
    const iso = at.toISOString();
    const m = this.data.rows[r.key];
    if (!m || at.getTime() - Date.parse(m.lastSeen) > DEFAULT_NOVELTY.forgetAfterHours * H) this.data.rows[r.key] = { firstSeen: iso, lastSeen: iso };
    else m.lastSeen = iso;
    const current = this.data.rows[r.key]!;
    current.sources = sources;
    delete current.recoveredAt;
  }

  reported(r: Row, at: Date): void {
    const m = this.data.rows[r.key];
    if (!m) return;
    m.lastReportedAt = at.toISOString();
    m.lastReportedNow = r.counts.now;
  }

  firstSeen(key: string): string | undefined {
    return this.data.rows[key]?.firstSeen;
  }

  // Set once a reported row is seen healthy again; cleared when it fires again.
  recoveredAt(key: string): string | undefined {
    return this.data.rows[key]?.recoveredAt;
  }

  // Missing observations leave an issue open, even across several patrols or
  // a restart. Only a successful observation can resolve it, once. Older state
  // has no source/lifecycle markers: consider only the previous patrol's rows.
  recovered(flaggedKeys: Set<string>, at: Date, windowMin: number, observe: (key: string, sources: string[] | undefined) => { sources: string[]; ok: boolean }): string[] {
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
      m.recoveredAt = at.toISOString();
      recovered.push(key);
    }
    return recovered;
  }
}
