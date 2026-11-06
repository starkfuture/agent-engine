import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Sample, Telemetry } from '../src/clients/telemetry.js';
import type { Config } from '../src/config.js';
import { Evidence } from '../src/engine/evidence.js';
import { forServer } from '../src/engine/session.js';
import { monitorTools } from '../src/investigate/tools.js';
import { FakeTelemetry, testConfig } from './fake.js';

const AT = new Date('2026-11-06T12:00:00Z');
const T = AT.getTime() / 1000;
const MIN = 60;
// The watched namespaces as production has them (config/sources.yaml).
const cfg = (): Config => {
  const c = testConfig();
  return { ...c, sources: { ...c.sources, workloads: { namespaces: 'microservices|backend.*' } } };
};

// A tool as the in-process MCP server serves it: defaults filled for left-out fields.
async function call(tel: Telemetry, name: string, args: Record<string, unknown> = {}) {
  const evidence = new Evidence();
  const t = forServer(monitorTools(tel, cfg(), AT)(evidence, 'author').find((x) => x.name === name)!);
  const r = await t.handler(args, {});
  return { text: (r.content[0] as { text: string }).text, isError: Boolean(r.isError), evidence };
}
const failing = (msg: string) => () => {
  throw new Error(msg);
};

// ---- firing_alerts ------------------------------------------------------------------

const SKIP = 'alertname!~"Watchdog|InfoInhibitor|AgentEngine.*|.*RouteTest"';
const ECOM_POD = 'ecom-service-production-7566f689c8-x2k9p';
type Alert = { name: string; labels: Record<string, string>; state?: 'firing' | 'pending'; since?: number };
const series = (as: Alert[]) => (query: string): Sample[] => {
  if (query.startsWith('ALERTS_FOR_STATE')) return as.filter((a) => a.since).map((a) => ({ labels: { __name__: 'ALERTS_FOR_STATE', alertname: a.name, ...a.labels }, value: a.since! }));
  if (query.startsWith('ALERTS')) return as.map((a) => ({ labels: { __name__: 'ALERTS', alertname: a.name, alertstate: a.state ?? 'firing', ...a.labels }, value: 1 }));
  return [];
};

const FIRING: Alert[] = [
  // kube-state-metrics' own service and job ride along on its alerts.
  { name: 'KubePodCrashLooping', labels: { namespace: 'microservices', severity: 'warning', pod: ECOM_POD, container: 'app', job: 'kube-state-metrics', service: 'prometheus-kube-state-metrics' }, since: T - 62 * MIN },
  { name: 'KubePodCrashLooping', labels: { namespace: 'microservices', severity: 'warning', pod: 'ecom-service-production-7566f689c8-q7w8r', container: 'app' }, since: T - 15 * MIN },
  { name: 'KubePersistentVolumeFillingUp', labels: { namespace: 'backend-production', severity: 'critical', persistentvolumeclaim: 'data-redis-0' }, since: T - (2 * 24 * 60 + 3 * 60) * MIN },
  { name: 'JourneyCheckoutFailing', labels: { namespace: 'microservices', severity: 'critical', service: 'checkout' }, since: T - 7 * MIN },
  // Known noise: counted, never a group of its own.
  { name: 'PostgresPodPoolSaturated', labels: { namespace: 'microservices', severity: 'info', pod: 'pgbouncer-6d8f7c9b5d-k2m4n' } },
  { name: 'PostgresPodPoolSaturated', labels: { namespace: 'microservices', severity: 'info', pod: 'pgbouncer-6d8f7c9b5d-w8x9z' } },
  { name: 'CPUThrottlingHigh', labels: { namespace: 'monitoring', severity: 'info', pod: 'grafana-0', container: 'grafana' } },
  { name: 'CPUThrottlingHigh', labels: { namespace: 'monitoring', severity: 'info', pod: 'loki-0', container: 'loki' } },
  { name: 'CPUThrottlingHigh', labels: { namespace: 'dwh', severity: 'info', pod: 'airflow-0', container: 'worker' } },
  // Not watched: counted per namespace.
  { name: 'KubeJobFailed', labels: { namespace: 'monitoring', severity: 'warning', job_name: 'backup-29384756' } },
  { name: 'KubeNodeNotReady', labels: { severity: 'warning', node: 'ip-10-0-1-2' } },
  // Pending: hidden unless asked for.
  { name: 'KubePodNotReady', labels: { namespace: 'microservices', severity: 'warning', pod: 'ecom-service-production-7566f689c8-b5n4m' }, state: 'pending' },
  // A Slack copy of the first crash loop: the same pod, its namespace in ecom_namespace.
  { name: 'EcomPodCrashLooping', labels: { namespace: 'agent-engine', ecom_namespace: 'microservices', severity: 'warning', pod: ECOM_POD, container: 'app' }, since: T - 60 * MIN },
];

test('firing_alerts groups by alert, namespace and severity, watched namespaces first, and stamps the result as evidence', async () => {
  const tel = new FakeTelemetry(series(FIRING));
  const { text, isError, evidence } = await call(tel, 'firing_alerts');
  assert.equal(isError, false, text);
  const id = /^evidence_id: (E-[0-9a-f]{4}-1)\n/.exec(text)?.[1];
  assert.ok(id && evidence.items.get(id)?.tool === 'firing_alerts', text);
  assert.deepEqual(evidence.items.get(id!)?.args, { include_pending: false, max: 40 }, 'the defaults, filled');
  // One query, the always-on and routing-test alerts left out by name; no namespace filter by default.
  assert.deepEqual(tel.calls, [`ALERTS{${SKIP}}`, `ALERTS_FOR_STATE{${SKIP}}`]);

  assert.match(text, /Context, not proof of cause/);
  // The copy folds into its original: four conditions, not five.
  assert.match(text, /\n4 firing in the watched namespaces, in 3 groups:\n/);
  const lines = text.split('\n');
  const at = (s: string) => lines.findIndex((l) => l.startsWith(s));
  // Critical first, then by count; each group names what it is about and how long it has been active.
  assert.ok(at('- JourneyCheckoutFailing [critical] microservices') < at('- KubePersistentVolumeFillingUp [critical] backend-production'));
  assert.ok(at('- KubePersistentVolumeFillingUp') < at('- KubePodCrashLooping'));
  assert.ok(lines.includes('- KubePersistentVolumeFillingUp [critical] backend-production: 1 firing, active since 2026-11-04T09:00Z (2d3h): persistentvolumeclaim=data-redis-0'), text);
  assert.ok(
    lines.includes(`- KubePodCrashLooping [warning] microservices: 2 firing, active since 2026-11-06T10:58Z (1h02m), also sent to Slack as EcomPodCrashLooping: pod=${ECOM_POD} container=app; pod=ecom-service-production-7566f689c8-q7w8r container=app`),
    text,
  );
  assert.doesNotMatch(text, /kube-state-metrics/, "the exporter's own service is not what the alert is about");
  assert.doesNotMatch(text, /^- EcomPodCrashLooping/m, 'a copy is never its own group when its original fires');

  // The noisy info alerts: one count line, no groups.
  assert.ok(lines.includes('known-noisy info alerts (firing most of the week), counted only: CPUThrottlingHigh 3 (monitoring 2, dwh 1); PostgresPodPoolSaturated 2 (microservices 2)'), text);
  assert.doesNotMatch(text, /^- (PostgresPodPoolSaturated|CPUThrottlingHigh)/m);
  // Other namespaces as counts; pending hidden, and said so.
  assert.ok(lines.includes('other namespaces (not watched; pass namespace to list them): monitoring 1 (warning 1: KubeJobFailed); (no namespace) 1 (warning 1: KubeNodeNotReady)'), text);
  assert.doesNotMatch(text, /KubePodNotReady/);
  assert.ok(lines.includes('pending, not shown: 1 (include_pending: true lists them)'), text);
});

test('firing_alerts lists pending alerts only when asked, and caps the objects it names', async () => {
  const pending = await call(new FakeTelemetry(series(FIRING)), 'firing_alerts', { include_pending: true });
  assert.match(pending.text, /\n5 firing or pending in the watched namespaces, in 4 groups:\n/);
  assert.match(pending.text, /^- KubePodNotReady \[warning\] microservices: 1 pending: pod=ecom-service-production-7566f689c8-b5n4m$/m);
  assert.doesNotMatch(pending.text, /pending, not shown/);

  const five = Array.from({ length: 5 }, (_, i): Alert => ({ name: 'KubePodCrashLooping', labels: { namespace: 'microservices', severity: 'warning', pod: `checkout-production-7566f689c8-p${i}xxx` } }));
  const capped = await call(new FakeTelemetry(series(five)), 'firing_alerts', { max: 2 });
  assert.match(capped.text, /^- KubePodCrashLooping \[warning\] microservices: 5 firing: pod=checkout-production-7566f689c8-p0xxx; pod=checkout-production-7566f689c8-p1xxx \(\+3 more\)$/m);
});

test('firing_alerts with a namespace matches namespace or ecom_namespace, quoted, and marks a copy without an original', async () => {
  const alerts: Alert[] = [
    { name: 'KubePodNotReady', labels: { namespace: 'microservices', severity: 'warning', pod: ECOM_POD } },
    { name: 'EcomPodNotReady', labels: { namespace: 'agent-engine', ecom_namespace: 'microservices', severity: 'warning', pod: ECOM_POD } },
    { name: 'EcomOutboxStuck', labels: { namespace: 'agent-engine', ecom_namespace: 'microservices', severity: 'critical', service: 'outbox-relay' } },
  ];
  const tel = new FakeTelemetry(series(alerts));
  const { text } = await call(tel, 'firing_alerts', { namespace: 'microservices' });
  assert.equal(tel.calls[0], `ALERTS{${SKIP},namespace=~"microservices"} or ALERTS{${SKIP},ecom_namespace=~"microservices"}`);
  assert.match(text, /\n2 firing in this scope, in 2 groups:\n/);
  assert.match(text, /^- EcomOutboxStuck \[critical\] microservices \(Slack copy; no original fires on the same object\): 1 firing: service=outbox-relay$/m);
  assert.match(text, /^- KubePodNotReady \[warning\] microservices: 1 firing, also sent to Slack as EcomPodNotReady: pod=/m);
  assert.doesNotMatch(text, /agent-engine/, 'a copy shows its original namespace');

  // The model's text never reaches PromQL unquoted.
  const evil = await call(new FakeTelemetry(series([])), 'firing_alerts', { namespace: 'x"} or vector(1) or ALERTS{a="' });
  assert.equal(evil.isError, false);
  const t2 = new FakeTelemetry(series([]));
  await call(t2, 'firing_alerts', { namespace: 'x"} or vector(1) or ALERTS{a="' });
  assert.equal(t2.calls[0], `ALERTS{${SKIP},namespace=~"x\\"} or vector(1) or ALERTS{a=\\""} or ALERTS{${SKIP},ecom_namespace=~"x\\"} or vector(1) or ALERTS{a=\\""}`);
});

test('firing_alerts folds a copy only into its own original, so another condition on the same object stays listed', async () => {
  const alerts: Alert[] = [
    { name: 'KubePodCrashLooping', labels: { namespace: 'microservices', severity: 'warning', pod: ECOM_POD, container: 'app' } },
    // Aggregated by container: the same container, but not this alert's copy.
    { name: 'EcomPodOOMKilled', labels: { namespace: 'agent-engine', ecom_namespace: 'microservices', severity: 'ticket', container: 'app' } },
    // Aggregated by datname: neither names an object, and the names pair.
    { name: 'PostgresDeadlocks', labels: { namespace: 'microservices', severity: 'warning', datname: 'stark' } },
    { name: 'EcomPostgresDeadlocks', labels: { namespace: 'agent-engine', ecom_namespace: 'microservices', severity: 'ticket', datname: 'stark' } },
    // A business copy names its service by app.
    { name: 'EcomOutboxStuck', labels: { namespace: 'agent-engine', ecom_namespace: 'microservices', severity: 'ticket', app: 'ecom-service-production' } },
  ];
  const { text } = await call(new FakeTelemetry(series(alerts)), 'firing_alerts');
  assert.match(text, /\n4 firing in the watched namespaces, in 4 groups:\n/);
  assert.match(text, /^- KubePodCrashLooping \[warning\] microservices: 1 firing: pod=\S+ container=app$/m);
  assert.match(text, /^- EcomPodOOMKilled \[ticket\] microservices \(Slack copy; no original fires on the same object\): 1 firing: container=app$/m);
  assert.match(text, /^- PostgresDeadlocks \[warning\] microservices: 1 firing, also sent to Slack as EcomPostgresDeadlocks: datname=stark$/m);
  assert.match(text, /^- EcomOutboxStuck \[ticket\] microservices \(Slack copy; no original fires on the same object\): 1 firing: app=ecom-service-production$/m);
});

test('firing_alerts folds copies into originals with their real label shapes: OOM by container, deadlocks with no labels at all', async () => {
  const alerts: Alert[] = [
    // As in prod: PodOOMKilled names namespace, pod and container; PostgresDeadlocks is a bare sum with no namespace.
    { name: 'PodOOMKilled', labels: { namespace: 'microservices', severity: 'warning', pod: ECOM_POD, container: 'app' } },
    { name: 'EcomPodOOMKilled', labels: { namespace: 'agent-engine', ecom_namespace: 'microservices', severity: 'ticket', container: 'app' } },
    { name: 'PostgresDeadlocks', labels: { severity: 'warning' } },
    { name: 'EcomPostgresDeadlocks', labels: { namespace: 'agent-engine', ecom_namespace: 'microservices', severity: 'ticket', datname: 'stark' } },
  ];
  const { text } = await call(new FakeTelemetry(series(alerts)), 'firing_alerts');
  assert.match(text, /\n2 firing in the watched namespaces, in 2 groups:\n/);
  assert.match(text, /^- PodOOMKilled \[warning\] microservices: 1 firing, also sent to Slack as EcomPodOOMKilled: pod=\S+ container=app$/m);
  assert.match(text, /^- PostgresDeadlocks \[warning\] microservices: 1 firing, also sent to Slack as EcomPostgresDeadlocks$/m);
  assert.doesNotMatch(text, /^- Ecom/m);
  assert.doesNotMatch(text, /other namespaces/);
});

test('firing_alerts says "none" only when the query succeeded; a Prometheus error is an error', async () => {
  const none = await call(new FakeTelemetry(() => []), 'firing_alerts');
  assert.equal(none.isError, false);
  assert.match(none.text, /^evidence_id: /);
  assert.match(none.text, /\nnone firing in the watched namespaces \(the query succeeded and returned none\)\n>>>$/);

  // Only elsewhere: none here, and the rest still counted.
  const elsewhere = await call(new FakeTelemetry(series(FIRING.filter((a) => a.labels.namespace === 'monitoring'))), 'firing_alerts');
  assert.match(elsewhere.text, /\nnone firing in the watched namespaces \(the query succeeded; what it returned is counted below\)\n/);
  assert.match(elsewhere.text, /other namespaces \(not watched; pass namespace to list them\): monitoring 1/);

  const down = await call(new FakeTelemetry(failing('prometheus: HTTP 503 Service Unavailable')), 'firing_alerts');
  assert.equal(down.isError, true);
  assert.match(down.text, /^error:\n/);
  assert.match(down.text, /prometheus: HTTP 503 Service Unavailable/);
  assert.doesNotMatch(down.text, /none|firing/);

  // Without ALERTS_FOR_STATE the alerts still list, with no times, and it says why.
  const noTimes = new FakeTelemetry((q) => (q.startsWith('ALERTS_FOR_STATE') ? failing('prometheus: timeout')() : series(FIRING)(q)));
  const partial = await call(noTimes, 'firing_alerts');
  assert.equal(partial.isError, false);
  assert.match(partial.text, /\nactive-since times not available \(ALERTS_FOR_STATE: prometheus: timeout\)\n/);
  assert.doesNotMatch(partial.text, /active since 20/);
});

test('firing_alerts output and arguments are redacted', async () => {
  const alerts: Alert[] = [{ name: 'KubeDeploymentReplicasMismatch', labels: { namespace: 'microservices', severity: 'warning', service: 'alice@example.com', deployment: 'glsa_ABCDEFGHIJKLMNOPQRSTUV' } }];
  const { text, evidence } = await call(new FakeTelemetry(series(alerts)), 'firing_alerts', { namespace: 'bob@example.com' });
  assert.doesNotMatch(text, /alice@example\.com|bob@example\.com|glsa_ABCDEFGHIJKLMNOPQRSTUV/);
  assert.match(text, /service=<email> deployment=<secret>/);
  assert.deepEqual([...evidence.items.values()][0]!.args, { namespace: '<email>', include_pending: false, max: 40 });
});

// ---- pod_status ----------------------------------------------------------------------

type Pod = { pod: string; ns?: string; ready?: boolean; phase?: string; waiting?: Array<[string, string]>; term?: Array<[string, string]>; r1?: number; r6?: number; start?: number };
function pods(ps: Pod[], o: { present?: number; prefixed?: Pod[] } = {}): FakeTelemetry {
  return new FakeTelemetry((query) => {
    const list = query.includes('pod=~') ? (o.prefixed ?? ps) : ps;
    const l = (p: Pod) => ({ namespace: p.ns ?? 'microservices', pod: p.pod });
    const per = (f: (p: Pod) => Array<{ extra?: Record<string, string>; value: number }>) => list.flatMap((p) => f(p).map((x) => ({ labels: { ...l(p), ...x.extra }, value: x.value })));
    // kube-state-metrics exports one ready series per pod and condition (true, false, unknown).
    if (query.startsWith('count(kube_pod_status_ready')) {
      const n = o.present ?? ps.length;
      return n ? [{ labels: {}, value: query.includes('condition="true"') ? n : 3 * n }] : [];
    }
    if (query.startsWith('kube_pod_status_ready')) return per((p) => [{ extra: { condition: 'true' }, value: p.ready === false ? 0 : 1 }]);
    if (query.startsWith('kube_pod_status_phase')) return per((p) => [{ extra: { phase: p.phase ?? 'Running' }, value: 1 }]);
    if (query.startsWith('kube_pod_container_status_waiting_reason')) return per((p) => (p.waiting ?? []).map(([container, reason]) => ({ extra: { container, reason }, value: 1 })));
    if (query.startsWith('kube_pod_container_status_last_terminated_reason')) return per((p) => (p.term ?? []).map(([container, reason]) => ({ extra: { container, reason }, value: 1 })));
    if (query.includes('[1h]')) return per((p) => [{ value: p.r1 ?? 0 }]);
    if (query.includes('[6h]')) return per((p) => [{ value: p.r6 ?? 0 }]);
    if (query.startsWith('kube_pod_start_time')) return per((p) => [{ value: p.start ?? T - 3 * 24 * 60 * MIN }]);
    return [];
  });
}

const CLUSTER: Pod[] = [
  { pod: ECOM_POD, ready: false, waiting: [['app', 'CrashLoopBackOff']], term: [['app', 'OOMKilled']], r1: 3, r6: 7, start: T - 40 * MIN },
  { pod: 'ecom-service-production-7566f689c8-q7w8r' },
  { pod: 'ecom-service-production-7566f689c8-b5n4m' },
  { pod: 'ecom-service-production-5d4b9c7f88-gq2w8', ready: false, phase: 'Failed' },
  { pod: 'payment-service-production-5d4b9c7f88-zx9kd', r6: 2, term: [['app', 'Error']], start: T - 4 * 60 * MIN },
  { pod: 'order-service-production-6c9f7b8d54-h7j2k' },
  { pod: 'order-service-production-6c9f7b8d54-m4n6p' },
  { pod: 'redis-0', ns: 'backend-production' },
  { pod: 'db-migrate-29384756-x7k2p', ready: false, phase: 'Succeeded' },
];

test('pod_status lists not-ready, waiting and restarted pods first by workload, and healthy pods as one count', async () => {
  const tel = pods(CLUSTER);
  const { text, isError, evidence } = await call(tel, 'pod_status');
  assert.equal(isError, false, text);
  const id = /^evidence_id: (E-[0-9a-f]{4}-1)\n/.exec(text)?.[1];
  assert.equal(evidence.items.get(id!)?.tool, 'pod_status');
  // The presence check first, over the watched namespaces by default.
  assert.equal(tel.calls[0], 'count(kube_pod_status_ready{namespace=~"microservices|backend.*",condition="true"})');
  assert.ok(tel.calls.includes('kube_pod_status_ready{namespace=~"microservices|backend.*",condition="true"}'));

  const body = text.slice(text.indexOf('pods at '), text.lastIndexOf('\n>>>'));
  assert.equal(
    body,
    [
      'pods at 2026-11-06T12:00:00.000Z in namespace=~"microservices|backend.*": 9 pods in 5 workloads, 6 ready.',
      'Readiness flips during a rollout are normal (new pods start not ready while old ones stop): check recent_changes before calling a not-ready pod a problem.',
      'needing attention (not ready, waiting, restarted in the last 6 h, or failed): 3 pods. "last terminated" is a container\'s most recent exit, which may be old.',
      'ecom-service-production [microservices]: 2 of 3 ready',
      `  ${ECOM_POD}: NOT READY, Running, waiting app=CrashLoopBackOff, restarts 3 in 1 h / 7 in 6 h, last terminated app=OOMKilled, started 2026-11-06T11:20:00Z`,
      '  ecom-service-production-5d4b9c7f88-gq2w8: NOT READY, Failed, started 2026-11-03T12:00:00Z',
      'payment-service-production [microservices]: 1 of 1 ready',
      '  payment-service-production-5d4b9c7f88-zx9kd: ready, Running, restarts 0 in 1 h / 2 in 6 h, last terminated app=Error, started 2026-11-06T08:00:00Z',
      'healthy: 5 pods ready and Running, nothing waiting, no restarts in 6 h (3 workloads); completed (Succeeded): 1',
    ].join('\n'),
  );
});

test('pod_status says kube-state-metrics is missing, never "all ready", when its presence check finds nothing', async () => {
  const tel = pods(CLUSTER, { present: 0 });
  const { text, isError } = await call(tel, 'pod_status');
  assert.equal(isError, true);
  assert.match(text, /kube-state-metrics missing \(not a quiet system\): no kube_pod_status_ready series for namespace=~"microservices\|backend\.\*"/);
  assert.doesNotMatch(text, /healthy|needing attention|ready and Running/);
  assert.equal(tel.calls.length, 1, 'nothing else is read once the presence check fails');

  // A Prometheus error in the presence check is that error, not "missing".
  const down = await call(new FakeTelemetry(failing('prometheus: HTTP 502 Bad Gateway')), 'pod_status');
  assert.equal(down.isError, true);
  assert.match(down.text, /prometheus: HTTP 502 Bad Gateway/);
  assert.doesNotMatch(down.text, /kube-state-metrics missing/);
});

test('pod_status quotes the namespace and treats the workload as a literal prefix', async () => {
  const tel = pods(CLUSTER, { prefixed: [] });
  const { text } = await call(tel, 'pod_status', { namespace: 'microservices', workload: 'ecom-service.production' });
  assert.ok(tel.calls.includes('kube_pod_status_ready{namespace=~"microservices",pod=~"ecom-service\\\\.production.*",condition="true"}'), tel.calls.join('\n'));
  assert.match(text, /No pods match namespace=~"microservices",pod=~"ecom-service\\\\.production\.\*" at 2026-11-06T12:00:00\.000Z \(kube-state-metrics reports 9 pods for namespace=~"microservices"\)\./);

  const t2 = pods(CLUSTER);
  await call(t2, 'pod_status', { namespace: 'a"} or vector(1) #', workload: 'b"} or vector(1) #' });
  assert.equal(t2.calls[0], 'count(kube_pod_status_ready{namespace=~"a\\"} or vector(1) #",condition="true"})');
  assert.ok(t2.calls.includes('kube_pod_start_time{namespace=~"a\\"} or vector(1) #",pod=~"b\\"\\\\} or vector\\\\(1\\\\) #.*"}'), t2.calls.join('\n'));
});

test('pod_status lists at most 30 pods and says how many it left out', async () => {
  const letters = 'bcdfghjklmnpqrstvwxz';
  const many = Array.from({ length: 35 }, (_, i): Pod => ({ pod: `checkout-production-7566f689c8-${letters[i % 20]}${letters[Math.floor(i / 20)]}bbb`, ready: false }));
  const { text } = await call(pods(many), 'pod_status');
  assert.equal(text.split('\n').filter((l) => l.startsWith('  checkout-production-')).length, 30);
  assert.match(text, /\n\+5 more pods needing attention not listed: narrow with workload\n/);
  assert.match(text, /\nhealthy: 0 pods/);
});

test('both new tools build for the server, their defaults said in their schemas', () => {
  const tools = monitorTools(new FakeTelemetry(() => []), cfg(), AT)(new Evidence(), 'author');
  const schema = (name: string) => forServer(tools.find((t) => t.name === name)!).inputSchema as Record<string, { description?: string }>;
  assert.match(schema('pod_status').namespace!.description!, /\(default: the watched namespaces\)$/);
  assert.match(schema('firing_alerts').include_pending!.description!, /\(default false\)$/);
  assert.match(schema('firing_alerts').max!.description!, /\(default 40\)$/);
  assert.deepEqual(
    tools.map((t) => t.name),
    ['service_overview', 'route_timeline', 'log_search', 'workload_state', 'pod_status', 'recent_changes', 'firing_alerts', 'promql', 'trace_search'],
  );
});
