#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, loadDotEnv, type Config } from './config.js';
import { GrafanaTelemetry, readToken, RecordingTelemetry, ReplayTelemetry, type Telemetry } from './clients/telemetry.js';
import { httpQuery } from './patrol/collectors.js';
import { Noise } from './patrol/noise.js';
import { State } from './patrol/state.js';
import { rowLine } from './patrol/summary.js';
import { CardSink } from './output/sink.js';
import { patrolOnce } from './runner.js';

const USAGE = `sre-agent <command> [options]

  doctor                      check access, list datasources, show real metric labels
  patrol                      one patrol pass
      --at <ISO>              evaluate at a past time (replay against live data)
      --llm                   run the investigator (needs ANTHROPIC_API_KEY or Bedrock)
      --post                  post cards to SLACK_WEBHOOK_URL
      --replay <dir>          read telemetry from an export instead of Grafana
      --fresh                 in-memory state (don't read or write .state/)
  loop                        patrol every window (default 15 min) until stopped; same flags
  export --from <ISO> --to <ISO> [--out <dir>] [--step <min>]
                              record every patrol query in the range (no LLM), for offline replay
  replay --from <ISO> --to <ISO> [--step <min>] [--replay <dir>] [--llm]
                              run the patrol across a past range with one shared state; prints
                              what would have been reported, step by step
`;

const { positionals, values: a } = parseArgs({
  allowPositionals: true,
  options: {
    at: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    step: { type: 'string' },
    out: { type: 'string' },
    replay: { type: 'string' },
    llm: { type: 'boolean', default: false },
    post: { type: 'boolean', default: false },
    fresh: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

function liveTelemetry(cfg: Config): GrafanaTelemetry {
  return new GrafanaTelemetry({ url: cfg.grafanaUrl, token: readToken(cfg.grafanaTokenFile), promUid: cfg.promUid, lokiUid: cfg.lokiUid, tempoUid: cfg.tempoUid });
}
function telemetry(cfg: Config): Telemetry {
  return a.replay ? new ReplayTelemetry(resolve(a.replay)) : liveTelemetry(cfg);
}
function date(s: string | undefined, name: string): Date {
  const d = new Date(s ?? '');
  if (Number.isNaN(d.getTime())) throw new Error(`--${name} must be an ISO time, e.g. 2026-09-29T12:00:00Z`);
  return d;
}
// Patrol times sit on window boundaries so recordings and replays line up.
const align = (d: Date, min: number) => new Date(Math.floor(d.getTime() / (min * 60_000)) * min * 60_000);

async function doctor(cfg: Config) {
  const tel = liveTelemetry(cfg);
  console.log(`Grafana ${cfg.grafanaUrl}, token file ${cfg.grafanaTokenFile}: present`);
  try {
    const ds = await tel.datasources();
    console.log('\nDatasources (set LOKI_DATASOURCE_UID / TEMPO_DATASOURCE_UID from these):');
    for (const d of ds) console.log(`  ${d.type.padEnd(12)} uid=${d.uid}  ${d.name}`);
  } catch (e) {
    console.log(`  could not list datasources: ${(e as Error).message}`);
  }
  const now = new Date();
  console.log('\nHTTP families (labels on a real series; check route/status/service labels match sources.yaml):');
  for (const f of cfg.sources.http_families) {
    try {
      const res = await tel.promInstant(`topk(2, ${f.selector})`, now);
      const want = [f.service_label, f.route_label, f.status_label].filter(Boolean) as string[];
      const have = new Set(res.flatMap((s) => Object.keys(s.labels)));
      const missing = want.filter((l) => !have.has(l));
      console.log(`  ${f.id}: ${res.length ? 'OK' : 'NO SERIES'}${missing.length ? `  MISSING LABELS: ${missing.join(', ')}` : ''}`);
      if (res[0]) console.log(`    labels: ${[...have].sort().join(', ')}`);
      const sample = await tel.promInstant(httpQuery(f, cfg.windowMinutes), now);
      console.log(`    patrol query returns ${sample.length} cells`);
    } catch (e) {
      console.log(`  ${f.id}: ERROR ${(e as Error).message}`);
    }
  }
  for (const c of cfg.sources.error_counters) {
    try {
      const res = await tel.promInstant(`topk(2, ${c.selector})`, now);
      const have = new Set(res.flatMap((s) => Object.keys(s.labels)));
      const missing = c.group_by.filter((l) => !have.has(l));
      console.log(`  counter ${c.id}: ${res.length ? 'OK' : 'NO SERIES'}${missing.length ? `  MISSING LABELS: ${missing.join(', ')}` : ''}${res[0] ? `  labels: ${[...have].sort().join(', ')}` : ''}`);
    } catch (e) {
      console.log(`  counter ${c.id}: ERROR ${(e as Error).message}`);
    }
  }
  try {
    const res = await tel.promInstant(`count by (namespace) (kube_pod_info{namespace=~"${cfg.sources.workloads.namespaces}"})`, now);
    console.log(`\nWorkloads: pods per namespace: ${res.map((s) => `${s.labels.namespace}=${s.value}`).join(', ') || 'NONE (check workloads.namespaces)'}`);
  } catch (e) {
    console.log(`\nWorkloads: ERROR ${(e as Error).message}`);
  }
  if (tel.has.loki) {
    try {
      const lines = await tel.lokiRange(`${cfg.sources.logs.selector} ${cfg.sources.logs.error_filter}`, new Date(now.getTime() - 15 * 60_000), now, 5);
      const keys = new Set(lines.flatMap((l) => Object.keys(l.labels)));
      console.log(`\nLoki: ${lines.length} error line(s) in 15 min sample; stream labels: ${[...keys].sort().join(', ') || '-'}`);
      if (lines.length && !keys.has(cfg.sources.logs.service_label)) console.log(`  MISSING service label "${cfg.sources.logs.service_label}"`);
    } catch (e) {
      console.log(`\nLoki: ERROR ${(e as Error).message}`);
    }
  } else console.log('\nLoki: not configured');
  if (tel.has.tempo) {
    try {
      const hits = await tel.tempoSearch(cfg.sources.traces.traceql, new Date(now.getTime() - 15 * 60_000), now, 5);
      console.log(`Tempo: ${hits.length} hit(s); e.g. ${hits[0] ? `${hits[0].rootService} ${hits[0].rootName}` : '-'}`);
    } catch (e) {
      console.log(`Tempo: ERROR ${(e as Error).message}`);
    }
  } else console.log('Tempo: not configured');
  console.log(`\nLLM: ${cfg.llm.available ? `credentials present, model ${cfg.llm.model}` : 'no credentials (patrol runs without the investigator)'}`);
}

async function main() {
  const cmd = positionals[0];
  if (!cmd || a.help) {
    console.log(USAGE);
    return;
  }
  loadDotEnv();
  const cfg = loadConfig();
  const noise = Noise.load(cfg.noiseFile);
  const sink = new CardSink(cfg.outDir, cfg.slackWebhookUrl);
  const w = cfg.windowMinutes;

  switch (cmd) {
    case 'doctor':
      return doctor(cfg);

    case 'patrol': {
      const state = a.fresh ? State.memory() : State.load(cfg.stateFile);
      const at = align(a.at ? date(a.at, 'at') : new Date(), w);
      const r = await patrolOnce(telemetry(cfg), cfg, noise, state, sink, at, { llm: a.llm, post: a.post, log });
      for (const row of r.summary.send) console.log(rowLine(row));
      for (const c of r.cards) console.log(`card: ${c}`);
      return;
    }

    case 'loop': {
      const tel = telemetry(cfg);
      const state = State.load(cfg.stateFile);
      for (;;) {
        const at = align(new Date(), w);
        try {
          await patrolOnce(tel, cfg, noise, state, sink, at, { llm: a.llm, post: a.post, log });
        } catch (e) {
          log(`patrol failed: ${(e as Error).message}`);
        }
        const next = at.getTime() + w * 60_000 + 30_000; // 30 s after the boundary, so the last scrape is in
        await new Promise((r) => setTimeout(r, Math.max(5_000, next - Date.now())));
      }
    }

    case 'export': {
      const from = align(date(a.from, 'from'), w);
      const to = date(a.to, 'to');
      const step = Number(a.step ?? w);
      const dir = resolve(a.out ?? join('data', `export-${from.toISOString().slice(0, 13)}`));
      const tel = new RecordingTelemetry(liveTelemetry(cfg), dir);
      const state = State.memory();
      const quietSink = new CardSink(join(dir, 'out'));
      const exportCfg = { ...cfg, outDir: join(dir, 'out') };
      writeFileSync(join(dir, 'export.json'), JSON.stringify({ from, to, stepMinutes: step, windowMinutes: w, sources: cfg.sources, createdAt: new Date() }, null, 1));
      for (let t = from; t <= to; t = new Date(t.getTime() + step * 60_000)) {
        try {
          await patrolOnce(tel, exportCfg, noise, state, quietSink, t, { llm: false, post: false, log });
        } catch (e) {
          log(`${t.toISOString()} failed: ${(e as Error).message}`);
        }
      }
      // Raw context beyond the patrol queries, for later analysis once retention drops it:
      // every family at 5-min resolution, and error log lines per hour (redacted).
      const H = 3600_000;
      for (let s = from.getTime(); s < to.getTime(); s += 6 * H) {
        const e = new Date(Math.min(s + 6 * H, to.getTime()));
        for (const f of cfg.sources.http_families)
          await tel.promRange(httpQuery(f, 5), new Date(s), e, 300).catch((err) => log(`raw ${f.id}: ${(err as Error).message}`));
      }
      if (tel.has.loki)
        for (let s = from.getTime(); s < to.getTime(); s += H)
          await tel
            .lokiRange(`${cfg.sources.logs.selector} ${cfg.sources.logs.error_filter}`, new Date(s), new Date(s + H), 5000)
            .catch((err) => log(`raw logs: ${(err as Error).message}`));
      log(`recorded into ${dir}`);
      return;
    }

    case 'replay': {
      const from = align(date(a.from, 'from'), w);
      const to = date(a.to, 'to');
      const step = Number(a.step ?? w);
      const tel = telemetry(cfg);
      const state = State.memory();
      const outDir = resolve(cfg.outDir, `replay-${from.toISOString().slice(0, 16).replace(/:/g, '')}`);
      mkdirSync(outDir, { recursive: true });
      const replayCfg = { ...cfg, outDir };
      const timeline: string[] = [`# Replay ${from.toISOString()} → ${to.toISOString()} (step ${step} min, window ${w} min)`, ''];
      for (let t = from; t <= to; t = new Date(t.getTime() + step * 60_000)) {
        const r = await patrolOnce(tel, replayCfg, noise, state, new CardSink(outDir), t, { llm: a.llm, post: false, log });
        const down = r.summary.sources.filter((s) => !s.ok).map((s) => s.source);
        timeline.push(`## ${t.toISOString()}  send ${r.summary.send.length} · known ${r.summary.known.length} · recovered ${r.summary.recovered.length}${down.length ? ` · blind: ${down.join(', ')}` : ''}`);
        for (const row of r.summary.send) timeline.push(`- ${rowLine(row)}`);
        if (r.investigation) timeline.push(`- investigator: ${r.investigation.outcome}, ${r.investigation.reports.length} report(s), $${r.investigation.costUsd.toFixed(2)}`);
      }
      writeFileSync(join(outDir, 'timeline.md'), timeline.join('\n') + '\n');
      console.log(timeline.join('\n'));
      log(`timeline: ${join(outDir, 'timeline.md')}`);
      if (tel instanceof ReplayTelemetry && tel.misses) log(`${tel.misses} query(ies) were not in the recording`);
      return;
    }

    default:
      console.log(USAGE);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
