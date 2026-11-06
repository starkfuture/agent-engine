import type { Config } from '../config.js';
import type { Telemetry } from '../clients/telemetry.js';
import { collectCounter, collectHttp, collectLogs, collectTraces, collectWorkloads, noteOf, spanErrorsOf, type SpanErrors } from './collectors.js';
import { afterDeploy, collectArgocd, collectRollouts, deployLines, deploysHeading, listDeploys, notRead, type Deploys } from './deploys.js';
import type { Noise, NoiseRule } from './noise.js';
import type { Novelty, State } from './state.js';
import type { Row, SourceHealth } from './types.js';

// Rows the AI must never be able to hide: protected journeys (never_suppress),
// big jumps and rollout rows (a stalled rollout, an Argo CD app degraded or a
// failed sync). They are posted at once, with or without the AI. A jump in
// client errors (4xx) is not: it is usually one client or a few until the AI
// shows otherwise, so it waits its turn like any other row, unless
// clientErrors (PATROL_URGENT_CLIENT_ERRORS) says a 4xx jump is urgent too.
export function urgent(r: Row, noise: Noise, clientErrors = false): boolean {
  const clientError = r.section === 'http' && /^4\d\d$/.test(r.status ?? '');
  return urgentKind(r, noise) || ((clientErrors || !clientError) && r.counts.now >= 50 && r.counts.now >= 5 * Math.max(1, r.score.expected));
}

// Urgent whatever the counts: a rollout row or a protected journey. A row key
// tells these (the eval reads them back from one).
export function urgentKind(r: Pick<Row, 'section' | 'service' | 'subject' | 'status'>, noise: Noise): boolean {
  return r.section === 'rollout' || noise.protected(r);
}

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
  // News seen in fewer patrols in a row than PATROL_CONFIRM_PATROLS: no AI
  // run and no post yet. Urgent rows never wait.
  waiting: FlaggedRow[];
  suppressed: Array<{ row: Row; rule: NoiseRule }>;
  recovered: string[];
  // A recovered row decided without its count, and why (trace rows on a capped search).
  recoveryNotes?: Record<string, string>;
  deploys: Deploys;
  sources: SourceHealth[];
}

type Job = { source: string; run: () => Promise<Row[]> };

// A trace row whose (service, name) has no span-metric error series (most HTTP
// roots: their error is on a child span). 'fallback': back as before, once
// absent from the sample for the hold, with a note. 'unknown': never back while
// the search is capped, which in prod is every patrol. Open question 5.
const UNMAPPED_TRACE_ROWS = 'fallback' as 'fallback' | 'unknown';

// A trace row absent this patrol, while the search is capped (collectors.ts, SpanErrors):
// 'firing': its errors are above steady, so it still fires; 'steady': back after the hold;
// 'unknown': no count to tell, so no recovery; a note: back after the hold, as before, without a count.
function traceCount(spans: SpanErrors, key: string): 'firing' | 'steady' | 'unknown' | { note: string } {
  if ('notChecked' in spans) return { note: 'recovered on a capped sample, count not checked' };
  if ('unreadable' in spans) return 'unknown';
  const score = spans.counts.get(key);
  if (!score) return UNMAPPED_TRACE_ROWS === 'fallback' ? { note: 'recovered on a capped sample, no count' } : 'unknown';
  return score.verdict === 'steady' ? 'steady' : 'firing';
}

export async function buildSummary(tel: Telemetry, cfg: Config, noise: Noise, state: State, at: Date): Promise<Summary> {
  const w = cfg.windowMinutes;
  const s = cfg.sources;
  // Stalled rows flagged by a recent patrol and not recovered stay until their
  // rollout completes (collectRollouts). Older memory is a stale row, not a stall.
  const openStalls = () =>
    Object.entries(state.data.rows)
      .filter(([k, m]) => /^rollout\|[^|]+\|stalled\|/.test(k) && !m.recoveredAt && at.getTime() - Date.parse(m.lastSeen) <= 6 * 3600_000)
      .map(([k]) => k);
  const jobs: Job[] = [
    ...s.http_families.map((f) => ({ source: `http:${f.id}`, run: () => collectHttp(tel, f, at, w) })),
    ...s.error_counters.map((c) => ({ source: `counter:${c.id}`, run: () => collectCounter(tel, c, at, w) })),
    { source: 'workloads', run: () => collectWorkloads(tel, s.workloads.namespaces, at, w) },
    { source: 'rollouts', run: () => collectRollouts(tel, s, at, openStalls) },
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
      sources.push({ source, ok: true, ...noteOf(r.value) });
      rows.push(...r.value);
      for (const row of r.value) rowSources.set(row.key, [...new Set([...(rowSources.get(row.key) ?? []), source])]);
    } else sources.push({ source, ok: false, error: String((r.reason as Error)?.message ?? r.reason).slice(0, 300) });
  });
  if (!tel.has.loki) sources.push({ source: 'logs', ok: false, error: 'not configured (LOKI_DATASOURCE_UID)' });
  if (!tel.has.tempo) sources.push({ source: 'traces', ok: false, error: 'not configured (TEMPO_DATASOURCE_UID)' });

  const send: FlaggedRow[] = [];
  const known: FlaggedRow[] = [];
  const waiting: FlaggedRow[] = [];
  const suppressed: Summary['suppressed'] = [];
  const flagged = new Set<string>();

  for (const row of rows) {
    // Suppression changes delivery, not the observed health of a signal.
    flagged.add(row.key);
    const rule = noise.suppressedBy(row, at);
    if (rule) {
      suppressed.push({ row, rule });
      state.firing(row.key, at);
      continue;
    }
    const novelty = state.novelty(row, at);
    const held = state.seen(row, at, rowSources.get(row.key)!, urgent(row, noise, cfg.urgentClientErrors) ? undefined : { windowMin: w, patrols: cfg.confirmPatrols });
    const firstSeen = state.firstSeen(row.key) ?? at.toISOString();
    const after = afterDeploy(row.service, firstSeen, deploys, s.deploys.aliases);
    const f: FlaggedRow = { ...row, novelty, firstSeen, ...(after ? { afterDeploy: after } : {}) };
    (novelty === 'known' ? known : held ? waiting : send).push(f);
  }

  // A read that can't tell whether the source reads at all (unknown) shows no row back.
  const healthy = new Set(sources.filter(s => s.ok && !s.unknown).map(s => s.source));
  const observe = (key: string, owners: string[] | undefined) => {
    if (owners?.length) return { sources: owners, ok: owners.every(source => healthy.has(source)) };
    // Conservative migration for state saved before collector ownership was
    // recorded: all configured collectors for this section must be healthy.
    const section = key.split('|')[0];
    const prefix = section === 'http' || section === 'drop' ? 'http:' : section === 'errors' ? 'counter:' : section === 'workload' ? 'workloads' : section;
    const relevant = sources.filter(s => s.source === prefix || (prefix?.endsWith(':') && s.source.startsWith(prefix)));
    return { sources: relevant.map(s => s.source), ok: relevant.length > 0 && relevant.every(s => healthy.has(s.source)) };
  };
  // A capped trace search is a sample: a row missing from it is no proof it
  // stopped. Its uncapped error count decides (set only when capped). A count
  // above steady fires, as a row a noise rule hides does: the hold starts over.
  const traces = settled[jobs.findIndex((j) => j.source === 'traces')];
  const spans = traces?.status === 'fulfilled' ? spanErrorsOf(traces.value) : undefined;
  const noted = new Map<string, string>();
  const recovered = state.recovered(flagged, at, w, cfg.recoverAfterMinutes, (key, owners) => {
    const seen = observe(key, owners);
    if (!seen.ok || !spans || !key.startsWith('traces|')) return seen;
    const count = traceCount(spans, key);
    if (count === 'firing') state.firing(key, at);
    if (typeof count === 'object') noted.set(key, count.note);
    return { ...seen, ok: count !== 'firing' && count !== 'unknown' };
  });
  const recoveryNotes = Object.fromEntries(recovered.filter((k) => noted.has(k)).map((k) => [k, noted.get(k)!]));
  const order = (a: Row, b: Row) => b.score.z - a.score.z;
  return {
    at: at.toISOString(),
    windowMinutes: w,
    send: send.sort(order),
    known: known.sort(order),
    waiting: waiting.sort(order),
    suppressed,
    recovered,
    ...(Object.keys(recoveryNotes).length ? { recoveryNotes } : {}),
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

// forModel: without the rows still waiting for a second patrol. The
// investigator isn't asked about them yet; the patrol file lists them.
export function renderSummary(s: Summary, o: { forModel?: boolean } = {}): string {
  const out: string[] = [`Patrol at ${s.at}, window ${s.windowMinutes} min. Counts are events in the window.`];
  out.push('', `## New or worse (${s.send.length})`);
  for (const r of s.send) {
    out.push(`- ${rowLine(r)}`);
    if (r.detail) out.push(`  detail: ${r.detail.replace(/\n/g, ' ')}`);
  }
  if (s.known.length) out.push('', `## Still firing, already reported (${s.known.length})`, ...s.known.map((r) => `- ${rowLine(r)}`));
  if (s.waiting?.length && !o.forModel) out.push('', `## Waiting for the next patrol: news once, not investigated yet (${s.waiting.length})`, ...s.waiting.map((r) => `- ${rowLine(r)}`));
  if (s.recovered.length) out.push('', `## Recovered since last patrol (${s.recovered.length})`, ...s.recovered.map((k) => `- ${k}${s.recoveryNotes?.[k] ? ` (${s.recoveryNotes[k]})` : ''}`));
  out.push('', `## ${deploysHeading(s.deploys)}`, ...deployLines(s.deploys));
  const down = s.sources.filter((x) => !x.ok);
  const part = s.sources.filter((x) => x.ok && x.note);
  if (down.length || part.length) out.push('', '## Blind spots (sources that failed this patrol, or were read only in part)', ...down.map((x) => `- ${x.source}: ${x.error}`), ...part.map((x) => `- ${x.source} (read, incomplete): ${x.note}`));
  if (s.suppressed.length) out.push('', `## Dropped as known noise (${s.suppressed.length})`, ...s.suppressed.map(({ row, rule }) => `- ${row.key} (rule ${rule.id})`));
  return out.join('\n');
}
