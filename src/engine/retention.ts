import { existsSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

// Hosted, runs live on a fixed-size volume next to the ledger and the users
// file. Run folders (transcripts, evidence) and cards older than the retention
// are deleted; the SQLite rows stay (they are small and hold the spend ledger).
// New runs are refused before the volume fills, so logins and settlement can
// still write.

const RUN_ID = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/;

export function sweep(o: { runsDir: string; outDir?: string; days: number; now?: Date }): { runs: number; cards: number; patrols: number } {
  const cutoff = (o.now ?? new Date()).getTime() - o.days * 86_400_000;
  let runs = 0;
  let cards = 0;
  let patrols = 0;
  if (existsSync(o.runsDir))
    for (const agent of readdirSync(o.runsDir, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      for (const run of readdirSync(join(o.runsDir, agent.name))) {
        const m = RUN_ID.exec(run);
        if (!m) continue;
        const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
        if (at >= cutoff) continue;
        rmSync(join(o.runsDir, agent.name, run), { recursive: true, force: true });
        runs++;
      }
    }
  const cardsDir = o.outDir ? join(o.outDir, 'cards') : undefined;
  if (cardsDir && existsSync(cardsDir))
    for (const f of readdirSync(cardsDir)) {
      const p = join(cardsDir, f);
      if (statSync(p).mtimeMs >= cutoff) continue;
      rmSync(p, { force: true });
      cards++;
    }
  // Patrol summaries (out/patrols) hold row text from production; they age out too.
  const patrolsDir = o.outDir ? join(o.outDir, 'patrols') : undefined;
  if (patrolsDir && existsSync(patrolsDir))
    for (const f of readdirSync(patrolsDir)) {
      const p = join(patrolsDir, f);
      if (statSync(p).mtimeMs >= cutoff) continue;
      rmSync(p, { recursive: true, force: true });
      patrols++;
    }
  return { runs, cards, patrols };
}

export function freeBytes(dir: string): number | undefined {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}
