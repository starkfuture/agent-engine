import type { ErrorCounter, HttpFamily, Sources } from '../config.js';
import type { Sample, Telemetry } from '../clients/telemetry.js';
import { DEFAULT_THRESHOLDS, isErrorStatus, scoreErrors, scoreTraffic, type Counts, type Thresholds } from './score.js';
import { redact, templateOf, truncate } from './text.js';
import { rowKey, type Change, type Row } from './types.js';

const H = 3600_000;
export const OFFSETS = { now: 0, h1: H, d1: 24 * H, d7: 7 * 24 * H } as const;
type Slot = keyof typeof OFFSETS;
const SLOTS = Object.keys(OFFSETS) as Slot[];
const zero = (): Counts => ({ now: 0, h1: 0, d1: 0, d7: 0 });
const shift = (at: Date, s: Slot) => new Date(at.getTime() - OFFSETS[s]);

// Runs one instant query at now / -1h / -1d / -7d and folds the results into
// Counts per key. Same query text every time, so recordings replay exactly.
async function fourWay(
  tel: Telemetry,
  query: string,
  at: Date,
  keyOf: (s: Sample) => string | undefined,
): Promise<Map<string, { counts: Counts; labels: Record<string, string> }>> {
  const res = await Promise.all(SLOTS.map((s) => tel.promInstant(query, shift(at, s))));
  const out = new Map<string, { counts: Counts; labels: Record<string, string> }>();
  SLOTS.forEach((slot, i) => {
    for (const sample of res[i] ?? []) {
      const k = keyOf(sample);
      if (k === undefined || !Number.isFinite(sample.value)) continue;
      let e = out.get(k);
      if (!e) out.set(k, (e = { counts: zero(), labels: sample.labels }));
      e.counts[slot] += sample.value;
    }
  });
  return out;
}

const round = (c: Counts): Counts => ({
  now: Math.round(c.now),
  h1: Math.round(c.h1),
  d1: Math.round(c.d1),
  d7: Math.round(c.d7),
});

// ---- HTTP: every route × status that isn't 2xx/3xx, plus traffic drops -------
export function httpQuery(f: HttpFamily, windowMin: number): string {
  const by = [f.service_label, f.route_label, f.status_label].filter(Boolean).join(', ');
  return `sum by (${by}) (increase(${f.selector}[${windowMin}m]))`;
}

export async function collectHttp(tel: Telemetry, f: HttpFamily, at: Date, windowMin: number, t: Thresholds = DEFAULT_THRESHOLDS): Promise<Row[]> {
  const query = httpQuery(f, windowMin);
  const svcOf = (l: Record<string, string>) => f.service ?? (f.service_label ? l[f.service_label] : undefined) ?? f.id;
  const routeOf = (l: Record<string, string>) => (f.route_label ? (l[f.route_label] ?? '?') : '*');
  const statusOf = (l: Record<string, string>) => l[f.status_label] ?? '?';

  const cells = await fourWay(tel, query, at, (s) => `${svcOf(s.labels)}\u0000${routeOf(s.labels)}\u0000${statusOf(s.labels)}`);
  const routeTotals = new Map<string, Counts>();
  const svcTotals = new Map<string, Counts>();
  for (const [k, { counts }] of cells) {
    const [svc, route] = k.split('\u0000') as [string, string];
    for (const [m, key] of [
      [routeTotals, `${svc}\u0000${route}`],
      [svcTotals, svc],
    ] as const) {
      const acc = m.get(key) ?? zero();
      for (const s of SLOTS) acc[s] += counts[s];
      m.set(key, acc);
    }
  }

  const rows: Row[] = [];
  for (const [k, { counts }] of cells) {
    const [service, subject, status] = k.split('\u0000') as [string, string, string];
    if (!isErrorStatus(status)) continue;
    const totals = routeTotals.get(`${service}\u0000${subject}`);
    const score = scoreErrors(counts, totals, t);
    if (score.verdict === 'steady') continue;
    rows.push({
      key: rowKey({ section: 'http', service, subject, status }),
      section: 'http',
      service,
      subject,
      status,
      counts: round(counts),
      ...(totals ? { totals: round(totals) } : {}),
      score,
      query,
    });
  }
  // Drops: per route and per service. A service-wide drop is the "everything
  // returns nothing" case that error counts can't see.
  for (const [k, totals] of routeTotals) {
    const [service, subject] = k.split('\u0000') as [string, string];
    const score = scoreTraffic(totals, t);
    if (score.verdict !== 'drop') continue;
    rows.push({ key: rowKey({ section: 'drop', service, subject }), section: 'drop', service, subject, counts: round(totals), score, query });
  }
  for (const [service, totals] of svcTotals) {
    const score = scoreTraffic(totals, t);
    if (score.verdict !== 'drop') continue;
    rows.push({ key: rowKey({ section: 'drop', service, subject: '(all routes)' }), section: 'drop', service, subject: '(all routes)', counts: round(totals), score, query });
  }
  return rows;
}

// ---- Error counters (SQS consumer errors, …) --------------------------------
export async function collectCounter(tel: Telemetry, c: ErrorCounter, at: Date, windowMin: number, t: Thresholds = DEFAULT_THRESHOLDS): Promise<Row[]> {
  const query = `sum by (${c.group_by.join(', ')}) (increase(${c.selector}[${windowMin}m]))`;
  const cells = await fourWay(tel, query, at, (s) => c.group_by.map((g) => s.labels[g] ?? '?').join('\u0000'));
  const rows: Row[] = [];
  for (const [k, { counts }] of cells) {
    const parts = k.split('\u0000');
    const score = scoreErrors(counts, undefined, { ...t, minCount: 3 });
    if (score.verdict === 'steady') continue;
    const service = parts[0] ?? c.id;
    const subject = `${c.id} ${parts.slice(1).join(' ')}`.trim();
    rows.push({ key: rowKey({ section: 'errors', service, subject }), section: 'errors', service, subject, counts: round(counts), score, query });
  }
  return rows;
}

// ---- Workloads: restarts, stuck containers, unavailable replicas ------------
// Pod name -> owning workload: strip the ReplicaSet hash and pod suffix.
// Kubernetes generates pod suffixes from an alphabet without vowels or 0/1/3
// (rand.SafeEncodeString), so a real name segment like "-proxy" or "-exporter"
// can't be mistaken for one. Only the first matching shape applies.
const K = '[bcdfghjklmnpqrstvwxz2456789]';
const POD_SUFFIXES = [new RegExp(`-${K}{6,10}-${K}{5}$`), /-\d+$/, new RegExp(`-${K}{5}$`)];
export function workloadOf(pod: string): string {
  for (const re of POD_SUFFIXES) if (re.test(pod)) return pod.replace(re, '');
  return pod;
}

export async function collectWorkloads(tel: Telemetry, nsRegex: string, at: Date, windowMin: number, t: Thresholds = DEFAULT_THRESHOLDS): Promise<Row[]> {
  const ns = `namespace=~"${nsRegex}"`;
  const one = { ...t, minCount: 1 };
  const rows: Row[] = [];

  const restartsQ = `sum by (namespace, pod, container) (increase(kube_pod_container_status_restarts_total{${ns}}[${windowMin}m]))`;
  const reasonsQ = `max by (namespace, pod, container, reason) (kube_pod_container_status_last_terminated_reason{${ns}})`;
  const waitingQ = `max by (namespace, pod, container, reason) (kube_pod_container_status_waiting_reason{${ns},reason!~"ContainerCreating|PodInitializing"}) > 0`;
  const unavailQ = `sum by (namespace, deployment) (kube_deployment_status_replicas_unavailable{${ns}})`;

  const [restarts, reasons, waiting, unavail] = await Promise.all([
    fourWay(tel, restartsQ, at, (s) => `${s.labels.namespace}/${workloadOf(s.labels.pod ?? '?')}/${s.labels.container}`),
    tel.promInstant(reasonsQ, at),
    fourWay(tel, waitingQ, at, (s) => `${s.labels.namespace}/${workloadOf(s.labels.pod ?? '?')}/${s.labels.container}/${s.labels.reason}`),
    fourWay(tel, unavailQ, at, (s) => `${s.labels.namespace}/${s.labels.deployment}`),
  ]);

  const lastReason = new Map<string, string>();
  for (const s of reasons) lastReason.set(`${s.labels.namespace}/${workloadOf(s.labels.pod ?? '?')}/${s.labels.container}`, s.labels.reason ?? '?');

  for (const [k, { counts }] of restarts) {
    const score = scoreErrors(counts, undefined, one);
    if (score.verdict === 'steady') continue;
    const [namespace, workload, container] = k.split('/') as [string, string, string];
    const reason = lastReason.get(k);
    rows.push({
      key: rowKey({ section: 'workload', service: workload, subject: `restarts ${container}` }),
      section: 'workload',
      service: workload,
      subject: `restarts ${container}`,
      counts: round(counts),
      score,
      ...(reason ? { detail: `last terminated: ${reason} (ns ${namespace})` } : { detail: `ns ${namespace}` }),
      query: restartsQ,
    });
  }
  for (const [k, { counts }] of waiting) {
    const score = scoreErrors(counts, undefined, one);
    if (score.verdict === 'steady') continue;
    const [namespace, workload, container, reason] = k.split('/') as [string, string, string, string];
    rows.push({
      key: rowKey({ section: 'workload', service: workload, subject: `waiting ${container}`, status: reason }),
      section: 'workload',
      service: workload,
      subject: `waiting ${container}`,
      status: reason,
      counts: round(counts),
      score,
      detail: `${counts.now} pod(s) waiting: ${reason} (ns ${namespace})`,
      query: waitingQ,
    });
  }
  for (const [k, { counts }] of unavail) {
    const score = scoreErrors(counts, undefined, one);
    if (score.verdict === 'steady') continue;
    const [namespace, deployment] = k.split('/') as [string, string];
    rows.push({
      key: rowKey({ section: 'workload', service: deployment, subject: 'unavailable replicas' }),
      section: 'workload',
      service: deployment,
      subject: 'unavailable replicas',
      counts: round(counts),
      score,
      detail: `ns ${namespace}`,
      query: unavailQ,
    });
  }
  return rows;
}

// Context, not anomalies: what rolled out recently.
export async function collectChanges(tel: Telemetry, nsRegex: string, at: Date, lookbackMin = 120): Promise<Change[]> {
  const q = `sum by (namespace, deployment) (changes(kube_deployment_status_observed_generation{namespace=~"${nsRegex}"}[${lookbackMin}m])) > 0`;
  const res = await tel.promInstant(q, at);
  return res
    .map((s) => ({ namespace: s.labels.namespace ?? '?', workload: s.labels.deployment ?? '?', changes: Math.round(s.value) }))
    .sort((a, b) => a.workload.localeCompare(b.workload));
}

// ---- Logs: error-level lines grouped into stable templates ------------------
export function logQuery(src: Sources['logs']): string {
  return `${src.selector} ${src.error_filter}`;
}

export async function collectLogs(tel: Telemetry, src: Sources['logs'], at: Date, windowMin: number, t: Thresholds = DEFAULT_THRESHOLDS): Promise<Row[]> {
  const query = logQuery(src);
  const w = windowMin * 60_000;
  const results = await Promise.all(
    SLOTS.map((s) => {
      const end = shift(at, s);
      return tel.lokiRange(query, new Date(end.getTime() - w), end, src.max_lines);
    }),
  );
  const cells = new Map<string, { counts: Counts; sample: string }>();
  const truncatedSlots = new Set<Slot>();
  SLOTS.forEach((slot, i) => {
    const lines = results[i] ?? [];
    if (lines.length >= src.max_lines) truncatedSlots.add(slot);
    for (const l of lines) {
      const svc = l.labels[src.service_label] ?? l.labels.container ?? '?';
      const tpl = templateOf(l.line);
      const k = `${svc}\u0000${tpl}`;
      let e = cells.get(k);
      if (!e) cells.set(k, (e = { counts: zero(), sample: '' }));
      e.counts[slot]++;
      if (slot === 'now' && !e.sample) e.sample = truncate(redact(l.line), 400);
    }
  });
  const rows: Row[] = [];
  for (const [k, { counts, sample }] of cells) {
    const score = scoreErrors(counts, undefined, { ...t, minCount: 3 });
    if (score.verdict === 'steady') continue;
    const [service, subject] = k.split('\u0000') as [string, string];
    rows.push({
      key: rowKey({ section: 'logs', service, subject }),
      section: 'logs',
      service,
      subject,
      counts,
      score,
      detail: sample,
      query,
      ...(truncatedSlots.size ? { truncated: true } : {}),
    });
  }
  return rows;
}

// ---- Traces: error traces grouped by root service + operation ---------------
export async function collectTraces(tel: Telemetry, src: Sources['traces'], at: Date, windowMin: number, t: Thresholds = DEFAULT_THRESHOLDS): Promise<Row[]> {
  const w = windowMin * 60_000;
  const results = await Promise.all(
    SLOTS.map((s) => {
      const end = shift(at, s);
      return tel.tempoSearch(src.traceql, new Date(end.getTime() - w), end, src.limit);
    }),
  );
  const cells = new Map<string, { counts: Counts; example: string }>();
  SLOTS.forEach((slot, i) => {
    for (const h of results[i] ?? []) {
      const k = `${h.rootService}\u0000${h.rootName}`;
      let e = cells.get(k);
      if (!e) cells.set(k, (e = { counts: zero(), example: '' }));
      e.counts[slot]++;
      if (slot === 'now' && !e.example) e.example = `trace ${h.traceId} (${h.durationMs} ms)`;
    }
  });
  const rows: Row[] = [];
  for (const [k, { counts, example }] of cells) {
    const score = scoreErrors(counts, undefined, t);
    if (score.verdict === 'steady') continue;
    const [service, subject] = k.split('\u0000') as [string, string];
    rows.push({ key: rowKey({ section: 'traces', service, subject }), section: 'traces', service, subject, counts, score, detail: example, query: src.traceql });
  }
  return rows;
}
