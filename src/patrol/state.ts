import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Row } from './types.js';

// What the patrol remembers between runs. Small JSON file locally; a table later.
export interface RowMemory {
  firstSeen: string;
  lastSeen: string;
  lastReportedAt?: string;
  lastReportedNow?: number;
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

  seen(r: Row, at: Date): void {
    const iso = at.toISOString();
    const m = this.data.rows[r.key];
    if (!m || at.getTime() - Date.parse(m.lastSeen) > DEFAULT_NOVELTY.forgetAfterHours * H) this.data.rows[r.key] = { firstSeen: iso, lastSeen: iso };
    else m.lastSeen = iso;
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

  // Rows flagged last patrol and quiet now.
  recovered(flaggedKeys: Set<string>, at: Date, windowMin: number): string[] {
    const cutoff = at.getTime() - 1.5 * windowMin * 60_000; // i.e. seen in the previous patrol only
    return Object.entries(this.data.rows)
      .filter(([k, m]) => !flaggedKeys.has(k) && m.lastReportedAt && Date.parse(m.lastSeen) >= cutoff)
      .map(([k]) => k);
  }
}
