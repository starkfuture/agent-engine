import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Config, HttpFamily } from '../config.js';
import { TEMPO_MAX_MINUTES, type LogLine, type Sample, type Telemetry } from '../clients/telemetry.js';
import type { Evidence } from '../engine/evidence.js';
import type { ToolFactory } from '../engine/run.js';
import { requireSeries, workloadOf } from '../patrol/collectors.js';
import { deployLines, deploysHeading, listDeploys } from '../patrol/deploys.js';
import { fence, identitiesOf, redact, templateOf, truncate } from '../engine/text.js';

const H = 3600_000;

// Add a label matcher to a selector that may be `metric`, `metric{...}` or `{...}`.
export function withMatcher(selector: string, matcher: string): string {
  const s = selector.trim();
  if (s.endsWith('}')) {
    const inner = s.slice(s.lastIndexOf('{') + 1, -1).trim();
    return `${s.slice(0, -1)}${inner ? ',' : ''}${matcher}}`;
  }
  return `${s}{${matcher}}`;
}
const q = (v: string) => JSON.stringify(v); // PromQL/LogQL double-quoted string literal

function familiesFor(cfg: Config, service: string): Array<{ f: HttpFamily; sel: string }> {
  const out: Array<{ f: HttpFamily; sel: string }> = [];
  for (const f of cfg.sources.http_families) {
    if (f.service) {
      if (f.service === service) out.push({ f, sel: f.selector });
    } else if (f.service_label) out.push({ f, sel: withMatcher(f.selector, `${f.service_label}=${q(service)}`) });
  }
  return out;
}

const hhmm = (sec: number) => new Date(sec * 1000).toISOString().slice(5, 16).replace('T', ' ');

// Loki returns the newest `limit` lines, so a search at its limit reaches back
// only to its oldest line: where the limit cut the window, not when the problem
// started (run 20261103T124535Z-monitor-dcb74b reported that cut as the start).
// Per-10-minute counts of the same selector, which no line limit cuts, give
// the real timeline. Loki (and Grafana) move a metric query's points onto
// multiples of its step, so the buckets are asked for on those multiples: the
// times shown are the times counted, and a bucket with no point is 0. An
// unfiltered selector over a long window would count every line of the
// namespace, so those counts are skipped.
const UNFILTERED_MAX_MIN = 60;
async function limitCut(tel: Telemetry, sel: string, lines: LogLine[], end: Date, minutes: number, unfiltered: boolean): Promise<string[]> {
  const oldest = lines.reduce((m, l) => (BigInt(l.tsNs) < m ? BigInt(l.tsNs) : m), BigInt(lines[0]!.tsNs));
  const out = [`limit hit: the limit cut the window at ${new Date(Number(oldest / 1_000_000n)).toISOString()}, the oldest line returned. That is where this search stopped reading, not when the problem started: older lines in the window were not read.`];
  const step = minutes >= 10 ? 10 : 1;
  if (unfiltered && minutes > UNFILTERED_MAX_MIN) {
    out.push(`per-${step}-minute counts skipped: an unfiltered search over more than ${UNFILTERED_MAX_MIN} min would count every line; narrow it (service, contains, errors_only) or shorten the window.`);
    return out;
  }
  const s = step * 60;
  const endSec = Math.floor(end.getTime() / 1000);
  const first = Math.floor((endSec - minutes * 60) / s) * s + s; // the first bucket end inside the window
  const last = Math.floor(endSec / s) * s; // never past the window's end
  try {
    const series = await tel.lokiMetric(`sum(count_over_time(${sel.trim()} [${step}m]))`, new Date(first * 1000), new Date(last * 1000), s);
    const byTime = new Map<number, number>();
    for (let t = first; t <= last; t += s) byTime.set(t, 0);
    for (const x of series) for (const [t, v] of x.points) byTime.set(Math.round(t), (byTime.get(Math.round(t)) ?? 0) + v);
    const buckets = [...byTime].sort((a, b) => a[0] - b[0]);
    out.push(`per ${step} min (matching lines in the ${step} min up to each time): ${buckets.map(([t, v]) => `${hhmm(t)}=${Math.round(v)}`).join(' ')}`);
  } catch (e) {
    out.push(`per-${step}-minute counts not available (${(e as Error).message})`);
  }
  return out;
}

const minute = (sec: number) => `${new Date(sec * 1000).toISOString().slice(0, 16)}Z`;
function since(fromSec: number, at: Date): string {
  const m = Math.max(0, Math.round((at.getTime() / 1000 - fromSec) / 60));
  return m >= 1440 ? `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

// ---- firing_alerts -------------------------------------------------------------
// Left out: always-on alerts, the engine's own, and routing tests
// (JourneyRouteTest is one; the Journey* customer journeys stay).
const ALERTS_SKIP = 'Watchdog|InfoInhibitor|AgentEngine.*|.*RouteTest';
// Info alerts that fire most of the week (the rules backtest drops both): one count line.
const NOISY_ALERTS = new Set(['PostgresPodPoolSaturated', 'CPUThrottlingHigh']);
const ALERT_OBJECTS = ['service', 'app', 'deployment', 'statefulset', 'pod', 'container', 'persistentvolumeclaim', 'horizontalpodautoscaler', 'datname'];
const SEVERITY_RANK: Record<string, number> = { critical: 0, error: 1, warning: 2, info: 3, none: 4 };

interface Alert {
  name: string;
  ns: string; // ecom_namespace when set: a Slack copy's original namespace
  severity: string;
  firing: boolean;
  copy: boolean;
  objects: Record<string, string>;
  since?: number;
  copies: Set<string>;
}

// ALERTS_FOR_STATE carries the alert's labels without alertstate.
const alertKey = (l: Record<string, string>) =>
  JSON.stringify(
    Object.keys(l)
      .filter((k) => k !== '__name__' && k !== 'alertstate')
      .sort()
      .map((k) => [k, l[k]]),
  );

function alertOf(l: Record<string, string>, activeSince: Map<string, number>): Alert {
  const objects: Record<string, string> = {};
  // An alert on a kube-state-metrics series with no pod or service of its own
  // carries the exporter's: that names kube-state-metrics, not what is wrong.
  for (const k of ALERT_OBJECTS) if (l[k] && !l[k]!.includes('kube-state-metrics')) objects[k] = l[k]!;
  return { name: l.alertname ?? '?', ns: l.ecom_namespace || l.namespace || '', severity: l.severity || 'none', firing: l.alertstate !== 'pending', copy: Boolean(l.ecom_namespace), objects, since: activeSince.get(alertKey(l)), copies: new Set() };
}

// A Slack copy fires next to its original, on the same object in the same
// namespace. An original aggregated past every label (PostgresDeadlocks is a
// bare sum) has no namespace and names no object, so it pairs on its name alone.
function sameObject(a: Alert, b: Alert): boolean {
  const shared = Object.keys(a.objects).filter((k) => k in b.objects);
  const bare = !Object.keys(a.objects).length || !Object.keys(b.objects).length;
  return (a.ns === b.ns || !a.ns || !b.ns) && (shared.length > 0 || bare) && shared.every((k) => a.objects[k] === b.objects[k]);
}

async function firingAlerts(tel: Telemetry, cfg: Config, at: Date, a: { namespace?: string; include_pending: boolean; max: number }): Promise<string> {
  const ns = a.namespace;
  const scoped = (sel: string) => (ns ? `${withMatcher(sel, `namespace=~${q(ns)}`)} or ${withMatcher(sel, `ecom_namespace=~${q(ns)}`)}` : sel);
  const [res, state] = await Promise.all([
    tel.promInstant(scoped(`ALERTS{alertname!~${q(ALERTS_SKIP)}}`), at),
    tel.promInstant(scoped(`ALERTS_FOR_STATE{alertname!~${q(ALERTS_SKIP)}}`), at).catch((e: Error) => e),
  ]);
  const activeSince = new Map(state instanceof Error ? [] : state.map((s) => [alertKey(s.labels), s.value]));
  const all = res.map((s) => alertOf(s.labels, activeSince));
  const shown = all.filter((x) => x.firing || a.include_pending);
  const hiddenPending = all.length - shown.length;
  const noisy = shown.filter((x) => NOISY_ALERTS.has(x.name) && (x.severity === 'info' || x.severity === 'none'));
  // A copy folds into its original (its name after "Ecom"), so one condition
  // counts once; another alert on the same object is another condition.
  const folded = new Set<Alert>();
  for (const c of shown.filter((x) => x.copy)) {
    const o = shown.find((x) => !x.copy && x.name.endsWith(c.name.replace(/^Ecom/, '')) && sameObject(c, x));
    if (o) {
      o.copies.add(c.name);
      o.ns ||= c.ns; // a namespace-less original is listed where its copy says it fires
      folded.add(c);
    }
  }
  const rest = shown.filter((x) => !folded.has(x) && !noisy.includes(x));
  const watched = new RegExp(`^(?:${cfg.sources.workloads.namespaces})$`);
  const listed = ns ? rest : rest.filter((x) => watched.test(x.ns));
  const others = ns ? [] : rest.filter((x) => !watched.test(x.ns));

  const groups = new Map<string, Alert[]>();
  for (const x of listed) {
    const k = [x.name, x.ns, x.severity, x.firing, x.copy].join('\u0000');
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const rank = (x: Alert) => [watched.test(x.ns) ? 0 : 1, SEVERITY_RANK[x.severity] ?? 5, x.firing ? 0 : 1];
  const ordered = [...groups.values()].sort((g, h) => {
    const [r, s] = [rank(g[0]!), rank(h[0]!)];
    return r[0]! - s[0]! || r[1]! - s[1]! || r[2]! - s[2]! || h.length - g.length || g[0]!.name.localeCompare(h[0]!.name);
  });

  const what = a.include_pending ? 'firing or pending' : 'firing';
  const where = ns ? 'in this scope' : 'in the watched namespaces';
  const out = [
    `alerts at ${at.toISOString()} (Prometheus ALERTS; left out: Watchdog, InfoInhibitor, AgentEngine*, *RouteTest).`,
    "Context, not proof of cause: an alert says its rule's condition holds, not why. Confirm with the other tools before citing one as the cause.",
    ns ? `scope: namespace or ecom_namespace =~ ${q(ns)}` : `scope: the watched namespaces (${cfg.sources.workloads.namespaces}) listed; others as counts (pass namespace to list them)`,
  ];
  if (state instanceof Error) out.push(`active-since times not available (ALERTS_FOR_STATE: ${state.message})`);
  out.push(listed.length ? `${listed.length} ${what} ${where}, in ${ordered.length} groups:` : `none ${what} ${where} (the query succeeded${all.length ? '; what it returned is counted below' : ' and returned none'})`);
  let budget = a.max;
  for (const g of ordered) {
    const x = g[0]!;
    const first = Math.min(...g.map((y) => y.since ?? Infinity));
    const copies = [...new Set(g.flatMap((y) => [...y.copies]))];
    const objs = g.map((y) => Object.entries(y.objects).map(([k, v]) => `${k}=${v}`).join(' ')).filter(Boolean);
    const take = objs.slice(0, Math.max(0, budget));
    budget -= take.length;
    out.push(
      `- ${x.name} [${x.severity}] ${x.ns || '(no namespace)'}${x.copy ? ' (Slack copy; no original fires on the same object)' : ''}: ${g.length} ${x.firing ? 'firing' : 'pending'}` +
        (Number.isFinite(first) ? `, active since ${minute(first)} (${since(first, at)})` : '') +
        (copies.length ? `, also sent to Slack as ${copies.join(', ')}` : '') +
        (take.length ? `: ${take.join('; ')}` : '') +
        (objs.length > take.length ? ` (+${objs.length - take.length} more)` : ''),
    );
  }
  const counts = (xs: Alert[], by: (x: Alert) => string) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(by(x), (m.get(by(x)) ?? 0) + 1);
    return [...m].sort((p, r) => r[1] - p[1]);
  };
  if (noisy.length)
    out.push(
      `known-noisy info alerts (firing most of the week), counted only: ${counts(noisy, (x) => x.name)
        .map(([name, n]) => `${name} ${n} (${counts(noisy.filter((x) => x.name === name), (x) => x.ns || '(no namespace)').map(([w, k]) => `${w} ${k}`).join(', ')})`)
        .join('; ')}`,
    );
  if (others.length)
    out.push(
      `other namespaces (not watched; pass namespace to list them): ${counts(others, (x) => x.ns || '(no namespace)')
        .map(([w, n]) => {
          const here = others.filter((x) => (x.ns || '(no namespace)') === w);
          const sev = counts(here, (x) => x.severity).map(([s, k]) => `${s} ${k}`).join(', ');
          const names = counts(here, (x) => x.name).slice(0, 5).map(([name]) => name).join(', ');
          return `${w} ${n} (${sev}: ${names})`;
        })
        .join('; ')}`,
    );
  if (hiddenPending) out.push(`pending, not shown: ${hiddenPending} (include_pending: true lists them)`);
  return out.join('\n');
}

// ---- pod_status --------------------------------------------------------------------
const PODS_LISTED_MAX = 30; // evidence is cut at 9,000 chars
const literal = (s: string) => s.replace(/[\\.+*?()|[\]{}^$]/g, '\\$&'); // RE2 metacharacters

interface Pod {
  ns: string;
  name: string;
  workload: string;
  ready: boolean;
  phase: string;
  waiting: string[];
  terminated: string[];
  r1: number;
  r6: number;
  start?: number;
}

// -2 completed, -1 healthy, 0.. needs attention (lower first).
const podRank = (p: Pod) => (p.phase === 'Succeeded' ? -2 : p.phase === 'Failed' ? 4 : !p.ready ? 0 : p.waiting.length ? 1 : p.r1 > 0 ? 2 : p.r6 > 0 ? 3 : -1);

async function podStatus(tel: Telemetry, at: Date, namespace: string, workload: string | undefined): Promise<string> {
  const ns = `namespace=~${q(namespace)}`;
  const sel = workload ? `${ns},pod=~${q(`${literal(workload)}.*`)}` : ns;
  // Waiting and terminated series exist only while a container is in that
  // state, so their absence reads as "none" only once kube-state-metrics is
  // known to be read here.
  // One series per pod and condition (true, false, unknown): count one condition.
  const present = await requireSeries(tel, `kube_pod_status_ready{${ns},condition="true"}`, at, 'kube-state-metrics').catch((e: Error) => {
    if (!e.message.startsWith('no kube-state-metrics series')) throw e;
    throw new Error(`kube-state-metrics missing (not a quiet system): no kube_pod_status_ready series for ${ns} at ${at.toISOString()}. kube-state-metrics is not being read, or no namespace matches; this says nothing about whether pods are ready.`);
  });
  const [ready, phase, waiting, terminated, r1, r6, starts] = await Promise.all([
    tel.promInstant(`kube_pod_status_ready{${sel},condition="true"}`, at),
    tel.promInstant(`kube_pod_status_phase{${sel}} == 1`, at),
    tel.promInstant(`kube_pod_container_status_waiting_reason{${sel}} > 0`, at),
    tel.promInstant(`kube_pod_container_status_last_terminated_reason{${sel}} > 0`, at),
    tel.promInstant(`sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{${sel}}[1h]))`, at),
    tel.promInstant(`sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{${sel}}[6h]))`, at),
    tel.promInstant(`kube_pod_start_time{${sel}}`, at),
  ]);
  const key = (l: Record<string, string>) => `${l.namespace}/${l.pod}`;
  const pods = new Map<string, Pod>();
  for (const s of ready) pods.set(key(s.labels), { ns: s.labels.namespace ?? '?', name: s.labels.pod ?? '?', workload: workloadOf(s.labels.pod ?? '?'), ready: s.value === 1, phase: '?', waiting: [], terminated: [], r1: 0, r6: 0 });
  const each = (xs: Sample[], f: (p: Pod, s: Sample) => void) => {
    for (const s of xs) {
      const p = pods.get(key(s.labels));
      if (p && Number.isFinite(s.value)) f(p, s);
    }
  };
  each(phase, (p, s) => (p.phase = s.labels.phase ?? '?'));
  each(waiting, (p, s) => p.waiting.push(`${s.labels.container ?? '?'}=${s.labels.reason ?? '?'}`));
  each(terminated, (p, s) => p.terminated.push(`${s.labels.container ?? '?'}=${s.labels.reason ?? '?'}`));
  each(r1, (p, s) => (p.r1 += Math.round(s.value)));
  each(r6, (p, s) => (p.r6 += Math.round(s.value)));
  each(starts, (p, s) => (p.start = s.value));
  if (!pods.size) return `No pods match ${sel} at ${at.toISOString()} (kube-state-metrics reports ${present} pods for ${ns}).`;

  const all = [...pods.values()];
  const wl = (p: Pod) => `${p.ns}/${p.workload}`;
  const workloads = new Set(all.map(wl));
  const attention = all.filter((p) => podRank(p) >= 0).sort((a, b) => podRank(a) - podRank(b) || b.r6 - a.r6 || a.name.localeCompare(b.name));
  const healthy = all.filter((p) => podRank(p) === -1);
  const completed = all.filter((p) => podRank(p) === -2).length;
  const out = [
    `pods at ${at.toISOString()} in ${ns}${workload ? ` with names starting ${q(workload)}` : ''}: ${all.length} pods in ${workloads.size} workloads, ${all.filter((p) => p.ready).length} ready.`,
    'Readiness flips during a rollout are normal (new pods start not ready while old ones stop): check recent_changes before calling a not-ready pod a problem.',
  ];
  if (!attention.length) out.push('needing attention: none (every pod is ready, nothing is waiting, no restarts in the last 6 h)');
  else {
    out.push(`needing attention (not ready, waiting, restarted in the last 6 h, or failed): ${attention.length} pods. "last terminated" is a container's most recent exit, which may be old.`);
    let listed = 0;
    for (const w of [...new Set(attention.map(wl))]) {
      if (listed >= PODS_LISTED_MAX) break;
      const mine = attention.filter((x) => wl(x) === w);
      // Out of the pods that are meant to be up: completed and failed (evicted) ones are not.
      const live = all.filter((p) => wl(p) === w && p.phase !== 'Succeeded' && p.phase !== 'Failed');
      out.push(`${mine[0]!.workload} [${mine[0]!.ns}]: ${live.filter((p) => p.ready).length} of ${live.length} ready`);
      for (const p of mine) {
        if (listed++ >= PODS_LISTED_MAX) break;
        const bits = [p.ready ? 'ready' : 'NOT READY', p.phase];
        if (p.waiting.length) bits.push(`waiting ${p.waiting.join(' ')}`);
        if (p.r1 || p.r6) bits.push(`restarts ${p.r1} in 1 h / ${p.r6} in 6 h`);
        if (p.terminated.length) bits.push(`last terminated ${p.terminated.join(' ')}`);
        if (p.start) bits.push(`started ${new Date(p.start * 1000).toISOString().replace('.000Z', 'Z')}`);
        out.push(`  ${p.name}: ${bits.join(', ')}`);
      }
    }
    if (attention.length > PODS_LISTED_MAX) out.push(`+${attention.length - PODS_LISTED_MAX} more pods needing attention not listed: narrow with workload`);
  }
  out.push(`healthy: ${healthy.length} pods ready and Running, nothing waiting, no restarts in 6 h (${new Set(healthy.map(wl)).size} workloads)${completed ? `; completed (Succeeded): ${completed}` : ''}`);
  return out.join('\n');
}

// Read-only telemetry tools, anchored at `at` (the patrol time) so a replay of
// 29 Sep investigates 29 Sep, not today. Every result is redacted, fenced and
// stamped with an evidence id from the run's shared registry.
export function monitorTools(tel: Telemetry, cfg: Config, at: Date): ToolFactory {
  return (evidence: Evidence, by: string) => buildTools(tel, cfg, at, evidence, by);
}

function buildTools(tel: Telemetry, cfg: Config, at: Date, evidence: Evidence, by: string): SdkMcpToolDefinition<any>[] {
  const ok = (toolName: string, args: unknown, body: string) => ({ content: [{ type: 'text' as const, text: evidence.stamp(evidence.add(by, toolName, args, body)) }] });
  // Error text can carry upstream bodies or URLs: redact and fence it like any result.
  const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: `error:\n${fence('error', redact(msg).slice(0, 500))}` }], isError: true });
  const guard =
    <A>(name: string, fn: (a: A) => Promise<string>) =>
    async (a: A) => {
      try {
        return ok(name, a, await fn(a));
      } catch (e) {
        return fail((e as Error).message);
      }
    };

  const tools = [
    tool(
      'service_overview',
      'Every route × status for one service over the last N minutes, compared with the same window 1 day and 7 days earlier. Start here.',
      { service: z.string().min(1), minutes: z.number().int().min(5).max(360).default(60) },
      guard('service_overview', async ({ service, minutes }) => {
        const fams = familiesFor(cfg, service);
        if (!fams.length) return `No HTTP metric family knows service "${service}". Known fixed services: ${cfg.sources.http_families.map((f) => f.service).filter(Boolean).join(', ')}; V3 services are matched by label.`;
        const lines: string[] = [];
        for (const { f, sel } of fams) {
          const by = [f.route_label, f.status_label].filter(Boolean).join(', ');
          const query = `sum by (${by}) (increase(${sel}[${minutes}m]))`;
          const [now, d1, d7] = await Promise.all([0, 24 * H, 7 * 24 * H].map((o) => tel.promInstant(query, new Date(at.getTime() - o))));
          const key = (l: Record<string, string>) => `${f.route_label ? (l[f.route_label] ?? '?') : '*'} ${l[f.status_label] ?? '?'}`;
          const m = new Map<string, [number, number, number]>();
          [now, d1, d7].forEach((res, i) => {
            for (const s of res ?? []) {
              const v = m.get(key(s.labels)) ?? [0, 0, 0];
              v[i as 0 | 1 | 2] += s.value;
              m.set(key(s.labels), v);
            }
          });
          lines.push(`family ${f.id}: ${query}`, 'route status | now | 1d ago | 7d ago');
          [...m.entries()]
            .sort((a, b) => b[1][0] - a[1][0])
            .slice(0, 60)
            .forEach(([k, [a, b, c]]) => lines.push(`${k} | ${Math.round(a)} | ${Math.round(b)} | ${Math.round(c)}`));
        }
        return lines.join('\n');
      }),
    ),
    tool(
      'route_timeline',
      'Per-status request counts for one route of one service, in 10-minute buckets over the last N hours. Use it to find when a problem started and whether it is still going.',
      { service: z.string(), route: z.string().describe('Exact route label value, e.g. "/v1/auth/password/reset"'), hours: z.number().int().min(1).max(24).default(6) },
      guard('route_timeline', async ({ service, route, hours }) => {
        const out: string[] = [];
        for (const { f, sel } of familiesFor(cfg, service)) {
          const s2 = f.route_label ? withMatcher(sel, `${f.route_label}=${q(route)}`) : sel;
          const query = `sum by (${f.status_label}) (increase(${s2}[10m]))`;
          const series = await tel.promRange(query, new Date(at.getTime() - hours * H), at, 600);
          if (!series.length) continue;
          out.push(`family ${f.id}: ${query}`);
          for (const s of series) out.push(`status ${s.labels[f.status_label] ?? '?'}: ${s.points.map(([t, v]) => `${hhmm(t)}=${Math.round(v)}`).join(' ')}`);
        }
        return out.length ? out.join('\n') : `No series for ${service} ${route} in the last ${hours} h.`;
      }),
    ),
    tool(
      'log_search',
      'Search logs (Loki), grouped into templates with counts, how many distinct users, customers, orders, VINs, clients or IPs each template mentions (counts only), and two redacted samples each. Narrow with service and contains.',
      {
        service: z.string().optional(),
        contains: z.string().max(200).optional().describe('Literal substring filter'),
        errors_only: z.boolean().default(true),
        minutes: z.number().int().min(1).max(360).default(30),
        end_minutes_ago: z.number().int().min(0).max(7 * 24 * 60).default(0).describe('Shift the window back from the patrol time'),
        limit: z.number().int().min(10).max(1000).default(300),
      },
      guard('log_search', async ({ service, contains, errors_only, minutes, end_minutes_ago, limit }) => {
        if (!tel.has.loki) throw new Error('Loki is not configured in this run');
        const L = cfg.sources.logs;
        let sel = service ? withMatcher(L.selector, `${L.service_label}=${q(service)}`) : L.selector;
        if (errors_only) sel += ` ${L.error_filter}`;
        if (contains) sel += ` |= ${q(contains)}`;
        const end = new Date(at.getTime() - end_minutes_ago * 60_000);
        const lines = await tel.lokiRange(sel, new Date(end.getTime() - minutes * 60_000), end, limit);
        // Reach: the distinct identities each template mentions, counted before
        // the samples are cut and redacted. Only the counts are shown.
        const groups = new Map<string, { n: number; first: string; last: string; samples: string[]; ids: Map<string, Set<string>> }>();
        for (const l of lines) {
          const svc = l.labels[L.service_label] ?? '?';
          const k = `${svc} ${templateOf(l.line)}`;
          const ts = new Date(Number(BigInt(l.tsNs) / 1_000_000n)).toISOString();
          const g = groups.get(k) ?? { n: 0, first: ts, last: ts, samples: [], ids: new Map<string, Set<string>>() };
          g.n++;
          if (ts < g.first) g.first = ts;
          if (ts > g.last) g.last = ts;
          if (g.samples.length < 2) g.samples.push(truncate(l.line, 500));
          for (const id of identitiesOf(l.line)) {
            const kind = id.slice(0, id.indexOf('='));
            const seen = g.ids.get(kind) ?? new Set<string>();
            if (seen.size < 1000) seen.add(id);
            g.ids.set(kind, seen);
          }
          groups.set(k, g);
        }
        const hit = lines.length >= limit;
        const out = [`query: ${sel}`, `window: ${minutes} min ending ${end.toISOString()}; ${lines.length} lines${hit ? ' (limit hit: counts are lower bounds)' : ''}`];
        if (hit) out.push(...(await limitCut(tel, sel, lines, end, minutes, !service && !contains && !errors_only)));
        for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25)) {
          const ids = [...g.ids.entries()].sort((a, b) => b[1].size - a[1].size).map(([kind, v]) => `${v.size}${v.size >= 1000 ? '+' : ''} ${kind}`);
          out.push('', `${g.n}× ${k}`, `   first ${g.first} last ${g.last}`, ...(ids.length ? [`   distinct: ${ids.join(', ')}`] : []), ...g.samples.map((s) => `   sample: ${s}`));
        }
        return out.join('\n');
      }),
    ),
    tool(
      'workload_state',
      'Kubernetes state for one workload (deployment name prefix): replicas, restarts in the last 6 h, last termination reasons, waiting reasons, running images, pod start times.',
      { workload: z.string().min(2) },
      guard('workload_state', async ({ workload }) => {
        const pod = `pod=~${q(`${workload}-.*`)}`;
        const ns = `namespace=~${q(cfg.sources.workloads.namespaces)}`;
        const [replicas, avail, restarts, term, waiting, images, starts] = await Promise.all([
          tel.promInstant(`kube_deployment_spec_replicas{${ns},deployment=${q(workload)}}`, at),
          tel.promInstant(`kube_deployment_status_replicas_available{${ns},deployment=${q(workload)}}`, at),
          tel.promInstant(`increase(kube_pod_container_status_restarts_total{${ns},${pod}}[6h])`, at),
          tel.promInstant(`kube_pod_container_status_last_terminated_reason{${ns},${pod}}`, at),
          tel.promInstant(`kube_pod_container_status_waiting_reason{${ns},${pod}} > 0`, at),
          // image_spec, not image: for a digest-pinned image, image is a bare sha256.
          tel.promInstant(`count by (image_spec) (kube_pod_container_info{${ns},${pod}})`, at),
          tel.promInstant(`kube_pod_start_time{${ns},${pod}}`, at),
        ]);
        const out = [
          `replicas desired ${replicas.map((s) => s.value).join(',') || '?'}, available ${avail.map((s) => s.value).join(',') || '?'}`,
          'restarts (6 h): ' + (restarts.filter((s) => s.value > 0).map((s) => `${s.labels.pod}/${s.labels.container}=${Math.round(s.value)}`).join(', ') || 'none'),
          'last terminated: ' + (term.map((s) => `${s.labels.pod}/${s.labels.container}: ${s.labels.reason}`).join(', ') || 'none'),
          'waiting: ' + (waiting.map((s) => `${s.labels.pod}/${s.labels.container}: ${s.labels.reason}`).join(', ') || 'none'),
          'images: ' + (images.map((s) => `${s.labels.image_spec} ×${s.value}`).join(', ') || 'none'),
          'pod starts: ' + (starts.map((s) => `${s.labels.pod} ${new Date(s.value * 1000).toISOString()}`).join(', ') || 'none'),
        ];
        return out.join('\n');
      }),
    ),
    tool(
      'pod_status',
      'Pod readiness across a namespace (kube-state-metrics): not-ready, waiting, recently restarted and failed pods first, by workload, with phase, waiting and last termination reasons, restarts in 1 h and 6 h, start time; healthy pods as one count. Readiness flips during a rollout are normal: see recent_changes.',
      {
        namespace: z.string().min(1).max(200).optional().describe('Namespace, exact or regex (default: the watched namespaces)'),
        workload: z.string().min(2).max(200).optional().describe('Pod name prefix: a Deployment or StatefulSet name, e.g. "ecom-service-production"'),
      },
      guard('pod_status', async ({ namespace, workload }) => podStatus(tel, at, namespace ?? cfg.sources.workloads.namespaces, workload)),
    ),
    tool(
      'recent_changes',
      'Deploys in the last N hours: new ReplicaSets (scaling is not a deploy), with time, image old → new and rollout state (complete in N min, rolling, stalled, rolled back). Also StatefulSets rolling now, and Argo CD syncs when scraped.',
      { hours: z.number().int().min(1).max(72).default(24) },
      guard('recent_changes', async ({ hours }) => {
        const d = await listDeploys(tel, cfg.sources, at, hours);
        return [`${deploysHeading(d)}:`, ...deployLines(d)].join('\n');
      }),
    ),
    tool(
      'firing_alerts',
      'Prometheus alerts firing at the patrol time, grouped by alert, namespace and severity, with the objects they name and how long they have been active; watched namespaces listed, others counted. Context, not proof of cause: an alert says a condition holds, not why. Routing tests and always-on alerts left out; known-noisy info alerts counted.',
      {
        namespace: z.string().min(1).max(200).optional().describe('Namespace, exact or regex; lists every alert there'),
        include_pending: z.boolean().default(false),
        max: z.number().int().min(1).max(200).default(40).describe('Most alerts listed with their objects; the rest are counted'),
      },
      guard('firing_alerts', async (a) => firingAlerts(tel, cfg, at, a)),
    ),
    tool(
      'promql',
      'Bounded raw PromQL, for what the other tools do not cover. Instant query at the patrol time, or a range if minutes is set. At most 40 series returned.',
      { query: z.string().min(3).max(1500), minutes: z.number().int().min(5).max(24 * 60).optional() },
      guard('promql', async ({ query, minutes }) => {
        const big = [...query.matchAll(/\[(\d+)([smhdwy])/g)].some(([, n, u]) => Number(n) * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 } as const)[u as 's'] > 7 * 86400);
        if (big) throw new Error('range selectors longer than 7d are not allowed');
        if (minutes) {
          const step = Math.max(60, Math.ceil((minutes * 60) / 120));
          const res = await tel.promRange(query, new Date(at.getTime() - minutes * 60_000), at, step);
          return [`${res.length} series, step ${step}s`, ...res.slice(0, 40).map((s) => `${JSON.stringify(s.labels)}: ${s.points.map(([t, v]) => `${hhmm(t)}=${+v.toFixed(3)}`).join(' ')}`)].join('\n');
        }
        const res = await tel.promInstant(query, at);
        return [`${res.length} series`, ...res.slice(0, 40).map((s) => `${JSON.stringify(s.labels)} = ${+s.value.toFixed(4)}`)].join('\n');
      }),
    ),
    tool(
      'trace_search',
      `Search traces (Tempo, TraceQL) in the last N minutes (at most ${TEMPO_MAX_MINUTES}: Tempo is shared); returns root service, operation, duration and trace ids. Match exact values (=, !=); regex matches (=~, !~) are refused.`,
      { traceql: z.string().max(500).default('{ status = error }'), minutes: z.number().int().min(5).max(TEMPO_MAX_MINUTES).default(15), limit: z.number().int().min(1).max(200).default(50) },
      guard('trace_search', async ({ traceql, minutes, limit }) => {
        if (!tel.has.tempo) throw new Error('Tempo is not configured in this run');
        const hits = await tel.tempoSearch(traceql, new Date(at.getTime() - minutes * 60_000), at, limit);
        const cut = hits.length >= limit ? [`limit hit: Tempo stopped at ${limit} traces and there are more in the window. This is a sample: counts are lower bounds, and the earliest trace listed is not when the problem started. Narrow the query or the window to see more.`] : [];
        return [`${hits.length} traces for ${traceql}`, ...cut, ...hits.map((h) => `${new Date(h.startSec * 1000).toISOString()} ${h.rootService} ${h.rootName} ${h.durationMs}ms trace=${h.traceId}`)].join('\n');
      }),
    ),
  ];
  return tools;
}
