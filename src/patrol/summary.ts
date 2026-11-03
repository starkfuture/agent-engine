import type { Config } from '../config.js';
import type { Telemetry } from '../clients/telemetry.js';
import { collectCounter, collectHttp, collectLogs, collectTraces, collectWorkloads } from './collectors.js';
import { afterDeploy, collectArgocd, collectRollouts, deployLines, deploysHeading, listDeploys, notRead, type Deploys } from './deploys.js';
import type { Noise, NoiseRule } from './noise.js';
import type { Novelty, State } from './state.js';
import type { Row, SourceHealth } from './types.js';

export interface FlaggedRow extends Row {
  novelty: Novelty;
  firstSeen: string;
  afterDeploy?: string; // "first flagged N min after deploy …", when the service had one in the 2 h before
}

// Deploys shown to the investigator: context, never a row by themselves.
export const DEPLOY_HOURS = 6;

export interface Summary {
  at: string;
  windowMinutes: number;
  // Rows the LLM should look at: fresh, worse, or a periodic reminder.
  send: FlaggedRow[];
  // Still firing, already reported, not worse. Listed, not investigated again.
  known: FlaggedRow[];
  suppressed: Array<{ row: Row; rule: NoiseRule }>;
  recovered: string[];
  deploys: Deploys;
  sources: SourceHealth[];
}

type Job = { source: string; run: () => Promise<Row[]> };

export async function buildSummary(tel: Telemetry, cfg: Config, noise: Noise, state: State, at: Date): Promise<Summary> {
  const w = cfg.windowMinutes;
  const s = cfg.sources;
  const jobs: Job[] = [
    ...s.http_families.map((f) => ({ source: `http:${f.id}`, run: () => collectHttp(tel, f, at, w) })),
    ...s.error_counters.map((c) => ({ source: `counter:${c.id}`, run: () => collectCounter(tel, c, at, w) })),
    { source: 'workloads', run: () => collectWorkloads(tel, s.workloads.namespaces, at, w) },
    { source: 'rollouts', run: () => collectRollouts(tel, s, at) },
  ];
  if (s.deploys.argocd) jobs.push({ source: 'argocd', run: () => collectArgocd(tel, s, at, w) });
  if (tel.has.loki) jobs.push({ source: 'logs', run: () => collectLogs(tel, s.logs, at, w) });
  if (tel.has.tempo) jobs.push({ source: 'traces', run: () => collectTraces(tel, s.traces, at, w) });

  const [settled, deploys] = await Promise.all([
    Promise.allSettled(jobs.map((j) => j.run())),
    listDeploys(tel, s, at, DEPLOY_HOURS).catch((e: Error) => notRead(at, DEPLOY_HOURS, e)),
  ]);

  // Observer health is per source and is reported, never used to mute another
  // source's signal.
  const sources: SourceHealth[] = [];
  const rows: Row[] = [];
  const rowSources = new Map<string, string[]>();
  settled.forEach((r, i) => {
    const source = jobs[i]!.source;
    if (r.status === 'fulfilled') {
      sources.push({ source, ok: true });
      rows.push(...r.value);
      for (const row of r.value) rowSources.set(row.key, [...new Set([...(rowSources.get(row.key) ?? []), source])]);
    } else sources.push({ source, ok: false, error: String((r.reason as Error)?.message ?? r.reason).slice(0, 300) });
  });
  if (!tel.has.loki) sources.push({ source: 'logs', ok: false, error: 'not configured (LOKI_DATASOURCE_UID)' });
  if (!tel.has.tempo) sources.push({ source: 'traces', ok: false, error: 'not configured (TEMPO_DATASOURCE_UID)' });

  const send: FlaggedRow[] = [];
  const known: FlaggedRow[] = [];
  const suppressed: Summary['suppressed'] = [];
  const flagged = new Set<string>();

  for (const row of rows) {
    // Suppression changes delivery, not the observed health of a signal.
    flagged.add(row.key);
    const rule = noise.suppressedBy(row, at);
    if (rule) {
      suppressed.push({ row, rule });
      state.firing(row.key);
      continue;
    }
    const novelty = state.novelty(row, at);
    state.seen(row, at, rowSources.get(row.key)!);
    const firstSeen = state.firstSeen(row.key) ?? at.toISOString();
    const after = afterDeploy(row.service, firstSeen, deploys, s.deploys.aliases);
    const f: FlaggedRow = { ...row, novelty, firstSeen, ...(after ? { afterDeploy: after } : {}) };
    (novelty === 'known' ? known : send).push(f);
  }

  const healthy = new Set(sources.filter(s => s.ok).map(s => s.source));
  const recovered = state.recovered(flagged, at, w, (key, owners) => {
    if (owners?.length) return { sources: owners, ok: owners.every(source => healthy.has(source)) };
    // Conservative migration for state saved before collector ownership was
    // recorded: all configured collectors for this section must be healthy.
    const section = key.split('|')[0];
    const prefix = section === 'http' || section === 'drop' ? 'http:' : section === 'errors' ? 'counter:' : section === 'workload' ? 'workloads' : section;
    const relevant = sources.filter(s => s.source === prefix || (prefix?.endsWith(':') && s.source.startsWith(prefix)));
    return { sources: relevant.map(s => s.source), ok: relevant.length > 0 && relevant.every(s => s.ok) };
  });
  const order = (a: Row, b: Row) => b.score.z - a.score.z;
  return {
    at: at.toISOString(),
    windowMinutes: w,
    send: send.sort(order),
    known: known.sort(order),
    suppressed,
    recovered,
    deploys,
    sources,
  };
}

// ---- rendering for the LLM and for humans -----------------------------------
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function rowLine(r: FlaggedRow): string {
  const c = r.counts;
  const t = r.totals ? ` | traffic now ${r.totals.now} (1d ${r.totals.d1}, 7d ${r.totals.d7})` : '';
  const status = r.status ? ` ${r.status}` : '';
  const tr = r.truncated ? ' [counts are lower bounds]' : '';
  const dep = r.afterDeploy ? ` | ${r.afterDeploy}` : '';
  return (
    `[${r.section}] ${r.service} ${r.subject}${status}: ${r.score.verdict.toUpperCase()} (${r.novelty}, ${r.score.trend}, first seen ${r.firstSeen})` +
    ` — now ${c.now}, 1h ago ${c.h1}, 1d ago ${c.d1}, 7d ago ${c.d7}, expected ${fmt(r.score.expected)}, z ${fmt(r.score.z)}${t}${tr}${dep}`
  );
}

export function renderSummary(s: Summary): string {
  const out: string[] = [`Patrol at ${s.at}, window ${s.windowMinutes} min. Counts are events in the window.`];
  out.push('', `## New or worse (${s.send.length})`);
  for (const r of s.send) {
    out.push(`- ${rowLine(r)}`);
    if (r.detail) out.push(`  detail: ${r.detail.replace(/\n/g, ' ')}`);
  }
  if (s.known.length) out.push('', `## Still firing, already reported (${s.known.length})`, ...s.known.map((r) => `- ${rowLine(r)}`));
  if (s.recovered.length) out.push('', `## Recovered since last patrol (${s.recovered.length})`, ...s.recovered.map((k) => `- ${k}`));
  out.push('', `## ${deploysHeading(s.deploys)}`, ...deployLines(s.deploys));
  const down = s.sources.filter((x) => !x.ok);
  if (down.length) out.push('', '## Blind spots (sources that failed this patrol)', ...down.map((x) => `- ${x.source}: ${x.error}`));
  if (s.suppressed.length) out.push('', `## Dropped as known noise (${s.suppressed.length})`, ...s.suppressed.map(({ row, rule }) => `- ${row.key} (rule ${rule.id})`));
  return out.join('\n');
}
