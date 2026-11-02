import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Gauge } from '../src/config.js';
import { collectGauge, collectAlerts } from '../src/patrol/infra.js';
import { FakeTelemetry } from './fake.js';
import { bucketOf } from '../src/patrol/digest.js';
import { urgent } from '../src/runner.js';
import { Noise } from '../src/patrol/noise.js';
import type { Series } from '../src/clients/telemetry.js';
import { buildSummary } from '../src/patrol/summary.js';
import { State } from '../src/patrol/state.js';
import type { Config } from '../src/config.js';
import { coverage } from '../src/patrol/coverage.js';

const at = new Date('2026-11-02T12:15:00Z');
const g: Gauge = {
  id: 'db-down',
  query: 'min by (cluster) (pg_up)',
  group_by: ['cluster'],
  unit: 'available',
  direction: 'below',
  warning: 0,
  critical: 0,
  for_minutes: 5,
};
class Gauges extends FakeTelemetry {
  constructor(readonly values: Series[]) {
    super(() => []);
  }
  override async promRange() {
    return this.values;
  }
}
const series = (values: number[]): Series => ({
  labels: { cluster: 'database' },
  points: values.map((v, i) => [at.getTime() / 1000 - 300 + i * 60, v]),
});

test('a sustained binary infrastructure failure bypasses event floor and uses measurement units', async () => {
  const [r] = await collectGauge(new Gauges([series([0, 0, 0, 0, 0, 0])]), g, at);
  assert.equal(r?.measurement?.level, 'critical');
  const f = { ...r!, novelty: 'fresh' as const, firstSeen: at.toISOString() };
  assert.equal(bucketOf(f, 10, false), 'look');
  assert.equal(urgent(f, new Noise({})), true);
  assert.equal((await collectGauge(new Gauges([series([1, 1, 1, 0, 0, 0])]), g, at)).length, 0, 'brief failure has not lasted five minutes');
});

test('a critical gauge escalation is worse even when its value did not double',async()=>{
  const [r]=await collectGauge(new Gauges([series([0,0,0,0,0,0])]),g,at);
  const warning={...r!,counts:{now:0.5,h1:0,d1:0,d7:0},measurement:{...r!.measurement!,value:0.5,level:'warning' as const}};
  const state=State.memory();state.seen(warning,at,['gauge:db-down']);state.reported(warning,at);
  assert.equal(state.novelty(r!,new Date(at.getTime()+900000)),'worse');
  state.reported(r!,at);
  assert.equal(state.novelty(r!,new Date(at.getTime()+900000)),'known','zero-valued faults do not worsen every patrol');
});

test('missing, nonfinite, stale and ambiguous gauge data fail observation rather than resolve an issue', async () => {
  for (const values of [[], [series([0, 0])], [series([0, 0, NaN, 0, 0, 0])], [series([0, 0, 0, 0, 0, 0]), series([0, 0, 0, 0, 0, 0])]])
    await assert.rejects(collectGauge(new Gauges(values), g, at));
});

test('an incomplete node cannot hide another node failure; a disappeared measurement cannot resolve', async () => {
  const observed = new Set<string>(),
    blind: string[] = [];
  const partial = { ...series([0, 0]), labels: { cluster: 'new-node' } };
  const rows = await collectGauge(new Gauges([series([0, 0, 0, 0, 0, 0]), partial]), g, at, observed, blind);
  assert.equal(rows.length, 1);
  assert.equal(blind.length, 1);
  const state = State.memory();
  state.seen(rows[0]!, at, ['gauge:db-down']);
  state.reported(rows[0]!, at);
  const c = {
    windowMinutes: 15,
    sources: {
      http_families: [],
      error_counters: [],
      gauges: [g],
      workloads: { namespaces: 'test' },
      logs: {},
      traces: {},
    },
  } as unknown as Config;
  const next = new Date(at.getTime() + 15 * 60_000);
  const onlyOther = {
    ...series([1, 1, 1, 1, 1, 1]),
    labels: { cluster: 'other' },
    points: series([1, 1, 1, 1, 1, 1]).points.map(([t, v]) => [t + 900, v] as [number, number]),
  };
  const result = await buildSummary(new Gauges([onlyOther]), c, new Noise({}), state, next);
  assert.equal(result.recovered.length, 0);
  assert.equal(state.data.rows[rows[0]!.key]?.recoveredAt, undefined);
});

test('coverage reports measurements and configured objectives; zero traffic is unknown, and p99 is a request quantile', async () => {
  const t = new FakeTelemetry((q) =>
    q.includes('histogram_quantile')
      ? [{ labels: { app: 'api' }, value: q.includes('0.99') ? 1.2 : 0.5 }]
      : [
          { labels: { app: 'api', status: '200' }, value: 990 },
          { labels: { app: 'api', status: '500' }, value: 10 },
          { labels: { app: 'idle', status: '200' }, value: 0 },
        ],
  );
  const s = {
    http_families: [
      {
        id: 'api',
        selector: 'requests',
        service_label: 'app',
        status_label: 'status',
        latency_buckets: 'duration_bucket',
      },
    ],
    objectives: [{ family: 'api', service: 'api', availability: 0.999, owner: 'platform' }],
  } as Config['sources'];
  const got = await coverage(t, s, at, 15);
  assert.equal(got.services[0]!.availability, 0.99);
  assert.equal(got.services[0]!.p99Seconds, 1.2);
  assert.equal(got.services[0]!.objective?.owner, 'platform');
  assert.equal(got.services[1]!.availability, null);
  assert.equal(got.services[1]!.objective, null);
});

test('scoped info alerts are context only and alerting health is required even when no alert fires', async () => {
  const seen: string[] = [];
  const tel = new FakeTelemetry((q) => {
    seen.push(q);
    return q.startsWith('count(')
      ? [{ labels: {}, value: 1 }]
      : [
          {
            labels: {
              alertname: 'Pool',
              namespace: 'microservices',
              severity: 'info',
            },
            value: 1,
          },
        ];
  });
  const rows = await collectAlerts(
    tel,
    {
      namespaces: 'microservices',
      health_selector: 'up{job="prometheus"} == 1',
    },
    at,
  );
  assert.equal(rows[0]?.contextOnly, true);
  assert.ok(seen.some((q) => q.includes('namespace=~"microservices"')));
  await assert.rejects(collectAlerts(new FakeTelemetry(() => []), { namespaces: 'microservices', health_selector: 'up == 1' }, at), /no alert evaluator/);
});
