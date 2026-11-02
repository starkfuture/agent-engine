import type { Config } from '../config.js';
import type { Telemetry } from '../clients/telemetry.js';
import { collectChanges, collectCounter, collectHttp, collectLogs, collectTraces, collectWorkloads } from './collectors.js';
import type { Noise, NoiseRule } from './noise.js';
import type { Novelty, State } from './state.js';
import type { Change, Row, SourceHealth } from './types.js';
import { collectAlerts, collectGauge } from './infra.js';

export interface FlaggedRow extends Row {
  novelty: Novelty;
  firstSeen: string;
}

export interface Summary {
  at: string;
  windowMinutes: number;
  // Rows the LLM should look at: fresh, worse, or a periodic reminder.
  send: FlaggedRow[];
  // Still firing, already reported, not worse. Listed, not investigated again.
  known: FlaggedRow[];
  suppressed: Array<{ row: Row; rule: NoiseRule }>;
  recovered: string[];
  changes: Change[];
  sources: SourceHealth[];
  context?: Row[];
}

type Job = { source: string; run: () => Promise<Row[]> };

export async function buildSummary(tel: Telemetry, cfg: Config, noise: Noise, state: State, at: Date): Promise<Summary> {
  const w = cfg.windowMinutes;
  const s = cfg.sources;
  const observed = new Map<string, Set<string>>();
  const blind = new Map<string, string[]>();
  const jobs: Job[] = [
    ...s.http_families.map((f) => ({
      source: `http:${f.id}`,
      run: () => collectHttp(tel, f, at, w),
    })),
    ...s.error_counters.map((c) => ({
      source: `counter:${c.id}`,
      run: () => collectCounter(tel, c, at, w),
    })),
    ...(s.gauges ?? []).map((g) => ({
      source: `gauge:${g.id}`,
      run: () => {
        const keys = new Set<string>(),
          gaps: string[] = [];
        observed.set(`gauge:${g.id}`, keys);
        blind.set(`gauge:${g.id}`, gaps);
        return collectGauge(tel, g, at, keys, gaps);
      },
    })),
    {
      source: 'workloads',
      run: () => collectWorkloads(tel, s.workloads.namespaces, at, w),
    },
  ];
  if (s.alerts)
    jobs.push({
      source: 'alerts',
      run: () => collectAlerts(tel, s.alerts!, at),
    });
  if (tel.has.loki) jobs.push({ source: 'logs', run: () => collectLogs(tel, s.logs, at, w) });
  if (tel.has.tempo)
    jobs.push({
      source: 'traces',
      run: () => collectTraces(tel, s.traces, at, w),
    });

  const [settled, changes] = await Promise.all([Promise.allSettled(jobs.map((j) => j.run())), collectChanges(tel, s.workloads.namespaces, at).catch(() => [] as Change[])]);

  // Observer health is per source and is reported, never used to mute another
  // source's signal.
  const sources: SourceHealth[] = [];
  const rows: Row[] = [];
  const rowSources = new Map<string, string[]>();
  settled.forEach((r, i) => {
    const source = jobs[i]!.source;
    if (r.status === 'fulfilled') {
      const gaps = blind.get(source);
      sources.push(
        gaps?.length
          ? {
              source,
              ok: false,
              error: `${gaps.length} measurement(s) lack full coverage; ${gaps[0]}`.slice(0, 300),
            }
          : { source, ok: true },
      );
      rows.push(...r.value);
      for (const row of r.value) rowSources.set(row.key, [...new Set([...(rowSources.get(row.key) ?? []), source])]);
    } else
      sources.push({
        source,
        ok: false,
        error: String((r.reason as Error)?.message ?? r.reason).slice(0, 300),
      });
  });
  if (!tel.has.loki)
    sources.push({
      source: 'logs',
      ok: false,
      error: 'not configured (LOKI_DATASOURCE_UID)',
    });
  if (!tel.has.tempo)
    sources.push({
      source: 'traces',
      ok: false,
      error: 'not configured (TEMPO_DATASOURCE_UID)',
    });

  const send: FlaggedRow[] = [];
  const known: FlaggedRow[] = [];
  const suppressed: Summary['suppressed'] = [];
  const flagged = new Set<string>();
  const context = rows.filter((r) => r.contextOnly);

  for (const row of rows) {
    if (row.contextOnly) continue;
    // Suppression changes delivery, not the observed health of a signal.
    flagged.add(row.key);
    const rule = noise.suppressedBy(row, at);
    if (rule) {
      suppressed.push({ row, rule });
      continue;
    }
    const novelty = state.novelty(row, at);
    state.seen(row, at, rowSources.get(row.key)!);
    const f: FlaggedRow = {
      ...row,
      novelty,
      firstSeen: state.firstSeen(row.key) ?? at.toISOString(),
    };
    (novelty === 'known' ? known : send).push(f);
  }

  const healthy = new Set(sources.filter((s) => s.ok).map((s) => s.source));
  const recovered = state.recovered(flagged, at, w, (key, owners) => {
    if (owners?.length)
      return {
        sources: owners,
        ok: owners.every((source) => healthy.has(source) && (!source.startsWith('gauge:') || observed.get(source)?.has(key))),
      };
    // Conservative migration for state saved before collector ownership was
    // recorded: all configured collectors for this section must be healthy.
    const section = key.split('|')[0];
    const prefix = section === 'http' || section === 'drop' ? 'http:' : section === 'errors' ? 'counter:' : section === 'workload' ? 'workloads' : section;
    const relevant = sources.filter((s) => s.source === prefix || (prefix?.endsWith(':') && s.source.startsWith(prefix)));
    return {
      sources: relevant.map((s) => s.source),
      ok: relevant.length > 0 && relevant.every((s) => s.ok),
    };
  });
  const order = (a: Row, b: Row) => b.score.z - a.score.z;
  return {
    at: at.toISOString(),
    windowMinutes: w,
    send: send.sort(order),
    known: known.sort(order),
    suppressed,
    recovered,
    changes,
    sources,
    context,
  };
}

// ---- rendering for the LLM and for humans -----------------------------------
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function rowLine(r: FlaggedRow): string {
  if (r.section === 'alert') return `[alert] ${r.service} ${r.subject}: FIRING (${r.novelty}); existing rule, severity is investigation context`;
  if (r.measurement) {
    const m = r.measurement;
    return `[infra] ${r.service} ${r.subject}: ${m.level.toUpperCase()} (${r.novelty}) — ${fmt(m.value)} ${m.unit}, ${m.direction} ${m.threshold} for ${m.forMinutes} min; first seen ${r.firstSeen}`;
  }
  const c = r.counts;
  const t = r.totals ? ` | traffic now ${r.totals.now} (1d ${r.totals.d1}, 7d ${r.totals.d7})` : '';
  const status = r.status ? ` ${r.status}` : '';
  const tr = r.truncated ? ' [counts are lower bounds]' : '';
  return (
    `[${r.section}] ${r.service} ${r.subject}${status}: ${r.score.verdict.toUpperCase()} (${r.novelty}, ${r.score.trend}, first seen ${r.firstSeen})` +
    ` — now ${c.now}, 1h ago ${c.h1}, 1d ago ${c.d1}, 7d ago ${c.d7}, expected ${fmt(r.score.expected)}, z ${fmt(r.score.z)}${t}${tr}`
  );
}

export function renderSummary(s: Summary): string {
  const out: string[] = [
    `Patrol at ${s.at}, window ${s.windowMinutes} min. Counts are events in the window except explicitly labelled infra measurements and firing alert indicators.`,
  ];
  out.push('', `## New or worse (${s.send.length})`);
  for (const r of s.send) {
    out.push(`- ${rowLine(r)}`);
    if (r.detail) out.push(`  detail: ${r.detail.replace(/\n/g, ' ')}`);
  }
  if (s.known.length) out.push('', `## Still firing, already reported (${s.known.length})`, ...s.known.map((r) => `- ${rowLine(r)}`));
  if (s.recovered.length) out.push('', `## Recovered since last patrol (${s.recovered.length})`, ...s.recovered.map((k) => `- ${k}`));
  if (s.changes.length)
    out.push(
      '',
      '## Workload generation changes in the last 2 h (context, not proof of a deployment)',
      ...s.changes.map((c) => `- ${c.namespace}/${c.workload}: ${c.changes} generation change(s)`),
    );
  if (s.context?.length) out.push('', '## Existing info alerts (context only)', ...s.context.map((r) => `- ${r.service} ${r.subject}`));
  const down = s.sources.filter((x) => !x.ok);
  if (down.length) out.push('', '## Blind spots (sources that failed this patrol)', ...down.map((x) => `- ${x.source}: ${x.error}`));
  if (s.suppressed.length) out.push('', `## Dropped as known noise (${s.suppressed.length})`, ...s.suppressed.map(({ row, rule }) => `- ${row.key} (rule ${rule.id})`));
  return out.join('\n');
}
