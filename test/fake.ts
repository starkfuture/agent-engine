import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import type { LogLine, Sample, Series, Telemetry, TraceHit } from '../src/clients/telemetry.js';

// Answers promInstant by (query substring, time) so tests can describe the
// world as "this query at this moment returns these samples".
export class FakeTelemetry implements Telemetry {
  readonly has = { loki: false, tempo: false };
  readonly calls: string[] = [];
  constructor(private readonly answer: (query: string, at: Date) => Sample[]) {}
  async promInstant(query: string, at: Date): Promise<Sample[]> {
    this.calls.push(query);
    return this.answer(query, at);
  }
  async promRange(): Promise<Series[]> {
    return [];
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
  // kube-state-metrics is being scraped: the workloads presence check finds series.
  if (query.startsWith('count(kube_pod_container_status_restarts_total')) return [{ labels: {}, value: 120 }];
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
    logs: { selector: '{namespace="microservices"}', error_filter: '', service_label: 'app', max_lines: 100 },
    traces: { traceql: '{ status = error }', limit: 10 },
  },
  noiseFile: '/dev/null',
  ownersFile: '/dev/null',
  stateFile: join(mkdtempSync(join(tmpdir(), 'sre-test-')), 'state.json'),
  outDir: mkdtempSync(join(tmpdir(), 'sre-out-')),
  llm: { available: false, dailyCapUsd: 10, monthlyCapUsd: 100 },
  agentsDir: join(import.meta.dirname, '..', 'agents'),
  runsDir: mkdtempSync(join(tmpdir(), 'sre-runs-')),
  slackWebhookUrl: undefined,
  slackBotToken: undefined,
  slackChannel: undefined,
  direct: undefined,
  memoryDir: undefined,
  build: undefined,
  retentionDays: 30,
  mcp: { usersFile: '/nonexistent', reposFile: '/nonexistent', userDailyCapUsd: 10, userMaxRunning: 2, notifySlack: false, allowedOrigins: [], agents: undefined, login: undefined, reposDir: undefined, reposGithub: undefined, githubApp: undefined },
});
