import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DirectTelemetry, RecordingTelemetry, ReplayTelemetry, type LogLine, type Sample, type Series, type Telemetry, type TraceHit } from '../src/clients/telemetry.js';
import { Evidence } from '../src/engine/evidence.js';
import { monitorTools } from '../src/investigate/tools.js';
import { spanErrorsQuery } from '../src/patrol/collectors.js';
import { Noise } from '../src/patrol/noise.js';
import { State } from '../src/patrol/state.js';
import { buildSummary, renderSummary } from '../src/patrol/summary.js';
import { testConfig as cfg, world } from './fake.js';

// Telemetry with Loki and Tempo, answering each method from the test's world.
// Records every call, so a test can pin what (and how much) was read.
type Call = { m: string; q: string; start?: Date; end: Date; n?: number };
class Observed implements Telemetry {
  readonly has = { loki: true, tempo: true };
  readonly calls: Call[] = [];
  constructor(
    private readonly w: {
      prom?: (q: string, at: Date) => Sample[];
      logs?: (q: string, start: Date, end: Date, limit: number) => LogLine[];
      logCounts?: (q: string, start: Date, end: Date, stepSec: number) => Series[];
      traces?: (q: string, start: Date, end: Date, limit: number) => TraceHit[];
    } = {},
  ) {}
  async promInstant(q: string, at: Date) {
    this.calls.push({ m: 'promInstant', q, end: at });
    return (this.w.prom ?? world)(q, at);
  }
  async promRange(q: string, start: Date, end: Date) {
    this.calls.push({ m: 'promRange', q, start, end });
    return [];
  }
  async lokiRange(q: string, start: Date, end: Date, limit: number) {
    this.calls.push({ m: 'lokiRange', q, start, end, n: limit });
    return this.w.logs?.(q, start, end, limit) ?? [];
  }
  async lokiMetric(q: string, start: Date, end: Date, stepSec: number) {
    this.calls.push({ m: 'lokiMetric', q, start, end, n: stepSec });
    return this.w.logCounts?.(q, start, end, stepSec) ?? [{ labels: {}, points: [[end.getTime() / 1000, 4200]] as Array<[number, number]> }];
  }
  async tempoSearch(q: string, start: Date, end: Date, limit: number) {
    this.calls.push({ m: 'tempoSearch', q, start, end, n: limit });
    return this.w.traces?.(q, start, end, limit) ?? [hit('checkout', 'GET /health', 0)];
  }
}

const AT = new Date('2026-11-03T12:45:00Z');
const MIN = 60_000;
const hit = (rootService: string, rootName: string, i: number): TraceHit => ({ traceId: `t${i}`, rootService, rootName, startSec: AT.getTime() / 1000 - i, durationMs: 12 });
const hits = (n: number, rootService: string, rootName: string) => Array.from({ length: n }, (_, i) => hit(rootService, rootName, i));
const sourceOf = (s: Awaited<ReturnType<typeof buildSummary>>, name: string) => s.sources.find((x) => x.source === name);

// ---- 1. capped traces ------------------------------------------------------------

test('error traces at the search limit in every slot are lower bounds: the rows say so, and so does the traces source', async () => {
  const c = cfg();
  c.sources.traces.limit = 10;
  // Production, 2026-11-03: 300 of 300 error traces in every sampled slot.
  const tel = new Observed({
    traces: (q, _s, end, limit) => (q === '{}' ? [hit('any', 'any', 0)] : end.getTime() === AT.getTime() ? hits(limit, 'checkout', 'POST /pay') : hits(limit, 'catalog', 'GET /products')),
  });
  const s = await buildSummary(tel, c, new Noise({}), State.memory(), AT);
  const pay = s.send.find((r) => r.section === 'traces' && r.service === 'checkout');
  assert.ok(pay, 'the row is still flagged');
  assert.equal(pay.truncated, true);
  assert.match(renderSummary(s), /\[traces\] checkout POST \/pay: .*\[counts are lower bounds\]/);
  const traces = sourceOf(s, 'traces')!;
  assert.equal(traces.ok, true, 'capped is incomplete, not down');
  assert.match(traces.note ?? '', /^capped: the search limit \(10\) was hit now, 1 h ago, 1 d ago and 7 d ago: trace counts are lower bounds/);
  assert.match(renderSummary(s), /## Blind spots[^\n]*\n(?:- [^\n]*\n)*- traces \(read, incomplete\): capped: the search limit \(10\)/);
});

test('error logs at the line limit: the logs source says which windows were capped', async () => {
  const c = cfg(); // max_lines 100
  const line = (i: number): LogLine => ({ labels: { app: 'checkout' }, tsNs: `${AT.getTime() - i * 1000}000000`, line: `ERROR payment failed ${i}` });
  const tel = new Observed({ logs: (_q, _s, end, limit) => (end.getTime() === AT.getTime() ? Array.from({ length: limit }, (_, i) => line(i)) : [line(0)]) });
  const logs = sourceOf(await buildSummary(tel, c, new Noise({}), State.memory(), AT), 'logs');
  assert.deepEqual(logs, { source: 'logs', ok: true, note: 'capped: the line limit (100) was hit now: error log counts are lower bounds, not totals' });
});

test('below the limit, trace rows are exact and the traces source has no note', async () => {
  const c = cfg();
  c.sources.traces.limit = 10;
  const tel = new Observed({ traces: (q, _s, end) => (q === '{}' ? [hit('any', 'any', 0)] : end.getTime() === AT.getTime() ? hits(9, 'checkout', 'POST /pay') : []) });
  const s = await buildSummary(tel, c, new Noise({}), State.memory(), AT);
  assert.equal(s.send.find((r) => r.section === 'traces')?.truncated, undefined);
  assert.deepEqual(sourceOf(s, 'traces'), { source: 'traces', ok: true });
});

// ---- 2. partial scrape coverage ----------------------------------------------------

test('43 of 46 scrape targets up: the counter source says so, and stays ok', async () => {
  const c = cfg();
  c.sources.error_counters.push({ id: 'sqs', selector: '{__name__=~".+_sqs_message_errors_total"}', group_by: ['app', 'queue'], presence: 'up{job="svc"} == 1' });
  const tel = (up: number, total: number) =>
    new Observed({ prom: (q, at) => (q === 'count(up{job="svc"} == 1)' ? (up ? [{ labels: {}, value: up }] : []) : q === 'count(up{job="svc"})' ? [{ labels: {}, value: total }] : world(q, at)) });
  const at = new Date('2026-09-28T12:15:00Z');
  const s = await buildSummary(tel(43, 46), c, new Noise({}), State.memory(), at);
  assert.deepEqual(sourceOf(s, 'counter:sqs'), { source: 'counter:sqs', ok: true, note: '43 of 46 targets up for up{job="svc"}: errors on the other 3 are not seen' });
  assert.match(renderSummary(s), /## Blind spots[^\n]*\n(?:- [^\n]*\n)*- counter:sqs \(read, incomplete\): 43 of 46 targets up/);

  // All up: no note. None up: blind, as before.
  assert.deepEqual(sourceOf(await buildSummary(tel(46, 46), c, new Noise({}), State.memory(), at), 'counter:sqs'), { source: 'counter:sqs', ok: true });
  const none = sourceOf(await buildSummary(tel(0, 46), c, new Noise({}), State.memory(), at), 'counter:sqs');
  assert.equal(none?.ok, false);
  assert.match(none?.error ?? '', /\(missing data, not a quiet system\)$/);
});

test('a total that cannot be read never fails the counter source: coverage is "not checked"', async () => {
  const c = cfg();
  c.sources.error_counters.push({ id: 'sqs', selector: '{__name__=~".+_sqs_message_errors_total"}', group_by: ['app', 'queue'], presence: 'up{job="svc"} == 1' });
  const tel = new Observed({
    prom: (q, at) => {
      if (q === 'count(up{job="svc"})') throw new Error('prometheus: HTTP 503');
      return q === 'count(up{job="svc"} == 1)' ? [{ labels: {}, value: 43 }] : world(q, at);
    },
  });
  const src = sourceOf(await buildSummary(tel, c, new Noise({}), State.memory(), new Date('2026-09-28T12:15:00Z')), 'counter:sqs');
  assert.deepEqual(src, { source: 'counter:sqs', ok: true, note: 'share of targets up not checked (prometheus: HTTP 503)' });
});

// ---- 3. presence for logs and traces ---------------------------------------------

test('no log line at all while Loki answers is missing data, not a quiet system; the check is one cheap minute', async () => {
  const c = cfg();
  const quiet = new Observed({ logCounts: () => [] });
  const s = await buildSummary(quiet, c, new Noise({}), State.memory(), AT);
  const logs = sourceOf(s, 'logs')!;
  assert.equal(logs.ok, false);
  assert.equal(logs.error, 'no log lines at all for {namespace="microservices"} in the last minute (missing data, not a quiet system)');
  // Cost: one 1-minute count of the plain selector at the patrol time, never the window.
  const presence = quiet.calls.filter((x) => x.m === 'lokiMetric');
  // A 1 s step: a backend that aligns points to the step can't move it off the patrol time.
  assert.deepEqual(
    presence.map((x) => [x.q, x.start?.toISOString(), x.end.toISOString(), x.n]),
    [['sum(count_over_time({namespace="microservices"}[1m]))', AT.toISOString(), AT.toISOString(), 1]],
  );

  // Lines arrive, none of them errors: a quiet system, and the source is fine.
  assert.deepEqual(sourceOf(await buildSummary(new Observed(), c, new Noise({}), State.memory(), AT), 'logs'), { source: 'logs', ok: true });
});

test('errors read in the window are kept when the last minute is empty: lines may have stopped since, and the source says so', async () => {
  // 20 errors five minutes before the patrol, then nothing arrives.
  const burst: LogLine[] = Array.from({ length: 20 }, (_, i) => ({ labels: { app: 'checkout' }, tsNs: `${AT.getTime() - 5 * MIN - i * 1000}000000`, line: `ERROR payment failed ${i}` }));
  const tel = new Observed({ logs: (_q, _s, end) => (end.getTime() === AT.getTime() ? burst : []), logCounts: () => [] });
  const s = await buildSummary(tel, cfg(), new Noise({}), State.memory(), AT);
  assert.ok(s.send.some((r) => r.section === 'logs' && r.service === 'checkout'), 'the burst is still a row');
  assert.deepEqual(sourceOf(s, 'logs'), {
    source: 'logs',
    ok: true,
    note: 'no log lines at all for {namespace="microservices"} in the last minute, though the window\'s search read 20: newer lines may be missing',
  });
});

test('no trace at all while Tempo answers is missing data too; the check is `{}` with limit 1 in the window', async () => {
  const c = cfg();
  const none = new Observed({ traces: () => [] });
  const traces = sourceOf(await buildSummary(none, c, new Noise({}), State.memory(), AT), 'traces')!;
  assert.equal(traces.ok, false);
  assert.equal(traces.error, 'no traces at all ({}) in the last 15 min (missing data, not a quiet system)');
  const presence = none.calls.filter((x) => x.m === 'tempoSearch' && x.q === '{}');
  assert.deepEqual(
    presence.map((x) => [x.start?.toISOString(), x.end.toISOString(), x.n]),
    [[new Date(AT.getTime() - 15 * MIN).toISOString(), AT.toISOString(), 1]],
  );
  // Traces arrive, none of them errors: fine.
  const fine = new Observed({ traces: (q) => (q === '{}' ? [hit('any', 'any', 0)] : []) });
  assert.deepEqual(sourceOf(await buildSummary(fine, c, new Noise({}), State.memory(), AT), 'traces'), { source: 'traces', ok: true });
});

test('a presence query that errors proves nothing either way: the source stays as read, with a note', async () => {
  const tel = new Observed({
    logCounts: () => {
      throw new Error('loki: HTTP 400: max query length');
    },
  });
  const s = await buildSummary(tel, cfg(), new Noise({}), State.memory(), AT);
  // The search read nothing too: whether logs are read at all is unknown (not blind, not back), and no row recovers on it.
  assert.deepEqual(sourceOf(s, 'logs'), { source: 'logs', ok: true, note: 'log presence not checked (loki: HTTP 400: max query length)', unknown: true });
  // Errors read in the window show the logs are read: only the note.
  const read = new Observed({
    logs: (_q, _s, end) => (end.getTime() === AT.getTime() ? [{ labels: { app: 'checkout' }, tsNs: `${AT.getTime()}000000`, line: 'ERROR payment failed' }] : []),
    logCounts: () => {
      throw new Error('loki: HTTP 400: max query length');
    },
  });
  assert.deepEqual(sourceOf(await buildSummary(read, cfg(), new Noise({}), State.memory(), AT), 'logs'), { source: 'logs', ok: true, note: 'log presence not checked (loki: HTTP 400: max query length)' });
});

test('a row does not recover on a patrol whose read is unknown, only on one that shows the source read', async () => {
  const c = cfg(); // recovery after 15 min without firing
  const later = (min: number) => new Date(AT.getTime() + min * MIN);
  const burst: LogLine[] = Array.from({ length: 20 }, (_, i) => ({ labels: { app: 'checkout' }, tsNs: `${AT.getTime() - i * 1000}000000`, line: `ERROR payment failed ${i}` }));
  const lines = (at: Date): Series[] => [{ labels: {}, points: [[at.getTime() / 1000, 4200]] }];
  let presence: (at: Date) => Series[] = lines;
  const tel = new Observed({ logs: (_q, _s, end) => (end.getTime() === AT.getTime() ? burst : []), logCounts: (_q, _s, end) => presence(end) });
  const state = State.memory();
  const first = await buildSummary(tel, c, new Noise({}), state, AT);
  const pay = first.send.find((r) => r.section === 'logs')!.key;
  for (const r of first.send) state.reported(r, AT);

  // Nothing read, and the presence check fails: the row's quiet proves nothing.
  presence = () => {
    throw new Error('loki: HTTP 503');
  };
  const unknown = await buildSummary(tel, c, new Noise({}), state, later(15));
  assert.equal(sourceOf(unknown, 'logs')?.unknown, true);
  assert.deepEqual(unknown.recovered, []);
  presence = lines;
  assert.deepEqual((await buildSummary(tel, c, new Noise({}), state, later(30))).recovered, [pay], 'lines arrive again: back');
});

// ---- 4. the investigator's searches at their limit -------------------------------

test('log_search at its limit says where the limit cut the window, and adds per-10-minute counts', async () => {
  const c = cfg();
  // Run 20261103T124535Z-monitor-dcb74b read the oldest returned line (12:31) as the onset.
  const lines: LogLine[] = Array.from({ length: 10 }, (_, i) => ({ labels: { app: 'checkout' }, tsNs: `${Date.parse('2026-11-03T12:44:00Z') - i * 90_000}000000`, line: `ERROR payment failed for order ${i}` }));
  // Loki leaves out a step with no lines: those buckets are 0, not missing.
  const counts: Series[] = [{ labels: {}, points: [[Date.parse('2026-11-03T12:10:00Z') / 1000, 3], [Date.parse('2026-11-03T12:20:00Z') / 1000, 140], [Date.parse('2026-11-03T12:40:00Z') / 1000, 160]] }];
  const tel = new Observed({ logs: (_q, _s, _e, limit) => lines.slice(0, limit), logCounts: () => counts });
  const tools = monitorTools(tel, c, AT)(new Evidence(), 'author');
  const search = (a: Record<string, unknown>) => tools.find((t) => t.name === 'log_search')!.handler({ errors_only: true, end_minutes_ago: 0, ...a } as never, {});
  const text = ((await search({ service: 'checkout', minutes: 60, limit: 10 })).content[0] as { text: string }).text;

  const oldest = new Date(Date.parse('2026-11-03T12:44:00Z') - 9 * 90_000).toISOString(); // 12:30:30
  assert.match(text, /10 lines \(limit hit: counts are lower bounds\)/);
  assert.ok(text.includes(`the limit cut the window at ${oldest}, the oldest line returned. That is where this search stopped reading, not when the problem started`), text);
  assert.match(text, /per 10 min \(matching lines in the 10 min up to each time\): 11-03 11:50=0 11-03 12:00=0 11-03 12:10=3 11-03 12:20=140 11-03 12:30=0 11-03 12:40=160\n/);
  // Asked on multiples of the step (Loki and Grafana align a metric query's
  // points to them), and never past the window's end.
  const metric = tel.calls.filter((x) => x.m === 'lokiMetric');
  assert.deepEqual(
    metric.map((x) => [x.q, x.start?.toISOString(), x.end.toISOString(), x.n]),
    [['sum(count_over_time({namespace="microservices",app="checkout"} [10m]))', '2026-11-03T11:50:00.000Z', '2026-11-03T12:40:00.000Z', 600]],
  );
  // A backend that answers off that grid still has its points shown, never dropped.
  const odd = new Observed({ logs: () => lines, logCounts: () => [{ labels: {}, points: [[Date.parse('2026-11-03T12:25:00Z') / 1000, 7]] }] });
  const oddText = ((await monitorTools(odd, c, AT)(new Evidence(), 'author').find((t) => t.name === 'log_search')!.handler({ service: 'checkout', errors_only: true, end_minutes_ago: 0, minutes: 30, limit: 10 } as never, {})).content[0] as { text: string }).text;
  assert.match(oddText, /: 11-03 12:20=0 11-03 12:25=7 11-03 12:30=0 11-03 12:40=0\n/);

  // Under the limit: no cut, and no extra Loki query.
  const under = ((await search({ service: 'checkout', minutes: 60, limit: 50 })).content[0] as { text: string }).text;
  assert.doesNotMatch(under, /limit/);
  assert.equal(tel.calls.filter((x) => x.m === 'lokiMetric').length, 1);

  // Unfiltered and longer than an hour: the counts would scan every line, so they are skipped, and it says so.
  const wide = ((await search({ errors_only: false, minutes: 120, limit: 10 })).content[0] as { text: string }).text;
  assert.match(wide, /per-10-minute counts skipped: an unfiltered search over more than 60 min/);
  assert.equal(tel.calls.filter((x) => x.m === 'lokiMetric').length, 1);

  // Counts that fail to read don't fail the search.
  const broken = new Observed({
    logs: () => lines,
    logCounts: () => {
      throw new Error('loki: timeout');
    },
  });
  const t2 = monitorTools(broken, c, AT)(new Evidence(), 'author');
  const r = await t2.find((t) => t.name === 'log_search')!.handler({ service: 'checkout', errors_only: true, end_minutes_ago: 0, minutes: 30, limit: 10 } as never, {});
  assert.equal(r.isError, undefined);
  assert.match((r.content[0] as { text: string }).text, /per-10-minute counts not available \(loki: timeout\)/);
});

test('trace_search at its limit says the traces are a sample, not the start of the problem', async () => {
  const tel = new Observed({ traces: (_q, _s, _e, limit) => hits(limit, 'checkout', 'POST /pay') });
  const tools = monitorTools(tel, cfg(), AT)(new Evidence(), 'author');
  const search = (limit: number) => tools.find((t) => t.name === 'trace_search')!.handler({ traceql: '{ status = error }', minutes: 15, limit } as never, {});
  const text = ((await search(20)).content[0] as { text: string }).text;
  assert.match(text, /20 traces for \{ status = error \}\nlimit hit: Tempo stopped at 20 traces and there are more in the window\. This is a sample: counts are lower bounds, and the earliest trace listed is not when the problem started\./);
  const tel2 = new Observed({ traces: () => hits(3, 'checkout', 'POST /pay') });
  const under = ((await monitorTools(tel2, cfg(), AT)(new Evidence(), 'author').find((t) => t.name === 'trace_search')!.handler({ traceql: '{ status = error }', minutes: 15, limit: 20 } as never, {})).content[0] as { text: string }).text;
  assert.doesNotMatch(under, /limit hit/);
});

// ---- 5. replay of a recording made before these queries existed -------------------

test('a recording without the new queries replays: every source as read before, the new checks "not checked"', async () => {
  const c = cfg();
  c.sources.error_counters.push({ id: 'sqs', selector: '{__name__=~".+_sqs_message_errors_total"}', group_by: ['app', 'queue'], presence: 'up{job="svc"} == 1' });
  const prom = (q: string, at: Date) => (q === 'count(up{job="svc"} == 1)' ? [{ labels: {}, value: 43 }] : q === 'count(up{job="svc"})' ? [{ labels: {}, value: 46 }] : world(q, at));
  const dir = mkdtempSync(join(tmpdir(), 'sre-rec-'));
  await buildSummary(new RecordingTelemetry(new Observed({ prom }), dir), c, new Noise({}), State.memory(), AT);
  // Drop what an older engine never asked: the logs and traces presence and the targets total.
  const file = join(dir, 'responses.jsonl');
  const isNew = (l: string) => {
    const { c: call } = JSON.parse(l) as { c: { m: string; a: unknown[] } };
    return call.m === 'lokiMetric' || (call.m === 'tempoSearch' && call.a[0] === '{}') || (call.m === 'promInstant' && call.a[0] === 'count(up{job="svc"})');
  };
  const all = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(all.filter(isNew).length, 3, 'the recording had the three new queries');
  writeFileSync(file, all.filter((l) => !isNew(l)).join('\n') + '\n');

  const replay = new ReplayTelemetry(dir);
  const s = await buildSummary(replay, c, new Noise({}), State.memory(), AT);
  assert.ok(s.sources.every((x) => x.ok), JSON.stringify(s.sources));
  assert.deepEqual(
    s.sources.filter((x) => x.note).map((x) => [x.source, x.note]),
    [
      ['counter:sqs', 'share of targets up not checked (prometheus: not in recording)'],
      ['logs', 'log presence not checked (loki: not in recording)'],
      ['traces', 'trace presence not checked (tempo: not in recording)'],
    ],
  );
  assert.equal(replay.misses, 3, 'and they count as misses, as any query the recording lacks');
});

// ---- 6. trace rows on a capped search recover on their error counts -------------

const SPANS = spanErrorsQuery(15);
const PAY = 'traces|checkout|POST /pay|';
const later = (min: number) => new Date(AT.getTime() + min * MIN);
// Capped in every slot. checkout POST /pay is in the "now" sample at AT only;
// afterwards the sample is all catalog traces, as many as a day and a week before.
const cappedTraces = (q: string, _s: Date, end: Date, limit: number) =>
  q === '{}' ? [hit('any', 'any', 0)] : end.getTime() === AT.getTime() ? hits(limit, 'checkout', 'POST /pay') : hits(limit, 'catalog', 'GET /products');
const span = (service: string, span_name: string, value: number, span_kind = 'SPAN_KIND_SERVER'): Sample => ({ labels: { service, span_name, span_kind }, value });
// Span error counts: catalog's steady, checkout's as `pay` says at each query time.
const spanWorld = (pay: (at: Date) => Sample[] | Error) => (q: string, at: Date) => {
  if (q !== SPANS) return world(q, at);
  const p = pay(at);
  if (p instanceof Error) throw p;
  return [span('catalog', 'GET /products', 3, 'SPAN_KIND_CLIENT'), ...p];
};
const highSince = (from: number) => (at: Date) => [span('checkout', 'POST /pay', at.getTime() >= from ? 400 : 1)];
async function reportPay(tel: Telemetry, c: ReturnType<typeof cfg>, state: State) {
  const first = await buildSummary(tel, c, new Noise({}), state, AT);
  assert.ok(first.send.some((r) => r.key === PAY), 'flagged from the sample');
  for (const r of first.send) state.reported(r, AT);
}

test('capped traces: a row gone from the sample whose error count is still high keeps firing; once steady, it recovers after the hold', async () => {
  const c = { ...cfg(), recoverAfterMinutes: 60 };
  let high = true;
  const tel = new Observed({ traces: cappedTraces, prom: spanWorld((at) => (high ? highSince(AT.getTime() - 30 * MIN)(at) : [span('checkout', 'POST /pay', 1)])) });
  const state = State.memory();
  await reportPay(tel, c, state);
  for (const min of [15, 30, 45, 60, 75, 90]) {
    const s = await buildSummary(tel, c, new Noise({}), state, later(min));
    assert.ok(![...s.send, ...s.known, ...s.waiting].some((r) => r.key === PAY), 'absent from the sample');
    assert.deepEqual(s.recovered, [], `${min} min: the count still fires`);
  }
  assert.equal(state.data.rows[PAY]!.lastFiredAt, later(90).toISOString(), 'fired, as a row a noise rule hides does');
  high = false;
  for (const min of [105, 120, 135]) assert.deepEqual((await buildSummary(tel, c, new Noise({}), state, later(min))).recovered, [], `${min} min: within the hold`);
  const back = await buildSummary(tel, c, new Noise({}), state, later(150));
  assert.deepEqual(back.recovered, [PAY], 'an hour after the count last fired');
  assert.equal(back.recoveryNotes, undefined, 'back on its count: no note');
});

test('capped traces: an error count that cannot be read, or reads nothing at all, claims no recovery', async () => {
  const c = { ...cfg(), recoverAfterMinutes: 60 };
  const steady = [span('catalog', 'GET /products', 3), span('checkout', 'POST /pay', 1)];
  let spans: Sample[] | Error = steady;
  const tel = new Observed({
    traces: cappedTraces,
    prom: (q, at) => {
      if (q !== SPANS) return world(q, at);
      if (spans instanceof Error) throw spans;
      return spans;
    },
  });
  const state = State.memory();
  await reportPay(tel, c, state);

  spans = new Error('prometheus: HTTP 503');
  const failed = await buildSummary(tel, c, new Noise({}), state, later(75));
  assert.deepEqual(failed.recovered, []);
  assert.equal(sourceOf(failed, 'traces')!.ok, true, 'the search itself was read');
  assert.match(sourceOf(failed, 'traces')!.note ?? '', /^capped: .*; trace error counts not read \(prometheus: HTTP 503\): no trace row recovers while the search is capped$/);

  // No error span anywhere while the search is capped: span metrics are missing, not quiet.
  spans = [];
  const empty = await buildSummary(tel, c, new Noise({}), state, later(80));
  assert.deepEqual(empty.recovered, []);
  assert.match(sourceOf(empty, 'traces')!.note ?? '', /; no trace error counts at all now, though the search was capped \(missing data, not a quiet system\): no trace row recovers on it$/);

  spans = steady;
  assert.deepEqual((await buildSummary(tel, c, new Noise({}), state, later(90))).recovered, [PAY], 'read, and steady: back');
});

test('capped traces: a row with no span-metric series recovers as before, and says it had no count', async () => {
  const c = { ...cfg(), recoverAfterMinutes: 60 };
  const tel = new Observed({ traces: cappedTraces, prom: spanWorld(() => []) });
  const state = State.memory();
  await reportPay(tel, c, state);
  assert.deepEqual((await buildSummary(tel, c, new Noise({}), state, later(45))).recovered, [], 'within the hold');
  const back = await buildSummary(tel, c, new Noise({}), state, later(60));
  assert.deepEqual(back.recovered, [PAY]);
  assert.deepEqual(back.recoveryNotes, { [PAY]: 'recovered on a capped sample, no count' });
  assert.match(renderSummary(back), /## Recovered since last patrol \(1\)\n- traces\|checkout\|POST \/pay\| \(recovered on a capped sample, no count\)\n/);
  assert.doesNotMatch(sourceOf(back, 'traces')!.note ?? '', /trace error counts/, 'the counts were read: nothing to say on the source');
});

test('capped traces replayed from a recording without the count query: "not checked", and the row recovers as before, with a note', async () => {
  const c = { ...cfg(), recoverAfterMinutes: 60 };
  const dir = mkdtempSync(join(tmpdir(), 'sre-rec-'));
  // Still firing by its count: with the query recorded, the row stays open.
  const rec = new RecordingTelemetry(new Observed({ traces: cappedTraces, prom: spanWorld(highSince(AT.getTime() - 30 * MIN)) }), dir);
  for (const at of [AT, later(60)]) await buildSummary(rec, c, new Noise({}), State.memory(), at);
  const full = new ReplayTelemetry(dir);
  const withCounts = State.memory();
  await reportPay(full, c, withCounts);
  assert.deepEqual((await buildSummary(full, c, new Noise({}), withCounts, later(60))).recovered, [], 'recorded count: still firing');

  // An older recording: no count query at all.
  const file = join(dir, 'responses.jsonl');
  const all = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const isSpans = (l: string) => (JSON.parse(l) as { c: { a: unknown[] } }).c.a[0] === SPANS;
  assert.equal(all.filter(isSpans).length, 8, 'four instants per patrol');
  writeFileSync(file, all.filter((l) => !isSpans(l)).join('\n') + '\n');
  const replay = new ReplayTelemetry(dir);
  const state = State.memory();
  await reportPay(replay, c, state);
  const back = await buildSummary(replay, c, new Noise({}), state, later(60));
  assert.deepEqual(back.recovered, [PAY], 'a miss is not an unreadable count');
  assert.deepEqual(back.recoveryNotes, { [PAY]: 'recovered on a capped sample, count not checked' });
  assert.match(sourceOf(back, 'traces')!.note ?? '', /; trace error counts not checked \(prometheus: not in recording\)$/);
  assert.equal(replay.misses, 8);
});

// ---- the client --------------------------------------------------------------------

test('a LogQL metric query goes to query_range with a step and comes back as series', async (t) => {
  const calls: URL[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    calls.push(new URL(String(input)));
    return new Response(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [{ metric: {}, values: [[1762173300, '12'], [1762173900, '7']] }] } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => (globalThis.fetch = real));
  const tel = new DirectTelemetry({ prometheusUrl: 'http://p:9090', lokiUrl: 'http://loki:80', lokiOrgId: '1' });
  const series = await tel.lokiMetric('sum(count_over_time({app="x"}[10m]))', new Date(1762173300_000), new Date(1762173900_000), 600);
  assert.equal(calls[0]!.pathname, '/loki/api/v1/query_range');
  assert.deepEqual([calls[0]!.searchParams.get('step'), calls[0]!.searchParams.get('start'), calls[0]!.searchParams.get('end')], ['600', '1762173300000000000', '1762173900000000000']);
  assert.deepEqual(series, [{ labels: {}, points: [[1762173300, 12], [1762173900, 7]] }]);
});
