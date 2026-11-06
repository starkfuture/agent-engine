import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { loadAgent } from '../src/engine/agent.js';
import { Evidence } from '../src/engine/evidence.js';
import type { Session } from '../src/engine/session.js';
import { Store } from '../src/engine/store.js';
import type { Report } from '../src/investigate/report.js';
import { monitorTools } from '../src/investigate/tools.js';
import { reportCard } from '../src/output/card.js';
import { CardSink } from '../src/output/sink.js';
import { SlackOutbox } from '../src/output/slack.js';
import { stallQuery, tagOf } from '../src/patrol/deploys.js';
import { bucketOf, tier } from '../src/patrol/digest.js';
import { Noise } from '../src/patrol/noise.js';
import { State } from '../src/patrol/state.js';
import { buildSummary, renderSummary } from '../src/patrol/summary.js';
import { patrolOnce, urgent, type MonitorAgent } from '../src/runner.js';
import { fakeSession, ok } from './fake-session.js';
import { cluster, ECR, FakeTelemetry, MIN, testConfig as cfg, world, type Rollout } from './fake.js';

const AT = new Date('2026-11-03T12:30:00Z');
const ECOM: Rollout = {
  workload: 'ecom-service-production',
  rs: 'ecom-service-production-7566f689c8',
  created: Date.parse('2026-11-03T12:16:58Z'),
  image: `${ECR}/ecom-service:1.2645.6`,
  prevRs: 'ecom-service-production-5d4b9c7f88',
  prev: `${ECR}/ecom-service:1.2645.5`,
};
// Keycloak is pinned by digest: its pods' image label is a bare sha256, image_spec keeps the tag.
const KEYCLOAK: Rollout = {
  workload: 'keycloak-production',
  rs: 'keycloak-production-6c9f7b8d54',
  created: Date.parse('2026-11-03T11:02:10Z'),
  done: Date.parse('2026-11-03T11:09:30Z'),
  image: `${ECR}/keycloak:40306405610@sha256:d40dc2f1a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e`,
  prevRs: 'keycloak-production-58f6d9c7b2',
  prev: `${ECR}/keycloak:40306405609@sha256:c80fc98a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6`,
};
// One deploy's stall: the key carries its namespace and ReplicaSet's pod-template-hash.
const STALLED = 'rollout|ecom-service-production|stalled|microservices/7566f689c8';

const outbox = () => {
  const sent: Array<{ text: string; blocks: unknown[] }> = [];
  const box = new SlackOutbox(':memory:', { threads: true, post: async (m) => { sent.push(m); return `ts${sent.length}`; } }, { sleep: async () => {}, gapMs: 0 });
  return { sent, box };
};

function monitor(c: Config, session: Session): MonitorAgent {
  return {
    engine: { store: new Store(join(c.runsDir, 'engine.db')), runsDir: c.runsDir, stopFile: join(c.runsDir, 'STOP'), session, dailyCapUsd: 20, llmAvailable: true },
    agent: loadAgent(join(c.agentsDir, 'monitor')),
  };
}

test('scaling is not a deploy: a generation bump without a new ReplicaSet lists nothing and flags nothing', async () => {
  // The HPA scaled ecom-service: its generation moved 9 times, no ReplicaSet was created.
  const scaled = new FakeTelemetry((q, at) => (q.includes('kube_deployment_status_observed_generation') ? [{ labels: { namespace: 'microservices', deployment: ECOM.workload }, value: 9 }] : world(q, at)));
  const s = await buildSummary(scaled, cfg(), new Noise({}), State.memory(), AT);
  assert.deepEqual(s.deploys.deploys, []);
  assert.deepEqual(s.send, []);
  assert.match(renderSummary(s), /\n## Deploys in the last 6 h \(new ReplicaSets; scaling is not a deploy\)\n- none(\n|$)/);
  assert.doesNotMatch(renderSummary(s), /generation/i);
  assert.ok(s.sources.find((x) => x.source === 'rollouts')?.ok);
});

test('a new ReplicaSet is a deploy: the image before and after from image_spec, and how long the rollout took', async () => {
  const s = await buildSummary(cluster([{ ...ECOM, done: ECOM.created + 4 * MIN }]), cfg(), new Noise({}), State.memory(), AT);
  const [d] = s.deploys.deploys;
  assert.deepEqual([d?.workload, d?.replicaset, d?.previous, d?.image, d?.state, d?.minutes], [ECOM.workload, ECOM.rs, ECOM.prev, ECOM.image, 'complete', 4]);
  assert.match(renderSummary(s), /\n- 12:16Z microservices\/ecom-service-production: 1\.2645\.5 → 1\.2645\.6 · complete in 4 min\n/);
  assert.deepEqual(s.send, [], 'a finished deploy is context, not a row');
});

test('a digest-pinned image shows its tag, in the deploy list and in workload_state', async () => {
  const c = cfg();
  const base = (q: string, at: Date) => (q.startsWith('count by (image_spec) (kube_pod_container_info') ? [{ labels: { image_spec: KEYCLOAK.image }, value: 3 }] : world(q, at));
  const tel = cluster([KEYCLOAK], base);
  const s = await buildSummary(tel, c, new Noise({}), State.memory(), AT);
  assert.match(renderSummary(s), /- 11:02Z microservices\/keycloak-production: 40306405609 → 40306405610 · complete in 8 min/);
  const tools = monitorTools(tel, c, AT)(new Evidence(), 'author');
  const state = await tools.find((t) => t.name === 'workload_state')!.handler({ workload: 'keycloak-production' } as never, {});
  assert.match((state.content[0] as { text: string }).text, /images: \S*keycloak:40306405610@sha256:d40dc2\S* ×3/);
  assert.equal(tagOf(`${ECR}/keycloak@sha256:c80fc98a1b2c3d4e5f60718293a4b5c6`), 'keycloak@sha256:c80fc98a1b2c', 'no tag: the name and a short digest');
});

test('a deploy on its own never posts: listed for the AI, no row, no card, no AI run, while rolling or done', async () => {
  const c = cfg();
  const { sent, box } = outbox();
  const session = fakeSession();
  const tel = cluster([KEYCLOAK, { ...ECOM, created: AT.getTime() - 6 * MIN }]); // keycloak done, ecom rolling for 6 min
  const r = await patrolOnce(tel, c, new Noise({}), State.memory(), new CardSink(c.outDir, box), AT, { llm: true, post: true }, monitor(c, session));
  assert.match(renderSummary(r.summary), /keycloak-production: 40306405609 → 40306405610 · complete in 8 min\n- 12:24Z microservices\/ecom-service-production: 1\.2645\.5 → 1\.2645\.6 · rolling for 6 min/);
  assert.deepEqual([r.summary.send, r.cards, sent, session.requests.length, r.investigation], [[], [], [], 0, undefined]);
});

test('an urgent rollout row is challenged by the gate, whatever the report says (a minor one too)', async () => {
  const c = cfg();
  const { box } = outbox();
  const session = fakeSession(
    async function* (sim) {
      const out = await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
      const id = /evidence_id: (E-[0-9a-f]{4}-\d+)/.exec(out.text)![1]!;
      const quote = /\/v1\/products \d+ \| \d+/.exec(out.text)![0];
      const r = await sim.mcp('submit_report', { title: 'ecom-service rollout is stuck', severity: 'minor', status: 'active', started_at: 'unknown', what_broke: 'new pods are not ready', impact: 'unknown', cause: { hypothesis: 'a failing readiness probe', confidence: 'low' }, evidence: [{ id, quote, claim: 'traffic is still served' }], suggested_fix: 'check the new pods', not_checked: [], rows: [STALLED], issue: 'new' });
      assert.equal(r.isError, false, r.text);
      yield ok(0.1);
    },
    async function* (sim) {
      await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
      await sim.mcp('submit_challenge', { objections: [], items: [{ item: 1, holds: 'yes', reason: 'The rollout is stuck.' }], overall: 'Holds up.' });
      yield ok(0.1);
    },
  );
  const r = await patrolOnce(cluster([ECOM]), c, new Noise({}), State.memory(), new CardSink(c.outDir, box), AT, { llm: true, post: true }, monitor(c, session));
  assert.deepEqual(r.summary.send.map((x) => x.key), [STALLED]);
  assert.equal(session.requests[1]?.model, 'claude-opus-5-5', 'the challenger ran');
  assert.equal(r.investigation?.challenge?.verdict, 'upheld');
});

test('replicas behind for 10 min are an urgent rollout row, posted by code, and "rollout complete" in its thread once it completes', async () => {
  const c = cfg();
  const { sent, box } = outbox();
  const sink = new CardSink(c.outDir, box);
  const state = State.memory();
  const tel = cluster([{ ...ECOM, done: Date.parse('2026-11-03T12:41:00Z') }]);
  const pass = (iso: string) => patrolOnce(tel, c, new Noise({}), state, sink, new Date(iso), { llm: false, post: true });

  const rolling = await pass('2026-11-03T12:15:00Z'); // created 12:16:58: not yet
  assert.deepEqual([rolling.summary.send, sent], [[], []]);
  const stalled = await pass('2026-11-03T12:30:00Z');
  assert.deepEqual(stalled.summary.send.map((r) => r.key), [STALLED]);
  const row = stalled.summary.send[0]!;
  assert.ok(urgent(row, new Noise({})));
  assert.deepEqual([tier(row, false), bucketOf(row, c.attentionFloor, false)], [1, 'look'], 'ranked with outages, never quiet');
  assert.match(row.detail ?? '', /^2 replica\(s\) not on the new version for 10\+ min \(ns microservices\)$/);
  assert.match(row.query ?? '', /min_over_time\(\(kube_deployment_spec_replicas\{namespace=~"microservices"\} - kube_deployment_status_replicas_updated\{namespace=~"microservices"\}\)\[10m:1m\]\)/);
  assert.match(renderSummary(stalled.summary), /ecom-service-production: 1\.2645\.5 → 1\.2645\.6 · STALLED \(13 min since it started\)/);
  assert.equal(sent.length, 1, 'the rows card, before and without the AI');
  assert.match(JSON.stringify(sent[0]!.blocks), /\*ecom-service-production\* · rollout `stalled microservices\/7566f689c8`/);

  const still = await pass('2026-11-03T12:37:00Z');
  assert.deepEqual([still.summary.known.map((r) => r.key), sent.length], [[STALLED], 1], 'still stalled: not posted again');
  const done = await pass('2026-11-03T12:45:00Z');
  assert.deepEqual(done.summary.recovered, [STALLED]);
  assert.match(renderSummary(done.summary), /ecom-service-production: 1\.2645\.5 → 1\.2645\.6 · complete in 24 min/);
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.text, /^✅ Back to normal at 12:45Z: ecom-service-production · rollout complete$/);
});

test('a stall ends only when its rollout completes: every pod updated but not yet available is not "rollout complete"', async () => {
  const c = cfg();
  const { sent, box } = outbox();
  const sink = new CardSink(c.outDir, box);
  const state = State.memory();
  // Replicas behind until 12:35, then every pod on the new template but not all available until 12:55.
  const tel = cluster([{ ...ECOM, updated: Date.parse('2026-11-03T12:35:00Z'), done: Date.parse('2026-11-03T12:55:00Z') }]);
  const pass = (iso: string) => patrolOnce(tel, c, new Noise({}), state, sink, new Date(iso), { llm: false, post: true });
  assert.deepEqual((await pass('2026-11-03T12:30:00Z')).summary.send.map((r) => r.key), [STALLED]);
  const ready = await pass('2026-11-03T12:45:00Z');
  assert.deepEqual([ready.summary.recovered, ready.summary.known.map((r) => r.key)], [[], [STALLED]]);
  assert.match(ready.summary.known[0]!.detail ?? '', /^still not complete: 2 replica\(s\) to update, become available or retire \(ns microservices\)$/);
  assert.ok(!sent.some((m) => /rollout complete/.test(m.text)));
  const done = await pass('2026-11-03T13:00:00Z');
  assert.deepEqual(done.summary.recovered, [STALLED]);
  assert.match(sent.at(-1)!.text, /Back to normal at 13:00Z: ecom-service-production · rollout complete$/);
  // A row from an old episode (not seen for 6 h+) does not hold a scale-up as a stall.
  const old = new State({ rows: { [STALLED]: { firstSeen: '2026-11-03T05:00:00.000Z', lastSeen: '2026-11-03T05:00:00.000Z', lastReportedAt: '2026-11-03T05:00:00.000Z' } } });
  assert.deepEqual((await buildSummary(tel, c, new Noise({}), old, new Date('2026-11-03T12:45:00Z'))).send, []);
});

test('a one-replica rollout is not complete while its old pod still serves', async () => {
  // The new pod counts as updated while unready, and the old ready pod keeps available at 1.
  const rolling = await buildSummary(cluster([{ ...ECOM, oneReplica: true, created: AT.getTime() - 5 * MIN }]), cfg(), new Noise({}), State.memory(), AT);
  assert.match(renderSummary(rolling), /ecom-service-production: 1\.2645\.5 → 1\.2645\.6 · rolling for 5 min/);
  const done = await buildSummary(cluster([{ ...ECOM, oneReplica: true, created: AT.getTime() - 5 * MIN, done: AT.getTime() - MIN }]), cfg(), new Noise({}), State.memory(), AT);
  assert.match(renderSummary(done), /ecom-service-production: 1\.2645\.5 → 1\.2645\.6 · complete in 4 min/);
});

test('a Deployment created minutes ago is not stalled: the stall needs a sample in every minute of it', async () => {
  const fresh: Rollout = { ...ECOM, brandNew: true, prevRs: '', prev: '', created: AT.getTime() - 3 * MIN };
  const s = await buildSummary(cluster([fresh]), cfg(), new Noise({}), State.memory(), AT);
  assert.deepEqual(s.send, []);
  assert.match(renderSummary(s), /ecom-service-production: 1\.2645\.6 \(previous image not seen\) · rolling for 3 min/);
  assert.match(stallQuery(cfg().sources), / and on \(namespace, deployment\) max by \(namespace, deployment\) \(count_over_time\(\(kube_deployment_spec_replicas\{namespace=~"microservices"\} - kube_deployment_status_replicas_updated\{namespace=~"microservices"\}\)\[10m:1m\]\)\) >= 10 or on /);
});

test('without kube-state-metrics, deploys are unknown, never "none": in the summary and in recent_changes', async () => {
  const gone = new FakeTelemetry(() => []);
  const s = await buildSummary(gone, cfg(), new Noise({}), State.memory(), AT);
  assert.match(renderSummary(s), /\n## Deploys in the last 6 h \(new ReplicaSets; scaling is not a deploy\)\n- unknown: deployment metrics missing \(no kube_replicaset_created series\)\n/);
  const tools = monitorTools(gone, cfg(), AT)(new Evidence(), 'author');
  const out = (await tools.find((t) => t.name === 'recent_changes')!.handler({ hours: 24 } as never, {})).content[0] as { text: string };
  assert.match(out.text, /- unknown: deployment metrics missing/);
  assert.doesNotMatch(out.text, /- none/);
});

test("a stall on the next deploy is a new row, urgent again after the first one recovered; one that goes on stays one row", async () => {
  const c = cfg();
  const { sent, box } = outbox();
  const sink = new CardSink(c.outDir, box);
  const state = State.memory();
  const NEXT: Rollout = { workload: ECOM.workload, rs: 'ecom-service-production-6b8d4c9f72', created: Date.parse('2026-11-03T12:58:00Z'), image: `${ECR}/ecom-service:1.2645.7`, prevRs: ECOM.rs, prev: ECOM.image };
  const tel = cluster([{ ...ECOM, done: Date.parse('2026-11-03T12:41:00Z') }, NEXT]);
  const pass = (iso: string) => patrolOnce(tel, c, new Noise({}), state, sink, new Date(iso), { llm: false, post: true });
  assert.deepEqual((await pass('2026-11-03T12:30:00Z')).summary.send.map((r) => r.key), [STALLED]);
  assert.deepEqual((await pass('2026-11-03T12:45:00Z')).summary.recovered, [STALLED]);
  assert.deepEqual((await pass('2026-11-03T13:00:00Z')).summary.send, [], 'the next deploy rolling for 2 min');
  const again = await pass('2026-11-03T13:15:00Z');
  assert.deepEqual(again.summary.send.map((r) => [r.key, r.novelty]), [['rollout|ecom-service-production|stalled|microservices/6b8d4c9f72', 'fresh']]);
  assert.equal(sent.length, 3, 'rows card, recovery, and the second stall\'s rows card');
  assert.match(JSON.stringify(sent[2]!.blocks), /rollout `stalled microservices\/6b8d4c9f72`/);
  const still = await pass('2026-11-03T13:30:00Z');
  assert.deepEqual([still.summary.known.map((r) => r.key), sent.length], [['rollout|ecom-service-production|stalled|microservices/6b8d4c9f72'], 3], 'still stalled: one row, not posted again');
});

test('a stalled Deployment whose series disappear is unknown, not complete: it does not recover', async () => {
  const c = cfg();
  const state = State.memory();
  // ecom's status series stop at 12:40; kube-state-metrics still serves every other Deployment.
  const tel = cluster([{ ...ECOM, gone: Date.parse('2026-11-03T12:40:00Z') }]);
  await patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir), AT, { llm: false, post: false });
  const later = await buildSummary(tel, c, new Noise({}), state, new Date('2026-11-03T12:45:00Z'));
  assert.deepEqual([later.recovered, later.known.map((r) => [r.key, r.detail])], [[], [[STALLED, 'rollout state unknown: no kube-state-metrics series for this Deployment now (ns microservices)']]]);
  assert.ok(later.sources.find((x) => x.source === 'rollouts')?.ok, 'the source is healthy: the rest of the cluster is read');
});

test('deploy history keeps a deploy whose ReplicaSet was garbage collected within the window', async () => {
  // Deployed at 10:00, its ReplicaSet collected at 12:00 (revisionHistoryLimit): still a deploy of the last 6 h.
  const early: Rollout = { ...ECOM, created: Date.parse('2026-11-03T10:00:00Z'), done: Date.parse('2026-11-03T10:04:00Z'), gc: Date.parse('2026-11-03T12:00:00Z') };
  const tel = cluster([early]);
  const s = await buildSummary(tel, cfg(), new Noise({}), State.memory(), AT);
  assert.deepEqual(s.deploys.deploys.map((d) => [d.replicaset, d.at]), [[ECOM.rs, '2026-11-03T10:00:00.000Z']]);
  assert.match(tel.calls.find((q) => q.includes('kube_replicaset_created') && q.includes('time()'))!, /last_over_time\(kube_replicaset_created\{namespace=~"microservices"\}\[360m\]\).*last_over_time\(kube_replicaset_owner\{namespace=~"microservices",owner_kind="Deployment"\}\[360m\]\)/);
});

test("a one-replica rollout stalls only by the controller's deadline, and that is a row too", async () => {
  const s = await buildSummary(cluster([{ ...ECOM, oneReplica: true }]), cfg(), new Noise({}), State.memory(), AT);
  assert.deepEqual(s.send.map((r) => [r.key, r.detail]), [[STALLED, 'the controller gave up on it: Progressing ProgressDeadlineExceeded (ns microservices)']]);
  assert.match(s.send[0]!.query ?? '', / or on \(namespace, deployment\) max by \(namespace, deployment, reason\) \(kube_deployment_status_condition\{namespace=~"microservices",condition="Progressing",status="false"\}\) == 1$/);
});

test('a stalled rollout never "completes" because kube-state-metrics went away: that is a blind spot', async () => {
  const c = cfg();
  const state = State.memory();
  const stalled = cluster([ECOM]);
  await patrolOnce(stalled, c, new Noise({}), state, new CardSink(c.outDir), AT, { llm: false, post: false });
  const gone = new FakeTelemetry(() => []); // kube-state-metrics (and everything else) answers nothing
  const s = await buildSummary(gone, c, new Noise({}), state, new Date(AT.getTime() + 15 * MIN));
  assert.deepEqual(s.recovered, []);
  assert.match(s.sources.find((x) => x.source === 'rollouts')?.error ?? '', /^no kube-state-metrics deployment series/);
});

test('a deploy rolled back to its older ReplicaSet says so, not "complete"', async () => {
  const s = await buildSummary(cluster([{ ...ECOM, done: ECOM.created + 4 * MIN, back: ECOM.created + 10 * MIN }]), cfg(), new Noise({}), State.memory(), AT);
  assert.match(renderSummary(s), /ecom-service-production: 1\.2645\.5 → 1\.2645\.6 · rolled back: 1\.2645\.5 runs again/);
});

test('rows first flagged after their service deployed say so, and posted cards carry one deploys line', async () => {
  const c = cfg();
  const { sent, box } = outbox();
  const BACKEND: Rollout = {
    workload: 'backend-production',
    rs: 'backend-production-6d8f9b7c54',
    created: Date.parse('2026-09-29T11:58:00Z'),
    done: Date.parse('2026-09-29T12:03:00Z'),
    image: `${ECR}/backend:2.2645.0`,
    prevRs: 'backend-production-7b9c5d4f86',
    prev: `${ECR}/backend:2.2644.9`,
  };
  // A quarter of the 29 Sep incident: above the floor, not urgent, so the AI decides what is posted.
  const smaller = (q: string, at: Date) => world(q, at).map((x) => (/^4/.test(x.labels.status_code ?? '') && x.labels.route !== '/v1/products' ? { ...x, value: Math.round(x.value / 4) } : x));
  const rows = ['http|backend-production|/v1/auth/password/reset|400', 'http|backend-production|/v1/auth/signup|400'];
  const session = fakeSession(async function* (sim) {
    const out = await sim.mcp('recent_changes', { hours: 2 });
    assert.match(out.text, /11:58Z microservices\/backend-production: 2\.2644\.9 → 2\.2645\.0 · complete in 5 min/, 'recent_changes reads ReplicaSets');
    const id = /evidence_id: (E-[0-9a-f]{4}-\d+)/.exec(out.text)![1]!;
    const r = await sim.mcp('submit_report', report({ evidence: [{ id, quote: '2.2644.9 → 2.2645.0', claim: 'backend-production was deployed at 11:58Z' }], rows }));
    assert.equal(r.isError, false, r.text);
    yield ok(0.3, 4);
  }, async function* (sim) {
    // The second check agrees: only then is a major report posted.
    await sim.mcp('recent_changes', { hours: 2 });
    await sim.mcp('submit_challenge', { objections: [], overall: 'Holds up.' });
    yield ok(0.1, 1);
  });
  const r = await patrolOnce(cluster([BACKEND], smaller), c, new Noise({}), State.memory(), new CardSink(c.outDir, box), new Date('2026-09-29T12:15:00Z'), { llm: true, post: true }, monitor(c, session));
  const after = 'first flagged 17 min after deploy backend-production 2.2645.0 (11:58Z)';
  assert.deepEqual(r.summary.send.map((x) => x.afterDeploy), [after, after]);
  assert.match(renderSummary(r.summary), new RegExp(`password/reset 400: .* \\| ${after.replace(/[().]/g, '\\$&')}\\n`));
  const line = 'Deploys in the last 2 h: backend-production 2.2645.0 (11:58Z, complete)';
  const rowsCard = readFileSync(r.cards[0]!, 'utf8');
  assert.ok(rowsCard.includes(after) && rowsCard.includes(`_${line}_`), rowsCard);
  assert.ok(readFileSync(r.cards[1]!, 'utf8').includes(`_${line}_`), 'the AI report card');
  assert.equal(sent.length, 1, 'only the report is posted: the deploy adds a line, never a post');
  assert.ok(JSON.stringify(sent[0]!.blocks).includes(line));
});

test('a keycloak row maps to the keycloak-production Deployment; a deploy of another service or after the row is not its cause', async () => {
  const c = cfg();
  const token = (status: string, value: number) => ({ labels: { uri: '/auth/realms/x/token', status }, value });
  const tel = cluster([KEYCLOAK, { ...ECOM, done: ECOM.created + 4 * MIN }], (q, at) => (q.includes('http_server_requests_seconds_count') ? [token('200', 900), ...(at.getTime() === AT.getTime() ? [token('503', 40)] : [])] : world(q, at)));
  c.sources.http_families = [{ id: 'keycloak', selector: 'http_server_requests_seconds_count{job="keycloak-production"}', service: 'keycloak', route_label: 'uri', status_label: 'status' }];
  const s = await buildSummary(tel, c, new Noise({}), State.memory(), AT);
  assert.deepEqual(s.send.map((r) => [r.service, r.afterDeploy]), [['keycloak', 'first flagged 88 min after deploy keycloak-production 40306405610 (11:02Z)']]);
  // The same row first flagged before keycloak's deploy: no suffix.
  const early = new State({ rows: { [s.send[0]!.key]: { firstSeen: '2026-11-03T10:45:00.000Z', lastSeen: '2026-11-03T10:45:00.000Z' } } });
  assert.equal((await buildSummary(tel, c, new Noise({}), early, AT)).send[0]?.afterDeploy, undefined);
});

test('the report card carries the deploys line it is given, in the file and in Slack', () => {
  const card = reportCard(report(), '2026-09-29T12:15:00Z', 'footer', undefined, [], undefined, 'Deploys in the last 2 h: auth-service-production 1.2645.6 (12:05Z, complete)');
  assert.match(card.markdown, /\n_Deploys in the last 2 h: auth-service-production 1\.2645\.6 \(12:05Z, complete\)_\n/);
  assert.match(JSON.stringify(card.blocks), /"type":"context","elements":\[\{"type":"mrkdwn","text":"Deploys in the last 2 h: auth-service-production 1\.2645\.6 \(12:05Z, complete\)"\}\]/);
  assert.doesNotMatch(reportCard(report(), '2026-09-29T12:15:00Z', 'footer').markdown, /Deploys/);
});

test('Argo CD: off reads nothing and reports no blind spot; on, a degraded app and a failed sync are urgent rows, the first sync of a phase counts but not a counter that only became visible, and a missing scrape is blind', async () => {
  const off = cluster([]);
  const s = await buildSummary(off, cfg(), new Noise({}), State.memory(), AT);
  assert.ok(!off.calls.some((q) => q.includes('argocd')));
  assert.deepEqual(s.sources.find((x) => x.source === 'argocd'), { source: 'argocd', ok: false, error: 'not configured (deploys.argocd: false)', disabled: true }, 'listed as off');

  const c = cfg();
  c.sources.deploys.argocd = true;
  const app = { name: ECOM.workload, project: 'project-production', dest_namespace: 'microservices', sync_status: 'Synced' };
  const argo = (q: string, at: Date) => {
    if (q.startsWith('count(argocd_app_info')) return [{ labels: {}, value: 232 }];
    if (q.startsWith('count_over_time(argocd_app_info')) return [{ labels: { ...app, health_status: 'Degraded' }, value: 5 }];
    // A counter that only became visible (the scrape began after the window's start) is not a sync in the window:
    // web-admin's 7 failures and frontend-next's 48 syncs since the controller started.
    const visibleOnly = !q.includes(' and on (name) argocd_app_info offset ');
    if (q.startsWith('max by (name, phase) (argocd_app_sync_total{phase=~"Error|Failed"})')) return [{ labels: { name: ECOM.workload, phase: 'Failed' }, value: 3 }];
    if (q.includes('argocd_app_sync_total{phase=~"Error|Failed"}'))
      return [{ labels: { name: ECOM.workload, phase: 'Failed' }, value: 1 }, ...(visibleOnly ? [{ labels: { name: 'web-admin-production', phase: 'Failed' }, value: 7 }] : [])];
    if (q.startsWith('count by (name, sync_status, health_status)')) return [{ labels: { ...app, health_status: 'Degraded' }, value: 1 }];
    // The context's syncs: ecom failed again; keycloak synced for the first time since the controller started (a new series).
    if (q.startsWith('(sum by (name, phase) (increase(argocd_app_sync_total{}[360m])) > 0'))
      return [
        { labels: { name: ECOM.workload, phase: 'Failed' }, value: 1 },
        ...(q.includes(' unless argocd_app_sync_total{} offset 360m') ? [{ labels: { name: 'keycloak-production', phase: 'Succeeded' }, value: 1 }] : []),
        ...(visibleOnly ? [{ labels: { name: 'frontend-next-production', phase: 'Succeeded' }, value: 48 }] : []),
      ];
    return world(q, at);
  };
  const on = await buildSummary(cluster([], argo), c, new Noise({}), State.memory(), AT);
  assert.deepEqual(on.send.map((r) => r.key).sort(), ['rollout|ecom-service-production|argocd app|Degraded', 'rollout|ecom-service-production|argocd sync|Failed #3']);
  assert.ok(on.send.every((r) => urgent(r, new Noise({}))));
  assert.match(renderSummary(on), /- Argo CD apps not Synced and Healthy now: ecom-service-production Synced\/Degraded\n- Argo CD syncs in the last 6 h: ecom-service-production Failed ×1, keycloak-production Succeeded ×1\n/);
  // argocd_app_sync_total has no dest_namespace: it is matched to the apps by name.
  const failed = on.send.find((r) => r.subject === 'argocd sync')!.query!;
  assert.match(failed, /\) and on \(name\) argocd_app_info\{dest_namespace=~"microservices"\}$/);
  assert.match(failed, /unless argocd_app_sync_total\{phase=~"Error\|Failed"\} offset 15m\) and on \(name\) argocd_app_info offset 15m\)/, "an app's first failure is a new series, if the app was scraped at the window's start");
  assert.ok(![...failed.matchAll(/argocd_app_sync_total\{([^}]*)\}/g)].some((m) => m[1]!.includes('dest_namespace')));

  const blind = await buildSummary(cluster([]), c, new Noise({}), State.memory(), AT);
  assert.match(blind.sources.find((x) => x.source === 'argocd')?.error ?? '', /^no Argo CD app series/);
});

test('each failed Argo CD sync is its own row: a second failure soon after the first recovered is posted again', async () => {
  const c = cfg();
  c.sources.deploys.argocd = true;
  const { sent, box } = outbox();
  const sink = new CardSink(c.outDir, box);
  const state = State.memory();
  // ecom's sync fails at 12:25 (the 1st failure since the controller started) and again at 13:10 (the 2nd).
  const failures = (t: number) => (t >= Date.parse('2026-11-03T13:10:00Z') ? 2 : t >= Date.parse('2026-11-03T12:25:00Z') ? 1 : 0);
  const inWindow = (t: number) => failures(t) > failures(t - 15 * MIN);
  const argo = (q: string, at: Date) => {
    const t = at.getTime();
    if (q.startsWith('count(argocd_app_info')) return [{ labels: {}, value: 232 }];
    if (q.startsWith('max by (name, phase) (argocd_app_sync_total{phase=~"Error|Failed"})')) return failures(t) ? [{ labels: { name: ECOM.workload, phase: 'Failed' }, value: failures(t) }] : [];
    if (q.includes('argocd_app_sync_total{phase=~"Error|Failed"}')) return inWindow(t) ? [{ labels: { name: ECOM.workload, phase: 'Failed' }, value: 1 }] : [];
    return world(q, at);
  };
  const pass = (iso: string) => patrolOnce(cluster([], argo), c, new Noise({}), state, sink, new Date(iso), { llm: false, post: true });
  assert.deepEqual((await pass('2026-11-03T12:30:00Z')).summary.send.map((r) => r.key), ['rollout|ecom-service-production|argocd sync|Failed #1']);
  assert.deepEqual((await pass('2026-11-03T12:45:00Z')).summary.recovered, ['rollout|ecom-service-production|argocd sync|Failed #1']);
  const again = await pass('2026-11-03T13:15:00Z');
  assert.deepEqual(again.summary.send.map((r) => [r.key, r.novelty]), [['rollout|ecom-service-production|argocd sync|Failed #2', 'fresh']]);
  assert.equal(sent.length, 3, 'rows card, recovery, and the second failure\'s rows card');
  assert.match(again.summary.send[0]!.detail ?? '', /\(Failed #2 since the controller started\)$/);
});

test('same-named Deployments in two namespaces are two stalls, and each completes on its own', async () => {
  const c = cfg();
  c.sources.workloads.namespaces = 'microservices|backend.*';
  const state = State.memory();
  // A same-named Deployment in namespace backend starts rolling at 12:40, while microservices' stall completes at 12:41.
  const OTHER: Rollout = { ...ECOM, namespace: 'backend', rs: 'ecom-service-production-5d9f8b7c64', prevRs: 'ecom-service-production-6f4c9d8b72', created: Date.parse('2026-11-03T12:40:00Z') };
  const tel = cluster([{ ...ECOM, done: Date.parse('2026-11-03T12:41:00Z') }, OTHER]);
  const pass = (iso: string) => patrolOnce(tel, c, new Noise({}), state, new CardSink(c.outDir), new Date(iso), { llm: false, post: false });
  assert.deepEqual((await pass('2026-11-03T12:30:00Z')).summary.send.map((r) => r.key), [STALLED]);
  const done = await pass('2026-11-03T12:45:00Z');
  assert.deepEqual([done.summary.recovered, done.summary.send, done.summary.known], [[STALLED], [], []], "backend's rollout is not microservices'");
  const other = await pass('2026-11-03T13:00:00Z');
  assert.deepEqual(other.summary.send.map((r) => r.key), ['rollout|ecom-service-production|stalled|backend/5d9f8b7c64']);
});

test('the shipped sources read Argo CD (scraped since argo-cd #1314) and map the two services whose names differ', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.deepEqual(loadConfig({}).sources.deploys, { aliases: { keycloak: 'keycloak-production', 'backend-production-mesh': 'backend-production' }, stall_minutes: 10, argocd: true });
});

function report(over: Partial<Report> = {}): Report {
  return {
    title: 'Password reset returns 400 after the backend deploy',
    severity: 'critical',
    status: 'active',
    started_at: '2026-09-29T12:00:00Z',
    what_broke: 'POST /v1/auth/password/reset returns 400',
    impact: '~20% of reset requests in 15 min',
    reach: 'many',
    cause: { hypothesis: 'the 11:58Z deploy changed validation', confidence: 'medium' },
    evidence: [{ id: 'E-abcd-1', quote: 'reset 400 | 19', claim: '19 requests were 400' }],
    suggested_fix: 'check the 2.2645.0 validation change',
    not_checked: [],
    rows: ['http|backend-production|/v1/auth/password/reset|400'],
    issue: 'new',
    ...over,
  };
}
