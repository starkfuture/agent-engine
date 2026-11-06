import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingTelemetry, ReplayTelemetry } from '../src/clients/telemetry.js';
import { fourWay, spanErrorsKey, spanErrorsQuery } from '../src/patrol/collectors.js';
import { contextQueries, extraPatrolQueries, recordContext, recordExtras } from '../src/export.js';
import { DAY, FakeTelemetry, H, testConfig } from './fake.js';

const AT = new Date('2026-11-02T08:00:00Z');

test('the span-metrics error query is the settled text at the 15-minute window', () => {
  assert.equal(spanErrorsQuery(15), 'sum by (service, span_name, span_kind) (increase(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[15m]))');
  assert.deepEqual(extraPatrolQueries(15), [spanErrorsQuery(15)]);
});

test('export records the span error counts at the four instants fourWay reads, and replay answers them', async () => {
  const seen: Array<[string, number]> = [];
  const span = { service: 'ecom-service', span_name: 'POST /orders', span_kind: 'SPAN_KIND_SERVER' };
  const inner = new FakeTelemetry((q, at) => {
    seen.push([q, at.getTime()]);
    return q === spanErrorsQuery(15) ? [{ labels: span, value: 4 }] : [];
  });
  const dir = mkdtempSync(join(tmpdir(), 'sre-export-'));
  await recordExtras(new RecordingTelemetry(inner, dir), AT, 15);
  assert.deepEqual(
    seen.sort((a, b) => b[1] - a[1]),
    [0, H, DAY, 7 * DAY].map((o) => [spanErrorsQuery(15), AT.getTime() - o]),
  );

  // A later collector reading the same query through fourWay finds all four in the recording.
  const replay = new ReplayTelemetry(dir);
  const cells = await fourWay(replay, spanErrorsQuery(15), AT, spanErrorsKey);
  assert.equal(replay.misses, 0);
  assert.deepEqual(cells.get('ecom-service\u0000POST /orders\u0000SPAN_KIND_SERVER')?.counts, { now: 4, h1: 4, d1: 4, d7: 4 });
});

test('raw context covers counters, workloads, rollouts, span errors and firing alerts', () => {
  const c = testConfig();
  c.sources.error_counters.push({ id: 'sqs', selector: '{__name__=~".+_sqs_message_errors_total"}', group_by: ['app', 'queue'], presence: 'up{job="svc"} == 1' });
  c.sources.deploys.argocd = true;
  const ids = contextQueries(c.sources).map((x) => x.id);
  assert.deepEqual(ids, [
    'http:legacy-v1',
    'counter:sqs',
    'counter:sqs:presence',
    'workloads:restarts',
    'workloads:last-terminated',
    'workloads:waiting',
    'workloads:unavailable',
    'workloads:pending',
    'rollouts:remaining',
    'rollouts:progress-deadline',
    'rollouts:replicasets',
    'rollouts:images',
    'traces:span-errors',
    'alerts',
    'argocd:apps',
  ]);
  const byId = Object.fromEntries(contextQueries(c.sources).map((x) => [x.id, x.query]));
  assert.equal(byId['counter:sqs'], 'sum by (app, queue) (increase({__name__=~".+_sqs_message_errors_total"}[5m]))');
  assert.equal(byId['traces:span-errors'], spanErrorsQuery(5));
  assert.equal(byId['alerts'], 'ALERTS{alertstate="firing"}');
  assert.match(byId['workloads:restarts']!, /namespace=~"microservices"/);
  c.sources.deploys.argocd = false;
  assert.ok(!contextQueries(c.sources).some((x) => x.id === 'argocd:apps'), 'argocd off: not read');
});

test('raw context is read in 6-hour chunks at a 5-minute step, and one failing query does not stop the rest', async () => {
  const c = testConfig();
  const ranges: Array<[string, number, number, number]> = [];
  const inner = new FakeTelemetry(
    () => [],
    (q, s, e, step) => {
      ranges.push([q, s.getTime(), e.getTime(), step]);
      if (q.startsWith('ALERTS')) throw new Error('boom');
      return [];
    },
  );
  const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'sre-export-'));
  await recordContext(new RecordingTelemetry(inner, dir), c.sources, AT, new Date(AT.getTime() + 9 * H), (s) => logs.push(s));
  const n = contextQueries(c.sources).length;
  assert.equal(ranges.length, 2 * n, 'two chunks: 6 h and the remaining 3 h');
  assert.ok(ranges.every(([, , , step]) => step === 300));
  assert.deepEqual([...new Set(ranges.map(([, s, e]) => `${(s - AT.getTime()) / H}-${(e - AT.getTime()) / H}`))], ['0-6', '6-9']);
  assert.deepEqual(logs, ['raw alerts: boom', 'raw alerts: boom']);
  const recorded = readFileSync(join(dir, 'responses.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(recorded.length, 2 * n, 'errors are recorded too');
});
