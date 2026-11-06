import type { Sources } from './config.js';
import type { Telemetry } from './clients/telemetry.js';
import { counterQuery, fourWay, httpQuery, spanErrorsKey, spanErrorsQuery, workloadQueries } from './patrol/collectors.js';
import { imagesQuery, remainingQuery } from './patrol/deploys.js';

// What `export` records beyond the patrol's own queries, so a recording can
// answer questions asked after retention has dropped the data.

// Per patrol time: queries a later patrol will make, recorded now in exactly
// the form it will ask them (same text, same four instants as fourWay), so
// replaying today's recordings with that later code finds them.
export const extraPatrolQueries = (windowMin: number): string[] => [spanErrorsQuery(windowMin)];

export async function recordExtras(tel: Telemetry, at: Date, windowMin: number): Promise<void> {
  await fourWay(tel, spanErrorsQuery(windowMin), at, spanErrorsKey);
}

// Raw context at 5-minute resolution, for analysis rather than replay: each
// query is read as a range in chunks of CHUNK_HOURS.
const STEP_SEC = 300;
const CHUNK_HOURS = 6;
const q = (v: string) => JSON.stringify(v);

export function contextQueries(s: Sources): Array<{ id: string; query: string }> {
  const ns = `namespace=~${q(s.workloads.namespaces)}`;
  const w = workloadQueries(s.workloads.namespaces, 5);
  const out: Array<{ id: string; query: string }> = [
    ...s.http_families.map((f) => ({ id: `http:${f.id}`, query: httpQuery(f, 5) })),
    ...s.error_counters.flatMap((c) => [
      { id: `counter:${c.id}`, query: counterQuery(c, 5) },
      ...(c.presence ? [{ id: `counter:${c.id}:presence`, query: `count(${c.presence})` }] : []),
    ]),
    { id: 'workloads:restarts', query: w.restartsQ },
    { id: 'workloads:last-terminated', query: w.reasonsQ },
    { id: 'workloads:waiting', query: w.waitingQ },
    { id: 'workloads:unavailable', query: w.unavailQ },
    { id: 'workloads:pending', query: `max by (namespace, pod, phase) (kube_pod_status_phase{${ns},phase=~"Pending|Unknown"}) > 0` },
    { id: 'rollouts:remaining', query: remainingQuery(s) },
    { id: 'rollouts:progress-deadline', query: `max by (namespace, deployment, reason) (kube_deployment_status_condition{${ns},condition="Progressing",status="false"}) == 1` },
    { id: 'rollouts:replicasets', query: `max by (namespace, replicaset, owner_name) (kube_replicaset_owner{${ns},owner_kind="Deployment"})` },
    { id: 'rollouts:images', query: imagesQuery(s) },
    { id: 'traces:span-errors', query: spanErrorsQuery(5) },
    { id: 'alerts', query: 'ALERTS{alertstate="firing"}' },
  ];
  if (s.deploys.argocd)
    out.push({ id: 'argocd:apps', query: `count by (name, sync_status, health_status) (argocd_app_info{dest_namespace=~${q(s.workloads.namespaces)}})` });
  return out;
}

export async function recordContext(tel: Telemetry, s: Sources, from: Date, to: Date, log: (s: string) => void): Promise<void> {
  const queries = contextQueries(s);
  const chunk = CHUNK_HOURS * 3600_000;
  for (let start = from.getTime(); start < to.getTime(); start += chunk) {
    const end = new Date(Math.min(start + chunk, to.getTime()));
    for (const { id, query } of queries) await tel.promRange(query, new Date(start), end, STEP_SEC).catch((e: Error) => log(`raw ${id}: ${e.message}`));
  }
}
