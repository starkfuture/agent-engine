import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { SourceError, type Sample, type Series } from '../src/clients/telemetry.js';
import { loadAgent } from '../src/engine/agent.js';
import type { Engine } from '../src/engine/run.js';
import type { Session } from '../src/engine/session.js';
import { Store } from '../src/engine/store.js';
import { Metrics } from '../src/metrics.js';
import { CardSink } from '../src/output/sink.js';
import { SlackOutbox } from '../src/output/slack.js';
import { Noise } from '../src/patrol/noise.js';
import { State } from '../src/patrol/state.js';
import { patrolOnce, type MonitorAgent, type PatrolResult } from '../src/runner.js';
import { fakeSession, ok, type Script } from './fake-session.js';
import { FakeTelemetry, testConfig as cfg, world } from './fake.js';

// Two states that look exactly like a quiet channel: the AI paused (a cap, the
// kill switch) and sources the patrol can't read. Each is said once when it
// starts and once when it ends, by code.

function monitor(c: Config, session: Session, caps: Partial<Engine> = {}): MonitorAgent {
  return {
    engine: { store: new Store(join(c.runsDir, 'engine.db')), runsDir: c.runsDir, stopFile: join(c.runsDir, 'STOP'), session, dailyCapUsd: 20, llmAvailable: true, ...caps },
    agent: loadAgent(join(c.agentsDir, 'monitor')),
  };
}

// A run that reports nothing: admitted, and over.
const quiet: Script = async function* () {
  yield ok(0.1);
};

// The webhook: no threads, every post top-level. `text` is each post's
// notification line, `all` everything it shows.
function webhook() {
  const sent: Array<{ text: string; all: string }> = [];
  const box = new SlackOutbox(':memory:', { threads: false, post: async (m) => (sent.push({ text: m.text, all: `${m.text}\n${JSON.stringify(m.blocks)}` }), undefined) }, { sleep: async () => {}, gapMs: 0 });
  return { box, sent, texts: () => sent.map((s) => s.text) };
}

// kube-state-metrics scraped (workloads and rollouts can see), and 20 400s a
// window on each route from its start time: worth a look, not urgent.
const firing = (since: Record<string, string>) =>
  new FakeTelemetry((q, at): Sample[] => {
    if (q.startsWith('count(kube_')) return [{ labels: {}, value: 120 }];
    if (!q.includes('backend_be_production_http_requests_total')) return [];
    return Object.entries(since).flatMap(([route, from]) => [
      { labels: { route, status_code: '200' }, value: 1000 },
      { labels: { route, status_code: '400' }, value: at.getTime() >= Date.parse(from) ? 20 : 0 },
    ]);
  });

const spent = (m: MonitorAgent, usd: number, day: string) => {
  m.engine.store.admit({ id: `earlier-${day}`, agent: 'monitor', version: 'v', trigger: 'patrol', now: new Date(`${day}T10:00:00Z`), deadlineMs: 60_000, reserve: usd, agentCap: 100, globalCap: 100 });
  m.engine.store.settle(`earlier-${day}`, { status: 'ok', cost: usd, turns: 1, outputs: 1, now: new Date(`${day}T10:05:00Z`) });
};

// ---- the AI paused ----------------------------------------------------------------

test("the monitor's share used up: one 'AI paused' in the channel, nothing more while it holds, one 'resumed' when a run is admitted again", async () => {
  const c = cfg();
  const { box, sent, texts } = webhook();
  let clock = new Date('2026-09-29T12:15:30Z');
  const m = monitor(c, fakeSession(quiet, quiet), { monthlyCapUsd: 250, agentMonthlyCapUsd: { monitor: 10 }, now: () => clock });
  spent(m, 8, '2026-09-10'); // the monitor has spent $8 of its $10 this month
  const state = State.memory();
  const tel = firing({ '/v1/auth/login': '2026-09-29T12:00:00Z', '/v1/auth/signup': '2026-09-29T13:30:00Z' });
  const pass = (time: string) => {
    clock = new Date(Date.parse(time) + 30_000);
    return patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir, box), new Date(time), { llm: true, post: true }, m);
  };

  const first = await pass('2026-09-29T12:15:00Z');
  assert.equal(first.investigation?.status, 'skipped');
  assert.deepEqual(texts(), ["⏸️ AI paused: the monitor's monthly AI budget ($10) is used up"], 'the rows are not urgent: the pause is the only post');
  assert.match(sent[0]!.all, /Since 12:15Z\. Urgent rows are still posted; other rows wait until it lifts\./);
  assert.ok(first.cards.some((f) => basename(f).endsWith('-paused.md')), 'on disk too');

  for (const time of ['2026-09-29T12:30:00Z', '2026-09-29T12:45:00Z']) assert.match((await pass(time)).skippedLlm ?? '', /^deferred: agent monthly cap \$10 reached/);
  assert.equal(sent.length, 1, 'the same hold: nothing more');

  m.engine.agentMonthlyCapUsd = { monitor: 100 }; // the share is raised
  const lifted = await pass('2026-09-29T13:00:00Z');
  assert.equal(lifted.investigation?.status, 'no_output', 'admitted');
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.text, '▶️ AI investigations resumed');
  assert.match(sent[1]!.all, /Paused since 12:15Z \(45 min\): the monitor's monthly AI budget \(\$10\) is used up\./);

  await pass('2026-09-29T13:15:00Z'); // the row is still owed: another admitted run
  assert.equal(sent.length, 2, 'resumed once');

  writeFileSync(m.engine.stopFile, 'test'); // a new hold, for a new row: the kill switch
  await pass('2026-09-29T13:30:00Z');
  await pass('2026-09-29T13:45:00Z');
  assert.deepEqual(texts().slice(2), ['⏸️ AI paused: the kill switch is on (set test); an admin clears it with resume']);
});

// A major report on the rows it is asked about, and a challenger that agrees.
const major: Script = async function* (sim) {
  const out = await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
  const id = /evidence_id: (E-[0-9a-f]{4}-\d+)/.exec(out.text)![1]!;
  const quote = /^\S+ 400 \| [1-9]\d*/m.exec(out.text)![0];
  const r = await sim.mcp('submit_report', {
    title: 'Sign-in returns 400',
    severity: 'major',
    status: 'active',
    started_at: '2026-09-29T12:00:00Z',
    what_broke: 'POST /v1/auth/login returns 400',
    impact: '2% of sign-ins',
    reach: 'many',
    cause: { hypothesis: 'a validation change', confidence: 'medium' },
    evidence: [{ id, quote, claim: 'the route returns 400' }],
    suggested_fix: 'roll it back',
    not_checked: [],
    rows: ['http|backend-production|/v1/auth/login|400'],
    issue: 'new',
  });
  assert.equal(r.isError, false, r.text);
  yield ok(0.1);
};
const agrees: Script = async function* (sim) {
  await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
  await sim.mcp('submit_challenge', { objections: [], overall: 'Holds up.' });
  yield ok(0.1, 1);
};

test('a patrol that dies during the first admitted run after a pause says "resumed" once, after the restart', async () => {
  const c = cfg();
  const { box, texts } = webhook();
  let clock = new Date('2026-09-29T12:15:30Z');
  const m = monitor(c, fakeSession(major, agrees, major, agrees), { dailyCapUsd: 0, now: () => clock });
  let state = State.load(c.stateFile);
  const tel = firing({ '/v1/auth/login': '2026-09-29T12:00:00Z' });
  const pass = (time: string) => {
    clock = new Date(Date.parse(time) + 30_000);
    return patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir, box), new Date(time), { llm: true, post: true }, m);
  };
  await pass('2026-09-29T12:15:00Z');
  assert.equal(texts().length, 1, 'paused');
  m.engine.dailyCapUsd = 20;
  // The run is admitted, then the patrol dies before it ends (here: its report can't be queued).
  const { enqueue } = box;
  box.enqueue = (p) => {
    if (p.kind === 'report') throw new Error('database is locked');
    return enqueue.call(box, p);
  };
  await assert.rejects(pass('2026-09-29T12:30:00Z'), /database is locked/);
  box.enqueue = enqueue;
  state = State.load(c.stateFile); // the restart
  const again = await pass('2026-09-29T12:45:00Z');
  assert.equal(again.investigation?.status, 'ok');
  assert.equal(texts().filter((t) => t.startsWith('▶️')).length, 1);
});

test('during a hold the urgent rows card says the AI is paused, not that an investigation started', async () => {
  const c = cfg();
  const { box, texts } = webhook();
  const m = monitor(c, fakeSession(), { dailyCapUsd: 0, now: () => new Date('2026-09-29T12:15:30Z') });
  // An earlier patrol was refused today (an engine from before these notices).
  const state = new State({ rows: {}, held: { reason: 'global daily cap $0 reached', since: '2026-09-29T11:00:10.000Z', runId: 'r-earlier' } });
  const r = await patrolOnce(new FakeTelemetry(world), c, new Noise({}), state, new CardSink(c.outDir, box), new Date('2026-09-29T12:15:00Z'), { llm: true, post: true }, m);
  assert.match(r.skippedLlm ?? '', /^deferred: global daily cap \$0 reached/);
  const md = readFileSync(r.cards[0]!, 'utf8');
  assert.match(md, /_AI paused: the daily AI budget across all agents \(\$0\) is used up until 00:00 UTC · blind spots: logs, traces_/);
  assert.doesNotMatch(md, /AI investigation started/);
  assert.match(texts()[0]!, /^Patrol 2026-09-29 12:15Z: 2 to look at/, 'the urgent card first');
  assert.deepEqual(texts().slice(1), ['⏸️ AI paused: the daily AI budget across all agents ($0) is used up until 00:00 UTC'], 'a hold nobody announced yet is announced');

  // Yesterday's daily cap no longer holds: the card can't know yet.
  const c2 = cfg();
  const yesterday = new State({ rows: {}, held: { reason: 'global daily cap $0 reached', since: '2026-09-28T23:00:00.000Z', runId: 'r-yesterday' } });
  const m2 = monitor(c2, fakeSession(), { dailyCapUsd: 0, now: () => new Date('2026-09-29T12:15:30Z') });
  const r2 = await patrolOnce(new FakeTelemetry(world), c2, new Noise({}), yesterday, new CardSink(c2.outDir), new Date('2026-09-29T12:15:00Z'), { llm: true, post: false }, m2);
  assert.match(readFileSync(r2.cards[0]!, 'utf8'), /_AI investigation started · blind spots: logs, traces_/);
});

test("a daily cap's hold ends with its UTC day: still refused the next day, that is a new hold, said once more", async () => {
  const c = cfg();
  const { box, texts } = webhook();
  let clock = new Date('2026-09-29T23:30:20Z');
  const m = monitor(c, fakeSession(), { dailyCapUsd: 0, now: () => clock });
  const state = State.memory();
  const tel = firing({ '/v1/auth/login': '2026-09-29T12:00:00Z' });
  const pass = (time: string) => {
    clock = new Date(Date.parse(time) + 20_000);
    return patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir, box), new Date(time), { llm: true, post: true }, m);
  };
  await pass('2026-09-29T23:30:00Z');
  await pass('2026-09-29T23:45:00Z');
  await pass('2026-09-30T00:00:00Z');
  await pass('2026-09-30T00:15:00Z');
  const paused = texts().filter((t) => t.startsWith('⏸️'));
  assert.equal(paused.length, 2, 'one per UTC day');
  assert.ok(texts().every((t) => !t.startsWith('▶️')), 'no run was admitted: nothing resumed');
});

test('posting off (replay, a dry patrol): the notices are written to disk and nothing is sent', async () => {
  const c = cfg();
  const { box, sent } = webhook();
  const m = monitor(c, fakeSession(), { dailyCapUsd: 0, now: () => new Date('2026-09-29T12:15:30Z') });
  let down = false;
  const tel = new FakeTelemetry((q, at) => {
    if (down && !q.startsWith('count(kube_')) throw new SourceError('prometheus', 'HTTP 503: upstream unavailable');
    return world(q, at);
  });
  const r = await patrolOnce(tel, c, new Noise({}), State.memory(), new CardSink(c.outDir, box), new Date('2026-09-29T12:15:00Z'), { llm: true, post: false, trigger: 'replay' }, m);
  down = true;
  const r2 = await patrolOnce(tel, c, new Noise({}), State.memory(), new CardSink(c.outDir, box), new Date('2026-09-29T12:30:00Z'), { llm: false, post: false, trigger: 'replay' });
  assert.deepEqual(sent, []);
  assert.equal(box.status().length, 0, 'nothing queued either');
  const paused = r.cards.find((f) => basename(f).endsWith('-paused.md'));
  const blind = r2.cards.find((f) => basename(f).endsWith('-blind.md'));
  assert.match(readFileSync(paused!, 'utf8'), /AI paused: the daily AI budget across all agents \(\$0\) is used up/);
  assert.match(readFileSync(blind!, 'utf8'), /http:legacy-v1, workloads, rollouts: prometheus HTTP 503/);
});

test('a dry patrol on the live state file never keeps the channel from hearing', async () => {
  const c = cfg();
  const { box, texts } = webhook();
  const m = monitor(c, fakeSession(), { dailyCapUsd: 0, now: () => new Date('2026-09-29T12:15:30Z') });
  let down = true;
  const tel = new FakeTelemetry((q, at) => {
    if (down && q.includes('kube_')) throw new SourceError('prometheus', 'HTTP 503: upstream unavailable');
    return world(q, at);
  });
  const pass = (time: string, post: boolean) => patrolOnce(tel, c, new Noise({}), State.load(c.stateFile), new CardSink(c.outDir, box), new Date(time), { llm: true, post }, m);
  const dry = await pass('2026-09-29T12:15:00Z', false); // someone runs `patrol` by hand, without --post
  assert.ok(['-blind.md', '-paused.md'].every((n) => dry.cards.some((f) => f.endsWith(n))), 'written to disk');
  const again = await pass('2026-09-29T12:30:00Z', false);
  assert.deepEqual(again.cards, [], 'and not again on disk');
  assert.deepEqual(texts(), []);
  await pass('2026-09-29T12:45:00Z', true); // the live patrol
  assert.deepEqual(texts(), ['⚠️ Blind at 12:45Z: the patrol could not read 2 sources', '⏸️ AI paused: the daily AI budget across all agents ($0) is used up until 00:00 UTC']);
  down = false;
  await pass('2026-09-29T13:00:00Z', true);
  assert.deepEqual(texts().slice(2), ['✅ The patrol reads 2 sources again at 13:00Z, after 15 min blind']);
});

// ---- blind sources ----------------------------------------------------------------

test('sources the patrol cannot read are said once, and once when every one is back, with how long; a restart does not repeat it', async () => {
  const c = cfg();
  const { box, sent, texts } = webhook();
  let down = true;
  // Prometheus times out: every source but logs and traces (not configured here) is blind.
  const tel = new FakeTelemetry((q, at) => {
    if (down) throw new SourceError('prometheus', 'The operation was aborted due to timeout');
    return world(q, at);
  });
  let state = State.load(c.stateFile);
  const pass = (time: string) => patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir, box), new Date(time), { llm: false, post: true });

  await pass('2026-09-28T12:15:00Z');
  assert.deepEqual(texts(), ['⚠️ Blind at 12:15Z: the patrol could not read 3 sources']);
  assert.match(sent[0]!.all, /http:legacy-v1, workloads, rollouts: prometheus timeout/);
  assert.match(sent[0]!.all, /Problems there go unseen, and their issues stay open, until they read again\./);
  assert.doesNotMatch(sent[0]!.all, /logs|traces/, 'not configured is not blind');

  await pass('2026-09-28T12:30:00Z');
  state = State.load(c.stateFile); // a restart
  await pass('2026-09-28T12:45:00Z');
  assert.equal(sent.length, 1, 'still blind: nothing more, also after a restart');

  down = false;
  await pass('2026-09-28T13:00:00Z');
  assert.deepEqual(texts().slice(1), ['✅ The patrol reads 3 sources again at 13:00Z, after 45 min blind']);
  assert.match(sent[1]!.all, /http:legacy-v1, workloads, rollouts/);
  await pass('2026-09-28T13:15:00Z');
  assert.equal(sent.length, 2, 'back once');
});

test('one outage, however it spreads: a source that joins it is said once, and it is back only when every source is', async () => {
  const c = cfg();
  const { sent, texts, box } = webhook();
  let failing: RegExp | undefined = /backend_be_production_http_requests_total/;
  const tel = new FakeTelemetry((q, at) => {
    if (failing?.test(q)) throw new SourceError('prometheus', 'HTTP 502: bad gateway');
    return world(q, at);
  });
  const state = State.memory();
  const pass = (time: string) => patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir, box), new Date(time), { llm: false, post: true });
  await pass('2026-09-28T12:15:00Z');
  failing = /backend_be_production_http_requests_total|kube_/;
  await pass('2026-09-28T12:30:00Z');
  failing = /kube_/; // the HTTP family reads again; kube-state-metrics doesn't
  await pass('2026-09-28T12:45:00Z');
  failing = undefined;
  await pass('2026-09-28T13:00:00Z');
  assert.deepEqual(texts(), [
    '⚠️ Blind at 12:15Z: the patrol could not read http:legacy-v1',
    '⚠️ Also blind at 12:30Z: the patrol could not read 2 sources',
    '✅ The patrol reads 3 sources again at 13:00Z',
  ]);
  assert.match(sent[1]!.all, /workloads, rollouts: prometheus HTTP 502/);
  assert.match(sent[2]!.all, /http:legacy-v1: blind for 45 min\\n• workloads, rollouts: blind for 30 min/);
});

test('a presence check that errors proves nothing: logs said blind are not back until a patrol shows them read', async () => {
  const c = cfg();
  const { box, texts } = webhook();
  let presence: () => Series[] = () => [];
  // Loki answers every search with no line at all; its presence count is the test's.
  class Logs extends FakeTelemetry {
    override readonly has = { loki: true, tempo: false };
    override async lokiMetric(): Promise<Series[]> {
      return presence();
    }
  }
  const tel = new Logs(world);
  const state = State.memory();
  const pass = (time: string) => patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir, box), new Date(time), { llm: false, post: true });

  await pass('2026-09-28T12:15:00Z');
  assert.deepEqual(texts(), ['⚠️ Blind at 12:15Z: the patrol could not read logs']);
  presence = () => {
    throw new SourceError('loki', 'HTTP 503: upstream unavailable');
  };
  const unknown = await pass('2026-09-28T12:30:00Z'); // the searches are still empty, and the check fails
  assert.equal(unknown.summary.sources.find((s) => s.source === 'logs')?.ok, true, 'not blind either: the source stays as read');
  assert.deepEqual(texts().slice(1), [], 'and not back: nothing shows the logs are read');
  presence = () => [{ labels: {}, points: [[Date.parse('2026-09-28T12:45:00Z') / 1000, 4200]] }];
  await pass('2026-09-28T12:45:00Z');
  assert.deepEqual(texts().slice(1), ['✅ The patrol reads logs again at 12:45Z, after 30 min blind']);
});

test('a patrol in which every Prometheus source failed is not a successful patrol; one with any of them read is', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'runs-'));
  const engine: Engine = { store: new Store(':memory:'), runsDir, stopFile: join(runsDir, 'STOP'), session: () => (async function* () {})(), dailyCapUsd: 30, llmAvailable: true };
  const result = (sources: Array<{ source: string; ok: boolean }>) => ({ summary: { sources }, cards: [] }) as unknown as PatrolResult;
  const m = new Metrics();
  const t = (iso: string) => new Date(iso);
  m.patrol(t('2026-11-02T05:00:00Z'), result([{ source: 'http:v3', ok: true }, { source: 'workloads', ok: true }, { source: 'logs', ok: true }]));
  // 11-02 05:15Z: every Prometheus-backed source failed; logs and traces were up.
  m.patrol(t('2026-11-02T05:15:00Z'), result([{ source: 'http:v3', ok: false }, { source: 'counter:sqs', ok: false }, { source: 'workloads', ok: false }, { source: 'rollouts', ok: false }, { source: 'argocd', ok: false }, { source: 'logs', ok: true }, { source: 'traces', ok: true }]));
  const text = m.render(engine);
  assert.match(text, /^engine_patrol_last_run_timestamp_seconds 1793596500$/m, 'it ran');
  assert.match(text, /^engine_patrol_last_success_timestamp_seconds 1793595600$/m, 'last success stays at 05:00');
  assert.match(text, /^engine_patrol_source_up\{source="workloads"\} 0$/m);
  m.patrol(t('2026-11-02T05:30:00Z'), result([{ source: 'http:v3', ok: false }, { source: 'workloads', ok: true }, { source: 'logs', ok: false }]));
  assert.match(m.render(engine), /^engine_patrol_last_success_timestamp_seconds 1793597400$/m, 'partly blind still counts');
  rmSync(runsDir, { recursive: true, force: true });
});

// ---- spend per agent ----------------------------------------------------------------

test("metrics: spend per agent next to the totals, which stay as they were, and the monitor's monthly share as its cap", () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'runs-'));
  const store = new Store(':memory:');
  const run = (id: string, agent: string, at: string, cost: number) => {
    store.admit({ id, agent, version: 'v', trigger: 't', now: new Date(at), deadlineMs: 60_000, reserve: cost, agentCap: 100, globalCap: 100 });
    store.settle(id, { status: 'ok', cost, turns: 1, outputs: 1, now: new Date(at) });
  };
  run('m1', 'monitor', '2026-11-01T10:00:00Z', 5);
  run('m2', 'monitor', '2026-11-04T10:00:00Z', 3);
  run('p1', 'prod', '2026-11-04T11:00:00Z', 1.5);
  run('old', 'prod', '2026-10-31T11:00:00Z', 7); // last month
  const engine: Engine = { store, runsDir, stopFile: join(runsDir, 'STOP'), session: () => (async function* () {})(), dailyCapUsd: 30, monthlyCapUsd: 250, agentMonthlyCapUsd: { monitor: 200 }, llmAvailable: true };
  const text = new Metrics().render(engine, new Date('2026-11-04T12:00:00Z'));
  const family = (name: string) => text.split('\n').filter((l) => l.startsWith(`${name}{`) || l.startsWith(`${name} `));
  assert.deepEqual(family('engine_spend_usd'), [
    'engine_spend_usd{period="day"} 4.5',
    'engine_spend_usd{period="month"} 9.5',
    'engine_spend_usd{period="day",agent="monitor"} 3',
    'engine_spend_usd{period="month",agent="monitor"} 8',
    'engine_spend_usd{period="day",agent="prod"} 1.5',
    'engine_spend_usd{period="month",agent="prod"} 1.5',
  ]);
  assert.deepEqual(family('engine_spend_cap_usd'), ['engine_spend_cap_usd{period="day"} 30', 'engine_spend_cap_usd{period="month"} 250', 'engine_spend_cap_usd{period="month",agent="monitor"} 200']);
  for (const name of ['engine_spend_usd', 'engine_spend_cap_usd']) assert.equal(text.split('\n').filter((l) => l === `# TYPE ${name} gauge`).length, 1, `${name}: one family`);
  // No run this month yet: the monitor's spend is 0, not absent.
  const fresh: Engine = { ...engine, store: new Store(':memory:') };
  assert.match(new Metrics().render(fresh, new Date('2026-11-04T12:00:00Z')), /^engine_spend_usd\{period="month",agent="monitor"\} 0$/m);
  rmSync(runsDir, { recursive: true, force: true });
});
