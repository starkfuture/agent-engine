import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import type { LogLine, Sample, Series, Telemetry, TraceHit } from '../src/clients/telemetry.js';

// Answers promInstant by (query substring, time) so tests can describe the
// world as "this query at this moment returns these samples"; promRange the same
// way, when a test gives it an answer.
export class FakeTelemetry implements Telemetry {
  readonly has = { loki: false, tempo: false };
  readonly calls: string[] = [];
  constructor(
    private readonly answer: (query: string, at: Date) => Sample[],
    private readonly range: (query: string, start: Date, end: Date, stepSec: number) => Series[] = () => [],
  ) {}
  async promInstant(query: string, at: Date): Promise<Sample[]> {
    this.calls.push(query);
    return this.answer(query, at);
  }
  async promRange(query: string, start: Date, end: Date, stepSec: number): Promise<Series[]> {
    this.calls.push(query);
    return this.range(query, start, end, stepSec);
  }
  async lokiRange(): Promise<LogLine[]> {
    return [];
  }
  async tempoSearch(): Promise<TraceHit[]> {
    return [];
  }
}

export const H = 3600_000;
export const DAY = 24 * H;

// The 29 Sep shape: password reset and sign-up start returning 400 at 12:00Z.
// Everything else is normal traffic with a steady trickle of 404s.
export const INCIDENT_START = Date.parse('2026-09-29T12:00:00Z');
export function world(query: string, at: Date): Sample[] {
  // kube-state-metrics is being scraped: the workloads and rollouts presence checks find series.
  if (query.startsWith('count(kube_')) return [{ labels: {}, value: 120 }];
  if (!query.includes('backend_be_production_http_requests_total')) return [];
  const t = at.getTime();
  const broken = t >= INCIDENT_START && t < INCIDENT_START + 30 * H;
  const cell = (route: string, status: string, value: number): Sample => ({ labels: { route, status_code: status }, value });
  return [
    cell('/v1/auth/password/reset', '200', broken ? 20 : 90),
    cell('/v1/auth/password/reset', '400', broken ? 75 : 2),
    cell('/v1/auth/signup', '201', broken ? 10 : 60),
    cell('/v1/auth/signup', '400', broken ? 55 : 3),
    cell('/v1/products', '200', 5000),
    cell('/v1/products', '404', 40),
  ];
}

// A patrol config over the legacy /v1 family only, with fresh temp folders.
export const testConfig = (): Config => ({
  grafanaUrl: 'http://grafana.test',
  grafanaTokenFile: '/dev/null',
  promUid: 'prometheus',
  lokiUid: undefined,
  tempoUid: undefined,
  windowMinutes: 15,
  attentionFloor: 10,
  sources: {
    http_families: [
      { id: 'legacy-v1', selector: 'backend_be_production_http_requests_total', service: 'backend-production', route_label: 'route', status_label: 'status_code' },
    ],
    error_counters: [],
    workloads: { namespaces: 'microservices' },
    deploys: { aliases: { keycloak: 'keycloak-production' }, stall_minutes: 10, argocd: false },
    logs: { selector: '{namespace="microservices"}', error_filter: '', service_label: 'app', max_lines: 100 },
    traces: { traceql: '{ status = error }', limit: 10 },
  },
  noiseFile: '/dev/null',
  ownersFile: '/dev/null',
  stateFile: join(mkdtempSync(join(tmpdir(), 'sre-test-')), 'state.json'),
  outDir: mkdtempSync(join(tmpdir(), 'sre-out-')),
  llm: { available: false, dailyCapUsd: 10, monthlyCapUsd: 100, monitorMonthlyCapUsd: 80 },
  agentsDir: join(import.meta.dirname, '..', 'agents'),
  runsDir: mkdtempSync(join(tmpdir(), 'sre-runs-')),
  slackWebhookUrl: undefined,
  slackBotToken: undefined,
  slackChannel: undefined,
  slackOncall: undefined,
  direct: undefined,
  memoryDir: undefined,
  build: undefined,
  retentionDays: 30,
  mcp: { usersFile: '/nonexistent', reposFile: '/nonexistent', userDailyCapUsd: 10, userMaxRunning: 2, notifySlack: false, allowedOrigins: [], agents: undefined, login: undefined, reposDir: undefined, reposGithub: undefined, githubApp: undefined },
});

// ---- a cluster with rollouts (kube-state-metrics as the deploy queries read it) ----
export const ECR = '952414816681.dkr.ecr.eu-west-1.amazonaws.com';
export const MIN = 60_000;
export interface Rollout {
  workload: string; // the Deployment (== container)
  rs: string; // the new ReplicaSet
  created: number; // ms
  image: string; // image_spec on the new ReplicaSet
  prevRs: string;
  prev: string;
  done?: number; // every replica updated and available from then; unset = never
  back?: number; // rolled back: the previous ReplicaSet's pods again from then
  oneReplica?: boolean; // its new pod counts as updated: only the controller's deadline shows the stall
  updated?: number; // every pod on the new template from then, before they are all available
  brandNew?: boolean; // a new Deployment: no series before `created`
}

// Rolling = created and not done. Stalled = replicas behind (rolling, before
// `updated`) for 10+ min. `base` answers everything else (by default the 29 Sep
// world, quiet on other days). What is left to do counts old replicas only when
// the query asks for kube_deployment_status_replicas: a one-replica rollout is
// otherwise 0 (updated 1, available 1) from its start. min_over_time over a
// brand-new Deployment's first minutes fires unless the query counts samples.
export function cluster(rollouts: Rollout[], base: (q: string, at: Date) => Sample[] = world): FakeTelemetry {
  const rolling = (r: Rollout, t: number) => t >= r.created && (r.done === undefined || t < r.done);
  const left = (q: string, r: Rollout, t: number) => (!rolling(r, t) ? 0 : !r.oneReplica ? 2 : q.includes('kube_deployment_status_replicas{') ? 1 : 0);
  const behind = (q: string, r: Rollout, t: number) => rolling(r, t) && !r.oneReplica && (r.updated === undefined || t < r.updated) && (t - r.created >= 10 * MIN || (!!r.brandNew && !q.includes('count_over_time(')));
  return new FakeTelemetry(
    (q, at) => {
      const t = at.getTime();
      const ns = { namespace: 'microservices' };
      if (q.startsWith('count(')) return base(q, at); // presence checks
      if (q.includes('kube_replicaset_created')) {
        const window = Number(/time\(\) - (\d+)/.exec(q)![1]) * 1000;
        const owner = /owner_name="([^"]+)"/.exec(q)?.[1];
        return rollouts.filter((r) => r.created <= t && r.created > t - window && (!owner || owner === r.workload)).map((r) => ({ labels: { ...ns, owner_name: r.workload, replicaset: r.rs }, value: r.created / 1000 }));
      }
      if (q.includes('kube_pod_container_info') && q.includes('kube_pod_owner'))
        return rollouts.flatMap((r) => {
          const pods = (rs: string, image: string) => ({ labels: { ...ns, owner_name: rs, container: r.workload, image_spec: image }, value: 2 });
          if (t < r.created || (r.back !== undefined && t >= r.back)) return [pods(r.prevRs, r.prev)];
          return rolling(r, t) ? [pods(r.prevRs, r.prev), pods(r.rs, r.image)] : [pods(r.rs, r.image)];
        });
      if (q.includes('min_over_time((kube_deployment_spec_replicas'))
        return rollouts.flatMap((r) => {
          if (behind(q, r, t)) return [{ labels: { ...ns, deployment: r.workload }, value: 2 }];
          return r.oneReplica && rolling(r, t) && t - r.created >= 10 * MIN ? [{ labels: { ...ns, deployment: r.workload, reason: 'ProgressDeadlineExceeded' }, value: 1 }] : [];
        });
      if (q.includes('clamp_min(kube_deployment_spec_replicas'))
        return rollouts.filter((r) => left(q, r, t) > 0).map((r) => ({ labels: { ...ns, deployment: r.workload }, value: left(q, r, t) }));
      return base(q, at);
    },
    (q, start, end, step) =>
      q.includes('clamp_min(kube_deployment_spec_replicas')
        ? rollouts.map((r) => {
            const points: Array<[number, number]> = [];
            for (let t = start.getTime(); t <= end.getTime(); t += step * 1000) points.push([t / 1000, r.back !== undefined && t >= r.back && t < r.back + 2 * MIN ? 2 : left(q, r, t)]);
            return { labels: { namespace: 'microservices', deployment: r.workload }, points };
          })
        : [],
  );
}
