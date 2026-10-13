import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type RunStatus = 'ok' | 'no_output' | 'error' | 'budget' | 'deadline' | 'stopped' | 'loop' | 'skipped';

export type LedgerLine =
  | { ev: 'start'; run: string; agent: string; version: string; trigger: string; at: string; reserve: number }
  | { ev: 'end'; run: string; agent: string; at: string; status: RunStatus; cost: number; turns: number; outputs: number; challenge?: string; note?: string };

// Append-only JSONL. Money is reserved by the `start` line and settled by the
// `end` line, so a crashed run (no `end`) still counts its full reservation and
// a concurrent run sees the reservation before it starts.
export class Ledger {
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  append(line: LedgerLine): void {
    appendFileSync(this.file, JSON.stringify(line) + '\n');
  }

  read(): LedgerLine[] {
    if (!existsSync(this.file)) return [];
    const out: LedgerLine[] = [];
    for (const l of readFileSync(this.file, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l) as LedgerLine);
      } catch {
        /* torn last line after a crash: skip */
      }
    }
    return out;
  }

  // Spend for one UTC day, for one agent or all of them.
  spent(day: string, agent?: string): number {
    const starts = new Map<string, number>();
    let total = 0;
    for (const l of this.read()) {
      if (!l.at.startsWith(day) || (agent && l.agent !== agent)) continue;
      if (l.ev === 'start') starts.set(l.run, l.reserve);
      else {
        starts.delete(l.run);
        total += l.cost;
      }
    }
    for (const r of starts.values()) total += r;
    return total;
  }
}

// One run of an agent at a time. A lock left by a dead process is taken over.
export class Lock {
  private fd: number | undefined;
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  acquire(): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.fd = openSync(this.file, 'wx');
        writeFileSync(this.fd, String(process.pid));
        return true;
      } catch {
        const pid = Number(readFileSync(this.file, 'utf8').trim());
        if (pid && alive(pid)) return false;
        try {
          unlinkSync(this.file);
        } catch {
          /* raced with another taker */
        }
      }
    }
    return false;
  }

  release(): void {
    if (this.fd === undefined) return;
    closeSync(this.fd);
    this.fd = undefined;
    try {
      unlinkSync(this.file);
    } catch {
      /* already gone */
    }
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
