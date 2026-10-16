import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Engine } from './engine/run.js';
import type { SyncState } from './mcp/reposync.js';
import type { PatrolResult } from './runner.js';

// Prometheus metrics for the heartbeat alert: is the engine up, is the patrol
// running and succeeding, which sources it can't see, and spend against caps.
// Served on its own port so the NetworkPolicy can let monitoring in on just
// that, and the public route only ever exposes /mcp.
export class Metrics {
  private lastRun?: Date;
  private lastOk?: Date;
  private sources: Array<{ source: string; ok: boolean }> = [];
  private repos?: Map<string, SyncState>;

  // The codebase agent's synced repos: how fresh each clone is.
  repoSync(state: Map<string, SyncState>): void {
    this.repos = state;
  }

  patrol(at: Date, r?: PatrolResult): void {
    this.lastRun = at;
    if (!r) return;
    this.lastOk = at;
    this.sources = r.summary.sources.map((s) => ({ source: s.source, ok: s.ok }));
  }

  render(engine: Engine, now = new Date()): string {
    const day = now.toISOString().slice(0, 10);
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const out: string[] = [];
    const gauge = (name: string, help: string, rows: Array<[Record<string, string>, number]>) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      for (const [labels, v] of rows) {
        const l = Object.entries(labels).map(([k, x]) => `${k}="${esc(x)}"`).join(',');
        out.push(`${name}${l ? `{${l}}` : ''} ${v}`);
      }
    };
    gauge('engine_up', 'The engine process is serving.', [[{}, 1]]);
    gauge('engine_stop_switch', '1 while the kill switch is set (new runs are skipped).', [[{}, existsSync(engine.stopFile) ? 1 : 0]]);
    if (this.lastRun) gauge('engine_patrol_last_run_timestamp_seconds', 'When the patrol last ran.', [[{}, Math.floor(this.lastRun.getTime() / 1000)]]);
    if (this.lastOk) gauge('engine_patrol_last_success_timestamp_seconds', 'When the patrol last finished without failing.', [[{}, Math.floor(this.lastOk.getTime() / 1000)]]);
    if (this.sources.length) gauge('engine_patrol_source_up', '0 when the last patrol could not read this source (a blind spot).', this.sources.map((s) => [{ source: s.source }, s.ok ? 1 : 0]));
    if (this.repos?.size) {
      const rows = [...this.repos];
      gauge('engine_repo_last_fetch_timestamp_seconds', 'When each synced repo was last cloned or fetched (absent: never).', rows.filter(([, s]) => s.lastFetch).map(([repo, s]) => [{ repo }, Math.floor(s.lastFetch!.getTime() / 1000)]));
      gauge('engine_repo_sync_ok', '0 when the last sync of this repo failed.', rows.map(([repo, s]) => [{ repo }, s.lastError ? 0 : 1]));
    }
    gauge('engine_runs_today', 'Runs started today (UTC), by agent and status.', engine.store.counts(day).map((c) => [{ agent: c.agent, status: c.status }, c.n]));
    gauge('engine_spend_usd', 'Spend booked so far (running runs count their reservation).', [
      [{ period: 'day' }, engine.store.spent(day)],
      [{ period: 'month' }, engine.store.spent(day.slice(0, 7))],
    ]);
    gauge('engine_spend_cap_usd', 'Spend caps across all agents.', [[{ period: 'day' }, engine.dailyCapUsd], ...(engine.monthlyCapUsd !== undefined ? [[{ period: 'month' }, engine.monthlyCapUsd] as [Record<string, string>, number]] : [])]);
    return out.join('\n') + '\n';
  }
}

export function startMetrics(metrics: Metrics, engine: Engine, opts: { host: string; port: number }): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/metrics') return void res.writeHead(404).end();
    try {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(metrics.render(engine));
    } catch (e) {
      res.writeHead(500).end((e as Error).message);
    }
  });
  server.listen(opts.port, opts.host);
  return server;
}
