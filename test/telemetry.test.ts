import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DirectTelemetry, GrafanaTelemetry, SourceError } from '../src/clients/telemetry.js';
import type { Engine } from '../src/engine/run.js';
import { Store } from '../src/engine/store.js';
import { Metrics } from '../src/metrics.js';
import { SlackError, SlackOutbox } from '../src/output/slack.js';
import type { PatrolResult } from '../src/runner.js';

// fetch stub: records each request, answers with the given JSON.
function stubFetch(answer: (url: URL) => unknown) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify(answer(url)), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

test('in-cluster telemetry calls the backends directly, with the Loki tenant header', async (t) => {
  const f = stubFetch((u) =>
    u.pathname.startsWith('/loki') ? { status: 'success', data: { result: [{ stream: { app: 'x' }, values: [['1', 'line']] }] } } : u.pathname === '/api/search' ? { traces: [] } : { status: 'success', data: { result: [] } },
  );
  t.after(f.restore);
  const tel = new DirectTelemetry({ prometheusUrl: 'http://kube-prometheus-stack-prometheus.monitoring:9090/', lokiUrl: 'http://loki-gateway.monitoring:80', lokiOrgId: '1', tempoUrl: 'http://tempo.monitoring:3100' });
  const end = new Date('2026-10-15T12:00:00Z');
  await tel.promInstant('up', end);
  const logs = await tel.lokiRange('{app="x"}', new Date(end.getTime() - 600_000), end, 10);
  await tel.tempoSearch('{ status = error }', new Date(end.getTime() - 6 * 3600_000), end, 20);

  assert.equal(f.calls[0]!.url.href.split('?')[0], 'http://kube-prometheus-stack-prometheus.monitoring:9090/api/v1/query');
  assert.equal(f.calls[0]!.headers.Authorization, undefined, 'no Grafana token in-cluster');
  assert.equal(f.calls[1]!.url.host, 'loki-gateway.monitoring');
  assert.equal(f.calls[1]!.headers['X-Scope-OrgID'], '1');
  assert.equal(logs[0]!.line, 'line');
  const q = f.calls[2]!.url.searchParams;
  assert.equal(Number(q.get('end')) - Number(q.get('start')), 30 * 60, 'a 6 h trace search is cut to 30 min');
});

test('locally, the same queries go through Grafana\'s datasource proxy with the token', async (t) => {
  const f = stubFetch(() => ({ status: 'success', data: { result: [] } }));
  t.after(f.restore);
  const tel = new GrafanaTelemetry({ url: 'https://grafana.test', token: 'tok', promUid: 'prom', lokiUid: 'loki' });
  await tel.promInstant('up', new Date());
  await tel.lokiRange('{a="b"}', new Date(), new Date(), 5);
  assert.equal(f.calls[0]!.url.href.split('?')[0], 'https://grafana.test/api/datasources/proxy/uid/prom/api/v1/query');
  assert.equal(f.calls[0]!.headers.Authorization, 'Bearer tok');
  assert.equal(f.calls[1]!.url.pathname, '/api/datasources/proxy/uid/loki/loki/api/v1/query_range');
  assert.equal(tel.has.tempo, false);
});

test('Tempo refuses every regex match, before any request; exact matches go through', async (t) => {
  const f = stubFetch(() => ({ traces: [] }));
  t.after(f.restore);
  const tel = new DirectTelemetry({ prometheusUrl: 'http://p:9090', tempoUrl: 'http://tempo:3100' });
  const now = new Date();
  for (const q of ['{ name =~ ".*" }', '{ name =~ "^.*" }', '{ name =~ "(.*)" }', '{ resource.service.name =~ "checkout.*" }', '{ span.http.url !~ ".*health" }', '{ name=~"x" }'])
    await assert.rejects(tel.tempoSearch(q, now, now, 10), (e: Error) => e instanceof SourceError && /regex/.test(e.message), q);
  await tel.tempoSearch('{ resource.service.name = "checkout" && status = error }', now, now, 10);
  await tel.tempoSearch('{ name = "a=~b" }', now, now, 10); // "=~" inside a value is just text
  assert.equal(f.calls.length, 2);
});

test('metrics: heartbeat, blind spots, runs and spend in Prometheus text format', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'runs-'));
  const store = new Store(':memory:');
  const engine: Engine = { store, runsDir, stopFile: join(runsDir, 'STOP'), session: () => (async function* () {})(), dailyCapUsd: 30, monthlyCapUsd: 300, llmAvailable: true };
  const now = new Date();
  store.admit({ id: 'r1', agent: 'codebase', version: 'v', trigger: 't', now, deadlineMs: 60_000, reserve: 2, agentCap: 10, globalCap: 30 });
  store.settle('r1', { status: 'ok', cost: 0.4, turns: 3, outputs: 1, now });
  const m = new Metrics();
  const at = new Date('2026-10-15T12:00:00Z');
  m.patrol(at, { summary: { sources: [{ source: 'prometheus', ok: true }, { source: 'loki', ok: false }] }, cards: [] } as unknown as PatrolResult);
  writeFileSync(engine.stopFile, 'x');
  const text = m.render(engine, now);
  assert.match(text, /^engine_up 1$/m);
  assert.match(text, /^engine_stop_switch 1$/m);
  assert.match(text, new RegExp(`^engine_patrol_last_success_timestamp_seconds ${at.getTime() / 1000}$`, 'm'));
  assert.match(text, /^engine_patrol_source_up\{source="loki"\} 0$/m);
  assert.match(text, /^engine_runs_today\{agent="codebase",status="ok"\} 1$/m);
  assert.match(text, /^engine_spend_usd\{period="day"\} 0\.4$/m);
  assert.match(text, /^engine_spend_cap_usd\{period="month"\} 300$/m);
  for (const line of text.trim().split('\n')) assert.match(line, /^(# (HELP|TYPE) \w+ .+|\w+(\{[^}]*\})? -?[\d.e+]+)$/, line);

  // A failed patrol moves "last run" but not "last success".
  const m2 = new Metrics();
  m2.patrol(at);
  assert.match(m2.render(engine, now), /engine_patrol_last_run_timestamp_seconds/);
  assert.doesNotMatch(m2.render(engine, now), /engine_patrol_last_success/);
});

test('metrics: the Slack outbox by status and the age of its oldest waiting post, right after the runs', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'runs-'));
  const engine: Engine = { store: new Store(':memory:'), runsDir, stopFile: join(runsDir, 'STOP'), session: () => (async function* () {})(), dailyCapUsd: 30, llmAvailable: true };
  const clock = { now: new Date('2026-11-06T10:00:00Z') };
  const slack = { down: false };
  const box = new SlackOutbox(':memory:', { threads: false, post: async () => (slack.down ? Promise.reject(new SlackError('Slack: HTTP 503')) : undefined) }, { now: () => clock.now, sleep: async () => {}, gapMs: 0 });
  const post = (text: string) => box.enqueue({ kind: 'report', message: { text, blocks: [] }, keys: [], broadcast: true });
  const m = new Metrics();
  assert.doesNotMatch(m.render(engine, clock.now), /engine_slack_outbox/, 'no outbox: no outbox gauges');
  m.slackOutbox(box);

  post('delivered');
  await box.flush();
  let text = m.render(engine, clock.now);
  assert.match(text, /^engine_slack_outbox\{status="sent"\} 1$/m);
  assert.match(text, /^engine_slack_outbox\{status="pending"\} 0$/m, 'every status is there from 0');
  assert.match(text, /^engine_slack_outbox\{status="gave_up"\} 0$/m);
  assert.match(text, /^engine_slack_outbox_oldest_pending_age_seconds 0$/m);

  // Slack is down: two posts wait, the oldest for 20 minutes by the next scrape.
  slack.down = true;
  post('waiting 1');
  clock.now = new Date('2026-11-06T10:05:00Z');
  post('waiting 2');
  await box.flush();
  clock.now = new Date('2026-11-06T10:20:00Z');
  text = m.render(engine, clock.now);
  assert.match(text, /^engine_slack_outbox\{status="pending"\} 2$/m);
  assert.match(text, /^engine_slack_outbox_oldest_pending_age_seconds 1200$/m);
  assert.match(text, /^# HELP engine_slack_outbox Slack posts in the outbox by status: pending not taken by Slack yet, failed and gave_up never delivered\.$/m);
  assert.match(text, /^# HELP engine_slack_outbox_oldest_pending_age_seconds Age of the oldest Slack post still waiting to be delivered; 0 when none waits\.$/m);
  for (const line of text.trim().split('\n')) assert.match(line, /^(# (HELP|TYPE) \w+ .+|\w+(\{[^}]*\})? -?[\d.e+]+)$/, line);
  const names = text.split('\n').filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]);
  assert.deepEqual(names.slice(names.indexOf('engine_runs_today'), names.indexOf('engine_runs_today') + 3), ['engine_runs_today', 'engine_slack_outbox', 'engine_slack_outbox_oldest_pending_age_seconds']);

  // A day later they are given up: counted as never delivered, and nothing waits.
  slack.down = false;
  clock.now = new Date('2026-11-07T10:30:00Z');
  await box.flush();
  text = m.render(engine, clock.now);
  assert.match(text, /^engine_slack_outbox\{status="gave_up"\} 2$/m);
  assert.match(text, /^engine_slack_outbox_oldest_pending_age_seconds 0$/m);
});

test('trace ids come back with all 32 hex digits (Tempo search drops leading zeros)', async (t) => {
  const f = stubFetch(() => ({ traces: [{ traceID: '6f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5', rootServiceName: 'checkout', rootTraceName: 'POST /pay', startTimeUnixNano: '0' }, { traceID: '0123456789abcdef0123456789abcdef' }] }));
  t.after(f.restore);
  const tel = new DirectTelemetry({ prometheusUrl: 'http://p:9090', tempoUrl: 'http://tempo:3100' });
  const [short, full] = await tel.tempoSearch('{ status = error }', new Date(), new Date(), 10);
  assert.equal(short!.traceId, '06f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5');
  assert.equal(full!.traceId, '0123456789abcdef0123456789abcdef');
});
