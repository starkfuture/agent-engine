import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Config, HttpFamily } from '../config.js';
import type { Telemetry } from '../clients/telemetry.js';
import type { Evidence } from '../engine/evidence.js';
import type { ToolFactory } from '../engine/run.js';
import { workloadOf } from '../patrol/collectors.js';
import { fence, redact, templateOf, truncate } from '../engine/text.js';

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
      'Search logs (Loki), grouped into templates with counts and two redacted samples each. Narrow with service and contains.',
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
        const groups = new Map<string, { n: number; first: string; last: string; samples: string[] }>();
        for (const l of lines) {
          const svc = l.labels[L.service_label] ?? '?';
          const k = `${svc} ${templateOf(l.line)}`;
          const ts = new Date(Number(BigInt(l.tsNs) / 1_000_000n)).toISOString();
          const g = groups.get(k) ?? { n: 0, first: ts, last: ts, samples: [] };
          g.n++;
          if (ts < g.first) g.first = ts;
          if (ts > g.last) g.last = ts;
          if (g.samples.length < 2) g.samples.push(truncate(l.line, 500));
          groups.set(k, g);
        }
        const out = [`query: ${sel}`, `window: ${minutes} min ending ${end.toISOString()}; ${lines.length} lines${lines.length >= limit ? ' (limit hit: counts are lower bounds)' : ''}`];
        for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25))
          out.push('', `${g.n}× ${k}`, `   first ${g.first} last ${g.last}`, ...g.samples.map((s) => `   sample: ${s}`));
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
          tel.promInstant(`count by (image) (kube_pod_container_info{${ns},${pod}})`, at),
          tel.promInstant(`kube_pod_start_time{${ns},${pod}}`, at),
        ]);
        const out = [
          `replicas desired ${replicas.map((s) => s.value).join(',') || '?'}, available ${avail.map((s) => s.value).join(',') || '?'}`,
          'restarts (6 h): ' + (restarts.filter((s) => s.value > 0).map((s) => `${s.labels.pod}/${s.labels.container}=${Math.round(s.value)}`).join(', ') || 'none'),
          'last terminated: ' + (term.map((s) => `${s.labels.pod}/${s.labels.container}: ${s.labels.reason}`).join(', ') || 'none'),
          'waiting: ' + (waiting.map((s) => `${s.labels.pod}/${s.labels.container}: ${s.labels.reason}`).join(', ') || 'none'),
          'images: ' + (images.map((s) => `${s.labels.image} ×${s.value}`).join(', ') || 'none'),
          'pod starts: ' + (starts.map((s) => `${s.labels.pod} ${new Date(s.value * 1000).toISOString()}`).join(', ') || 'none'),
        ];
        return out.join('\n');
      }),
    ),
    tool(
      'recent_changes',
      'Deployments whose spec changed (rollouts, config changes, restarts) in the last N hours, with times, plus the images they run now.',
      { hours: z.number().int().min(1).max(72).default(24) },
      guard('recent_changes', async ({ hours }) => {
        const ns = `namespace=~${q(cfg.sources.workloads.namespaces)}`;
        const step = 300;
        const series = await tel.promRange(`max by (namespace, deployment) (kube_deployment_status_observed_generation{${ns}})`, new Date(at.getTime() - hours * H), at, step);
        const events: string[] = [];
        for (const s of series)
          for (let i = 1; i < s.points.length; i++)
            if (s.points[i]![1] !== s.points[i - 1]![1]) events.push(`${hhmm(s.points[i]![0])}Z ${s.labels.namespace}/${s.labels.deployment} generation ${s.points[i - 1]![1]}→${s.points[i]![1]}`);
        events.sort();
        const imgs = await tel.promInstant(`count by (namespace, pod, image) (kube_pod_container_info{${ns}})`, at);
        const byWorkload = new Map<string, Set<string>>();
        for (const s of imgs) {
          const k = `${s.labels.namespace}/${workloadOf(s.labels.pod ?? '?')}`;
          const set = byWorkload.get(k) ?? new Set();
          set.add(s.labels.image ?? '?');
          byWorkload.set(k, set);
        }
        const changed = new Set(events.map((e) => e.split(' ')[1]));
        return [
          `spec changes in the last ${hours} h (5-min resolution):`,
          ...(events.length ? events : ['none']),
          '',
          'current images of the changed workloads:',
          ...[...byWorkload.entries()].filter(([k]) => changed.has(k)).map(([k, v]) => `${k}: ${[...v].join(', ')}`),
        ].join('\n');
      }),
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
      'Search traces (Tempo, TraceQL) in the last N minutes; returns root service, operation, duration and trace ids.',
      { traceql: z.string().max(500).default('{ status = error }'), minutes: z.number().int().min(5).max(360).default(30), limit: z.number().int().min(1).max(200).default(50) },
      guard('trace_search', async ({ traceql, minutes, limit }) => {
        if (!tel.has.tempo) throw new Error('Tempo is not configured in this run');
        const hits = await tel.tempoSearch(traceql, new Date(at.getTime() - minutes * 60_000), at, limit);
        return [`${hits.length} traces for ${traceql}`, ...hits.map((h) => `${new Date(h.startSec * 1000).toISOString()} ${h.rootService} ${h.rootName} ${h.durationMs}ms trace=${h.traceId}`)].join('\n');
      }),
    ),
  ];
  return tools;
}
