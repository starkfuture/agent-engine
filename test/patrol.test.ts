import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
import type { Engine } from '../src/engine/run.js';
import type { Session } from '../src/engine/session.js';
import type { FlaggedRow } from '../src/patrol/summary.js';
import { needsChallenge, patrolOnce, type MonitorAgent, patrolLoop } from '../src/runner.js';
import { fakeSession, ok, say, type Script } from './fake-session.js';
import { DAY, FakeTelemetry, H, INCIDENT_START, testConfig as cfg, world } from './fake.js';

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
  const sent: string[] = [];
  const box = new SlackOutbox(':memory:', { threads: true, post: async (m) => { sent.push(m.text); return `ts${sent.length}`; } }, { sleep: async () => {}, gapMs: 0 });
  const noise = new Noise({ never_suppress: [{ section: 'http', route: '.*(reset|signup).*', status: '4..' }] });
  const keys = ['http|backend-production|/v1/auth/password/reset|400', 'http|backend-production|/v1/auth/signup|400'];
  const session = fakeSession(
    async function* (sim) {
      assert.equal(sent.length, 1, 'the urgent card is delivered before the model starts');
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
  const r = await patrolOnce(new FakeTelemetry(world), c, noise, State.memory(), new CardSink(c.outDir, box), new Date('2026-09-29T12:15:00Z'), { llm: true, post: true }, monitor(c, session));
  assert.equal(r.investigation?.status, 'ok');
  assert.equal(r.investigation?.challenge?.verdict, 'upheld');
  assert.equal(r.cards.length, 2);
  assert.ok(r.cards[0]!.endsWith('-rows.md'), 'deterministic card first');
  assert.deepEqual(r.slack, r.cards, 'urgent rows and a critical report both go to Slack');
  assert.equal(sent.length, 2);
  assert.match(readFileSync(r.cards[1]!, 'utf8'), /Challenge: upheld/);
  assert.equal(session.requests[0]!.builtin.length, 0, 'monitor gets no built-in tools');
});

test('past its monthly share the monitor patrols without the AI, exactly as at any other cap, and the urgent rows card still goes out', async () => {
  const patrol = async (caps: Partial<Engine>) => {
    const c = cfg();
    const sent: string[] = [];
    const box = new SlackOutbox(':memory:', { threads: true, post: async (m) => { sent.push(m.text); return `ts${sent.length}`; } }, { sleep: async () => {}, gapMs: 0 });
    const session = fakeSession();
    const m = monitor(c, session);
    Object.assign(m.engine, { now: () => new Date('2026-09-29T12:15:30Z'), ...caps });
    // The monitor has spent $8 this month.
    m.engine.store.admit({ id: 'earlier', agent: 'monitor', version: 'v', trigger: 'patrol', now: new Date('2026-09-10T10:00:00Z'), deadlineMs: 60_000, reserve: 8, agentCap: 25, globalCap: 25 });
    m.engine.store.settle('earlier', { status: 'ok', cost: 8, turns: 1, outputs: 1, now: new Date('2026-09-10T10:05:00Z') });
    const r = await patrolOnce(new FakeTelemetry(world), c, new Noise({}), State.memory(), new CardSink(c.outDir, box), new Date('2026-09-29T12:15:00Z'), { llm: true, post: true }, m);
    return { r, sent, session };
  };
  const share = await patrol({ monthlyCapUsd: 250, agentMonthlyCapUsd: { monitor: 10 } });
  assert.equal(share.r.investigation?.status, 'skipped');
  assert.equal(share.r.skippedLlm, 'investigator skipped: agent monthly cap $10 reached');
  assert.equal(share.session.requests.length, 0, 'no model call');
  assert.equal(share.r.cards.length, 1);
  assert.ok(share.r.cards[0]!.endsWith('-rows.md'));
  assert.deepEqual(share.r.slack, share.r.cards, 'the urgent rows card went to Slack');
  assert.equal(share.sent.length, 1);

  const month = await patrol({ monthlyCapUsd: 10 }); // what any cap did before the share existed
  assert.equal(month.r.skippedLlm, 'investigator skipped: monthly cap $10 reached');
  assert.deepEqual(share.sent, month.sent, 'the same card, the same posts');
  assert.deepEqual(
    [share.r.filed, share.r.resolved, share.r.cards.map((f) => basename(f)), share.r.investigation?.outputs],
    [month.r.filed, month.r.resolved, month.r.cards.map((f) => basename(f)), month.r.investigation?.outputs],
  );
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
  issue: 'new',
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

test('the urgent rows card mentions the on-call only when it holds a protected journey', async () => {
  const rowsCard = async (noise: Noise, oncall?: string, owners?: Owners) => {
    const c: Config = { ...cfg(), slackOncall: oncall };
    const sent: Array<{ text: string; blocks: unknown[] }> = [];
    const box = new SlackOutbox(':memory:', { threads: true, post: async (m) => { sent.push(m); return `ts${sent.length}`; } }, { sleep: async () => {}, gapMs: 0 });
    await patrolOnce(new FakeTelemetry(world), c, noise, State.memory(), new CardSink(c.outDir, box), new Date('2026-09-29T12:15:00Z'), { llm: false, post: true, owners });
    assert.equal(sent.length, 1, 'the rows card');
    return sent[0]!;
  };
  const resetProtected = new Noise({ never_suppress: [{ section: 'http', route: '.*reset.*', status: '4..' }] });
  const paged = await rowsCard(resetProtected, '<@U0ONCALL1>');
  assert.match(paged.text, /^Patrol 2026-09-29 12:15Z: [^<]* · cc <@U0ONCALL1>$/);
  assert.match(JSON.stringify(paged.blocks), /"text":"\*Patrol 2026-09-29 12:15Z: [^"<]*\* · cc <@U0ONCALL1>"/);
  const spike = await rowsCard(new Noise({}), '<@U0ONCALL1>'); // urgent as a big spike, but nothing protected
  assert.ok(!JSON.stringify(spike).includes('U0ONCALL1'));
  const unset = await rowsCard(resetProtected);
  assert.ok(!/<[@!]/.test(JSON.stringify(unset)), 'no SLACK_ONCALL: no mention, as before');
  const owner = await rowsCard(resetProtected, '<@U0ONCALL1>', new Owners({ owners: { 'backend-*': '<@U0ONCALL1>' } }));
  assert.match(owner.text, / · cc <@U0ONCALL1>$/, 'the on-call who also owns the service is mentioned once');
});

test('Slack down: the patrol still finishes and marks its rows, and the queued card goes out next patrol', async () => {
  const c = cfg();
  const state = State.memory();
  let down = true;
  let attempts = 0;
  const sent: string[] = [];
  const box = new SlackOutbox(':memory:', { threads: true, post: async (m) => { attempts++; if (down) throw new SlackError('Slack: HTTP 503'); sent.push(m.text); return `ts${sent.length}`; } }, { sleep: async () => {}, gapMs: 0 });
  const sink = new CardSink(c.outDir, box);
  const first = await patrolOnce(new FakeTelemetry(world), c, new Noise({}), state, sink, new Date('2026-09-29T12:15:00Z'), { llm: false, post: true });
  assert.equal(first.slack.length, 1, 'the urgent rows card was queued');
  assert.deepEqual(sent, []);
  assert.equal(attempts, 1, 'a failure before the AI is not retried again at patrol finish');
  assert.deepEqual(box.status(), [{ status: 'pending', n: 1 }]);
  down = false;
  const next = await patrolOnce(new FakeTelemetry(world), c, new Noise({}), state, sink, new Date('2026-09-29T12:30:00Z'), { llm: false, post: true });
  assert.equal(next.summary.send.length, 0, 'rows were marked reported despite the outage: no repeat');
  assert.equal(sent.length, 1, 'the queued card went out');
  assert.equal(attempts, 2);
  assert.match(sent[0]!, /Patrol 2026-09-29 12:15Z/);
  assert.deepEqual(box.status(), [{ status: 'sent', n: 1 }]);
});

test('without --post nothing is queued for Slack', async () => {
  const c = cfg();
  const box = new SlackOutbox(':memory:', { threads: true, post: async () => 'ts' }, { sleep: async () => {}, gapMs: 0 });
  await patrolOnce(new FakeTelemetry(world), c, new Noise({}), State.memory(), new CardSink(c.outDir, box), new Date('2026-09-29T12:15:00Z'), { llm: false, post: false });
  assert.deepEqual(box.status(), []);
});

test('without --post pending messages stay queued on quiet and active patrols', async () => {
  for (const time of ['2026-09-28T12:15:00Z', '2026-09-29T12:15:00Z']) {
    const c = cfg();
    const sent: string[] = [];
    const box = new SlackOutbox(':memory:', { threads: true, post: async (m) => { sent.push(m.text); return 'ts'; } }, { sleep: async () => {}, gapMs: 0 });
    box.enqueue({ kind: 'rows', keys: [RESET], broadcast: true, message: { text: 'pending', blocks: [] } });
    await patrolOnce(new FakeTelemetry(world), c, new Noise({}), State.memory(), new CardSink(c.outDir, box), new Date(time), { llm: false, post: false });
    assert.deepEqual(sent, []);
    assert.deepEqual(box.status(), [{ status: 'pending', n: 1 }]);
  }
});

test('an observer outage never posts recovery, and healthy data resolves once after a restart', async () => {
  const c = cfg();
  const sent: string[] = [];
  const box = new SlackOutbox(':memory:', { threads: true, post: async (m) => { sent.push(m.text); return `ts${sent.length}`; } }, { sleep: async () => {}, gapMs: 0 });
  const sink = new CardSink(c.outDir, box);
  let state = State.load(c.stateFile);
  await patrolOnce(new FakeTelemetry(world), c, new Noise({}), state, sink, new Date('2026-09-29T12:15:00Z'), { llm: false, post: true });
  const blind = new FakeTelemetry(() => { throw new Error('observer unavailable'); });
  for (const time of ['2026-09-29T12:30:00Z', '2026-09-29T12:45:00Z']) {
    const tel = time.endsWith('45:00Z') ? new FakeTelemetry(() => []) : blind;
    const r = await patrolOnce(tel, c, new Noise({}), state, sink, new Date(time), { llm: false, post: true });
    assert.deepEqual(r.summary.recovered, [], 'missing observations cannot prove recovery');
    state = State.load(c.stateFile);
  }
  const healthy = new FakeTelemetry((q, at) => world(q, at).map(s => s.labels.route?.includes('/auth/') && s.labels.status_code === '400' ? { ...s, value: 0 } : s));
  const recovered = await patrolOnce(healthy, c, new Noise({}), state, sink, new Date('2026-09-29T13:00:00Z'), { llm: false, post: true });
  assert.deepEqual(recovered.summary.recovered.sort(), [RESET, SIGNUP].sort());
  assert.equal(sent.filter(s => s.includes('Back to normal')).length, 1);
  state = State.load(c.stateFile);
  const again = await patrolOnce(healthy, c, new Noise({}), state, sink, new Date('2026-09-29T13:15:00Z'), { llm: false, post: true });
  assert.deepEqual(again.summary.recovered, []);
});

test('a failed HTTP family does not prevent recovery observed by a healthy family', async () => {
  const c = cfg();
  c.sources.http_families.push({ id: 'other', selector: 'other_requests_total', service: 'other', route_label: 'route', status_label: 'status_code' });
  const state = State.memory();
  const answer = (q: string, at: Date) => q.includes('other_requests_total') ? world(q.replaceAll('other_requests_total', 'backend_be_production_http_requests_total'), at) : world(q, at);
  const start = new Date('2026-09-29T12:15:00Z');
  const first = await buildSummary(new FakeTelemetry(answer), c, new Noise({}), state, start);
  for (const row of first.send) state.reported(row, start);
  const next = await buildSummary(new FakeTelemetry((q, at) => {
    if (q.includes('backend_be_production_http_requests_total')) throw new Error('legacy observer down');
    return answer(q, at).map(s => s.labels.route?.includes('/auth/') && s.labels.status_code === '400' ? { ...s, value: 0 } : s);
  }), c, new Noise({}), state, new Date('2026-09-29T12:30:00Z'));
  assert.deepEqual(next.recovered.sort(), ['http|other|/v1/auth/password/reset|400', 'http|other|/v1/auth/signup|400']);
});

test('older state without collector ownership requires healthy observers before recovery', async () => {
  const c = cfg();
  const state = new State({ rows: { [RESET]: { firstSeen: '2026-09-29T12:15:00Z', lastSeen: '2026-09-29T12:15:00Z', lastReportedAt: '2026-09-29T12:15:00Z', lastReportedNow: 75 } } });
  const at = new Date('2026-09-29T12:30:00Z');
  const blind = await buildSummary(new FakeTelemetry(() => []), c, new Noise({}), state, at);
  assert.deepEqual(blind.recovered, []);
  const healthy = new FakeTelemetry((q, time) => world(q, time).map(s => s.labels.status_code === '400' ? { ...s, value: 0 } : s));
  const restarted = new State(JSON.parse(JSON.stringify(state.data)));
  const afterOutage = new Date('2026-09-29T13:00:00Z');
  assert.deepEqual((await buildSummary(healthy, c, new Noise({}), restarted, afterOutage)).recovered, [RESET]);
  assert.deepEqual((await buildSummary(healthy, c, new Noise({}), restarted, afterOutage)).recovered, []);
});

test('suppressing a still-firing signal never announces recovery', async () => {
  const c = cfg();
  const state = State.memory();
  const at = new Date('2026-09-29T12:15:00Z');
  const first = await buildSummary(new FakeTelemetry(world), c, new Noise({}), state, at);
  for (const row of first.send) state.reported(row, at);
  const noise = new Noise({ noise: [{ id: 'auth', section: 'http', route: '.*auth.*', reason: 'known issue', expires: '2027-01-01' }] });
  const next = await buildSummary(new FakeTelemetry(world), c, noise, state, new Date('2026-09-29T12:30:00Z'));
  assert.equal(next.suppressed.length, 2);
  assert.deepEqual(next.recovered, []);
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

// ---- what the investigator still owes an answer ----------------------------------

const LOGIN = 'http|backend-production|/v1/auth/login|400';

// 20 400s a window on each route from its start time: worth a look, not urgent.
const firing = (since: Record<string, string>) =>
  new FakeTelemetry((q, at) => {
    if (q.startsWith('count(kube_pod_container_status_restarts_total')) return [{ labels: {}, value: 120 }];
    if (!q.includes('backend_be_production_http_requests_total')) return [];
    return Object.entries(since).flatMap(([route, from]) => [
      { labels: { route, status_code: '200' }, value: 1000 },
      { labels: { route, status_code: '400' }, value: at.getTime() >= Date.parse(from) ? 20 : 0 },
    ]);
  });

// One investigation: notes the row keys it was asked to cover, and files a
// report (minor: recorded, not posted) on the ones `cover` picks.
function investigator(asked: string[][], cover: (rows: string[]) => string[] = (rows) => rows, severity: Report['severity'] = 'minor'): Script {
  return async function* (sim) {
    const lines = sim.req.prompt.split('\n');
    const start = lines.indexOf('Row keys to cover (copy exactly into reports):') + 1;
    const rows = lines.slice(start, lines.indexOf('', start)).map((l) => l.slice(2));
    asked.push(rows);
    if (cover(rows).length) {
      const out = await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
      const id = /evidence_id: (E-[0-9a-f]{4}-\d+)/.exec(out.text)![1]!;
      const quote = /^\S+ 400 \| [1-9]\d*/m.exec(out.text)![0];
      const r = await sim.mcp('submit_report', report({ severity, rows: cover(rows), evidence: [{ id, quote, claim: 'the route returns 400' }] }));
      assert.equal(r.isError, false, r.text);
    }
    yield ok(0.1);
  };
}

test('a 6-hour reminder of a row already explained does not join the next run', async () => {
  const c = cfg();
  const state = State.memory();
  const asked: string[][] = [];
  const m = monitor(c, fakeSession(investigator(asked), investigator(asked)));
  const tel = firing({ '/v1/auth/login': '2026-09-29T12:00:00Z', '/v1/auth/signup': '2026-09-29T18:15:00Z' });
  const pass = (time: string) => patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir), new Date(time), { llm: true, post: false }, m);
  await pass('2026-09-29T12:15:00Z');
  const later = await pass('2026-09-29T18:30:00Z'); // login is due its reminder; signup is new
  assert.ok(later.summary.send.some((r) => r.key === LOGIN && r.novelty === 'reminder'), 'still listed as ongoing on the card');
  assert.deepEqual(asked, [[LOGIN], [SIGNUP]], 'the second run covers only the new row');
});

test('rows no report covers get one more attempt, then are given up: in the log, never in Slack', async () => {
  const c = cfg();
  const state = State.memory();
  const asked: string[][] = [];
  const logs: string[] = [];
  const sent: string[] = [];
  const box = new SlackOutbox(':memory:', { threads: true, post: async (m) => (sent.push(m.text), `ts${sent.length}`) }, { sleep: async () => {}, gapMs: 0 });
  const m = monitor(c, fakeSession(investigator(asked, (rows) => rows.filter((k) => k === LOGIN)), investigator(asked, () => [])));
  const tel = firing({ '/v1/auth/login': '2026-09-29T12:00:00Z', '/v1/auth/signup': '2026-09-29T12:00:00Z' });
  const pass = (time: string) => patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir, box), new Date(time), { llm: true, post: true, log: (s) => logs.push(s) }, m);
  await pass('2026-09-29T12:15:00Z'); // the report covers login only
  assert.equal(state.data.rows[LOGIN]!.investigation?.status, 'complete');
  assert.deepEqual([state.data.rows[SIGNUP]!.investigation?.status, state.data.rows[SIGNUP]!.investigation?.attempts], ['pending', 1]);
  const retry = await pass('2026-09-29T12:30:00Z'); // nothing new, but signup is still owed an answer
  assert.equal(retry.summary.send.length, 0);
  assert.deepEqual(asked[1], [SIGNUP], 'the retry covers only the uncovered row');
  assert.deepEqual([state.data.rows[SIGNUP]!.investigation?.status, state.data.rows[SIGNUP]!.investigation?.attempts], ['gave_up', 2]);
  assert.ok(logs.includes(`gave up on 1 row(s) after 2 attempts: ${SIGNUP}`));
  const after = await pass('2026-09-29T12:45:00Z');
  assert.equal(after.investigation, undefined, 'not retried again');
  assert.equal(after.cards.length, 0, 'a quiet patrol');
  assert.deepEqual(sent, [], 'no rows were urgent and the reports were minor: no "inconclusive" notice either');
});

test('the kill switch defers the work: pressed during a run or before one, it is not an attempt', async () => {
  const c = cfg();
  const state = State.memory();
  const asked: string[][] = [];
  const stop = join(c.runsDir, 'STOP');
  const pressed: Script = async function* () {
    writeFileSync(stop, 'test'); // while the model works
    yield say();
  };
  const m = monitor(c, fakeSession(pressed, investigator(asked)));
  const tel = firing({ '/v1/auth/login': '2026-09-29T12:00:00Z' });
  const pass = (time: string) => patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir), new Date(time), { llm: true, post: false }, m);
  const during = await pass('2026-09-29T12:15:00Z');
  assert.equal(during.investigation?.status, 'stopped');
  assert.deepEqual([state.data.rows[LOGIN]!.investigation?.status, state.data.rows[LOGIN]!.investigation?.attempts], ['pending', 0]);
  const before = await pass('2026-09-29T12:30:00Z'); // still on: the run is not admitted
  assert.equal(before.investigation?.status, 'skipped');
  assert.deepEqual([state.data.rows[LOGIN]!.investigation?.status, state.data.rows[LOGIN]!.investigation?.attempts], ['pending', 0]);
  rmSync(stop);
  await pass('2026-09-29T12:45:00Z');
  assert.deepEqual(asked, [[LOGIN]]);
  assert.deepEqual([state.data.rows[LOGIN]!.investigation?.status, state.data.rows[LOGIN]!.investigation?.attempts], ['complete', 1]);
});

test('while a cap or the kill switch holds, the patrol records one skipped run, and owed rows run once it lifts', async () => {
  const c = cfg();
  const state = State.memory();
  const asked: string[][] = [];
  const logs: string[] = [];
  const m = monitor(c, fakeSession(investigator(asked)));
  const runs = () => (m.engine.store.db.prepare(`SELECT status, note FROM runs ORDER BY rowid`).all() as Array<{ status: string; note: string | null }>).map((r) => ({ status: r.status, note: r.note }));
  const tel = firing({ '/v1/auth/login': '2026-09-29T12:00:00Z', '/v1/auth/signup': '2026-09-29T12:30:00Z', '/v1/auth/password/reset': '2026-09-29T13:15:00Z' });
  const pass = (time: string) => patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir), new Date(time), { llm: true, post: false, log: (s) => logs.push(s) }, m);
  m.engine.dailyCapUsd = 0; // spent for the day
  await pass('2026-09-29T12:15:00Z');
  await pass('2026-09-29T12:30:00Z'); // a new row: its card is written, the run is still refused
  const owedOnly = await pass('2026-09-29T12:45:00Z');
  assert.deepEqual(runs(), [{ status: 'skipped', note: 'global daily cap $0 reached' }], 'one skipped run for three refused patrols');
  assert.deepEqual(owedOnly.cards, [], 'only owed rows: no card');
  assert.match(owedOnly.skippedLlm ?? '', /^deferred: global daily cap \$0 reached \(since \S+, run \S+-monitor-[0-9a-f]{6}\)$/);
  assert.ok(state.needsInvestigation(LOGIN) && state.needsInvestigation(SIGNUP), 'deferred, not attempted');
  m.engine.dailyCapUsd = 20; // the cap lifts
  const lifted = await pass('2026-09-29T13:00:00Z');
  assert.equal(lifted.investigation?.status, 'ok');
  assert.deepEqual(asked.map((rows) => [...rows].sort()), [[LOGIN, SIGNUP].sort()], 'the owed rows run as soon as it lifts');
  assert.equal(state.data.held, undefined);
  writeFileSync(join(c.runsDir, 'STOP'), 'test'); // a new hold
  await pass('2026-09-29T13:15:00Z');
  await pass('2026-09-29T13:30:00Z');
  assert.deepEqual(runs().map((r) => r.status), ['skipped', 'ok', 'skipped'], 'one skipped run for the kill switch too');
  assert.equal(logs.filter((l) => l.startsWith('deferred: kill switch is on')).length, 1);
});

test('a daily cap holds until its UTC day ends: the next day starts a new hold', async () => {
  const c = cfg();
  const m = monitor(c, fakeSession());
  m.engine.dailyCapUsd = 0;
  let clock = '2026-09-29T23:50:00Z';
  m.engine.now = () => new Date(clock);
  const tel = firing({ '/v1/auth/login': '2026-09-29T12:00:00Z' });
  const state = State.memory();
  const pass = (time: string) => patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir), new Date(time), { llm: true, post: false }, m);
  await pass('2026-09-29T12:15:00Z');
  await pass('2026-09-29T12:30:00Z');
  clock = '2026-09-30T00:05:00Z';
  await pass('2026-09-29T12:45:00Z');
  await pass('2026-09-29T13:00:00Z');
  const days = (m.engine.store.db.prepare(`SELECT day FROM runs WHERE status = 'skipped' ORDER BY rowid`).all() as Array<{ day: string }>).map((r) => r.day);
  assert.deepEqual(days, ['2026-09-29', '2026-09-30']);
});

test('a store error before admission is a deferral; a failure after it is an attempt', async () => {
  const c = cfg();
  const state = State.memory();
  const asked: string[][] = [];
  const m = monitor(c, fakeSession(investigator(asked, () => [])));
  const tel = firing({ '/v1/auth/login': '2026-09-29T12:00:00Z' });
  const pass = (time: string) => patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir), new Date(time), { llm: true, post: false }, m);
  const work = () => [state.data.rows[LOGIN]!.investigation?.status, state.data.rows[LOGIN]!.investigation?.attempts];
  const { admit, settle } = m.engine.store;
  m.engine.store.admit = () => {
    throw new Error('database is locked');
  };
  for (const time of ['2026-09-29T12:15:00Z', '2026-09-29T12:30:00Z']) assert.match((await pass(time)).skippedLlm ?? '', /^investigator crashed: database is locked/);
  assert.deepEqual(work(), ['pending', 0], 'twice locked out, still owed with no attempt spent');
  m.engine.store.admit = admit;
  m.engine.store.settle = () => {
    throw new Error('disk I/O error');
  };
  assert.match((await pass('2026-09-29T12:45:00Z')).skippedLlm ?? '', /^investigator crashed: disk I\/O error/);
  m.engine.store.settle = settle;
  assert.equal(asked.length, 1, 'the model ran');
  assert.deepEqual(work(), ['pending', 1], 'a failure after admission costs an attempt');
});

test('work still owed when a row recovers ends there: back within 6 h, it waits for its reminder, then gets fresh attempts', async () => {
  const c = cfg();
  const state = State.memory();
  const asked: string[][] = [];
  const m = monitor(c, fakeSession(investigator(asked, () => []), investigator(asked, () => [])));
  // 400s from 12:00, none from 12:20 to 12:40, then back.
  const tel = new FakeTelemetry((q, at) => {
    if (q.startsWith('count(kube_pod_container_status_restarts_total')) return [{ labels: {}, value: 120 }];
    if (!q.includes('backend_be_production_http_requests_total')) return [];
    const t = at.getTime();
    const on = t >= Date.parse('2026-09-29T12:00:00Z') && !(t >= Date.parse('2026-09-29T12:20:00Z') && t < Date.parse('2026-09-29T12:40:00Z'));
    return [{ labels: { route: '/v1/auth/login', status_code: '200' }, value: 1000 }, { labels: { route: '/v1/auth/login', status_code: '400' }, value: on ? 20 : 0 }];
  });
  const pass = (time: string) => patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir), new Date(time), { llm: true, post: false }, m);
  const work = () => [state.data.rows[LOGIN]!.investigation?.status, state.data.rows[LOGIN]!.investigation?.attempts];
  await pass('2026-09-29T12:15:00Z'); // not covered: one attempt used
  assert.deepEqual(work(), ['pending', 1]);
  assert.deepEqual((await pass('2026-09-29T12:30:00Z')).summary.recovered, [LOGIN]);
  const back = await pass('2026-09-29T12:45:00Z'); // back, not worse, 30 min after its report
  assert.equal(back.investigation, undefined, 'not retried at once');
  assert.equal(asked.length, 1);
  await pass('2026-09-29T18:30:00Z'); // its reminder
  assert.equal(asked.length, 2);
  assert.deepEqual(work(), ['pending', 1], 'a fresh allowance: one attempt used, one left');
});

test('a row reported before investigations were recorded gets one at its next reminder', async () => {
  const c = cfg();
  const asked: string[][] = [];
  const m = monitor(c, fakeSession(investigator(asked)));
  const tel = firing({ '/v1/auth/login': '2026-09-29T12:00:00Z' });
  // As the state file was saved before: reported, and nothing about an investigation.
  const reported = '2026-09-29T12:15:00.000Z';
  const state = new State({ rows: { [LOGIN]: { firstSeen: reported, lastSeen: reported, lastReportedAt: reported, lastReportedNow: 20, sources: ['http:legacy-v1'] } } });
  const pass = (time: string) => patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir), new Date(time), { llm: true, post: false }, m);
  assert.equal((await pass('2026-09-29T12:30:00Z')).investigation, undefined, 'not before its reminder');
  const reminder = await pass('2026-09-29T18:30:00Z');
  assert.deepEqual(asked, [[LOGIN]]);
  assert.equal(reminder.investigation?.status, 'ok');
  assert.equal(state.data.rows[LOGIN]!.investigation?.status, 'complete');
  assert.equal((await pass('2026-09-30T00:45:00Z')).investigation, undefined, 'explained: its next reminder stays out of runs');
});

test('a report the outbox could not queue is investigated again next patrol, as before', async () => {
  const c = cfg();
  const state = State.memory();
  const asked: string[][] = [];
  const box = new SlackOutbox(':memory:', { threads: true, post: async () => 'ts' }, { sleep: async () => {}, gapMs: 0 });
  const { enqueue } = box;
  box.enqueue = () => {
    throw new Error('database is locked');
  };
  const m = monitor(c, fakeSession(investigator(asked, undefined, 'major'), investigator(asked, undefined, 'major')));
  const tel = firing({ '/v1/auth/login': '2026-09-29T12:00:00Z' });
  const pass = (time: string) => patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir, box), new Date(time), { llm: true, post: true }, m);
  await assert.rejects(pass('2026-09-29T12:15:00Z'), /database is locked/);
  box.enqueue = enqueue;
  const again = await pass('2026-09-29T12:30:00Z');
  assert.equal(asked.length, 2, 'investigated again');
  assert.equal(again.slack.length, 1, 'and this time its report is queued');
  assert.equal(state.data.rows[LOGIN]!.investigation?.status, 'complete');
});

test('rows that share a key (same-named workloads in two namespaces) spend one attempt per run, not two', () => {
  const state = State.memory();
  const row = { key: 'workload|api|restarts api|', section: 'workload', service: 'api', subject: 'restarts api', counts: { now: 3, h1: 0, d1: 0, d7: 0 }, score: { verdict: 'spike', expected: 0, z: 9, trend: 'started' } } as unknown as FlaggedRow;
  state.seen(row, new Date('2026-09-29T12:15:00Z'), ['workloads']);
  assert.deepEqual(state.investigated([row, { ...row }], new Set(), 'no_output', true), []);
  assert.deepEqual([state.data.rows[row.key]!.investigation?.status, state.data.rows[row.key]!.investigation?.attempts], ['pending', 1]);
});

// ---- error counters and the summary ----------------------------------------------

test('an error counter is blind while its services are not scraped', async () => {
  const c = cfg();
  c.sources.error_counters.push({ id: 'sqs', selector: '{__name__=~".+_sqs_message_errors_total"}', group_by: ['app', 'queue'], presence: 'up{job="svc"} == 1' });
  // No consumer errors in either case: the counter has no series.
  const up = (n: number) => new FakeTelemetry((q, at) => (q === 'count(up{job="svc"} == 1)' ? (n ? [{ labels: {}, value: n }] : []) : world(q, at)));
  const source = async (n: number) => (await buildSummary(up(n), c, new Noise({}), State.memory(), new Date('2026-09-28T12:15:00Z'))).sources.find((s) => s.source === 'counter:sqs');
  assert.deepEqual(await source(3), { source: 'counter:sqs', ok: true });
  assert.match((await source(0))?.error ?? '', /^no live scrape target series for up\{job="svc"\} == 1 \(missing data, not a quiet system\)$/);
});

test("the shipped SQS counter reads every service's consumer errors, and checks the services are up", async () => {
  const { loadConfig } = await import('../src/config.js');
  const sqs = loadConfig({}).sources.error_counters.find((x) => x.id === 'sqs-consumer-errors')!;
  const name = new RegExp(`^(?:${/__name__=~"([^"]+)"/.exec(sqs.selector)![1]})$`); // PromQL regexes are anchored
  for (const metric of ['erp_broker_svc_sqs_message_errors_total', 'app_svc_sqs_message_errors_total']) assert.match(metric, name);
  assert.deepEqual(sqs.group_by, ['app', 'queue', 'error_type']);
  assert.match(sqs.presence ?? '', /^up\{.+\} == 1$/);
});
