import type { Sources } from '../config.js';
import type { Sample, Telemetry } from '../clients/telemetry.js';
import { fourWay, requireSeries } from './collectors.js';
import type { Counts, Score } from './score.js';
import { rowKey, type Row } from './types.js';

// What was deployed, from kube-state-metrics. A deploy is a new ReplicaSet,
// never a generation change: every service in microservices has an HPA, and
// scaling bumps the generation too (82 generation changes against 8 new
// ReplicaSets in 48 h, 2026-11-03). Scaling creates no ReplicaSet. A rollback
// to an older template reuses its ReplicaSet: it shows on the deploy it undid.
//
// Deploys are context and never a post. Only a stalled rollout, an Argo CD app
// Degraded or Missing, or a failed sync is a row (section rollout), and urgent.

const MIN = 60_000;
const H = 60 * MIN;
// A ReplicaSet name is its Deployment's plus the pod-template-hash
// (rand.SafeEncodeString's alphabet: no vowels, no 0, 1 or 3).
const RS_HASH = /-[bcdfghjklmnpqrstvwxz2456789]{6,10}$/;
const q = (v: string) => JSON.stringify(v); // PromQL string literal
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ns = (src: Sources) => `namespace=~${q(src.workloads.namespaces)}`;
const dest = (src: Sources) => `dest_namespace=~${q(src.workloads.namespaces)}`;
// argocd_app_sync_total has no dest_namespace (verified 2026-11-03): its apps are matched by name.
const inDest = (src: Sources) => `on (name) argocd_app_info{${dest(src)}}`;

export type RolloutState = 'rolling' | 'stalled' | 'complete' | 'rolled back' | 'replaced' | 'unknown';

export interface Deploy {
  namespace: string;
  workload: string; // the Deployment
  replicaset: string;
  at: string; // when the ReplicaSet was created
  image?: string | undefined; // image_spec of the workload's container on that ReplicaSet
  previous?: string | undefined; // the image it replaced, read a minute before
  state: RolloutState;
  minutes?: number | undefined; // complete: how long it took; rolling or stalled: for how long so far
  now?: string | undefined; // rolled back: the image running again
}

export interface Deploys {
  at: string;
  hours: number;
  deploys: Deploy[]; // oldest first
  statefulsets: string[]; // rolling now (context only)
  argocd?: { apps: string[]; syncs: string[] } | undefined; // with deploys.argocd on
  notes: string[]; // parts that could not be read
  error?: string | undefined; // nothing could be read
}

// ---- queries (sources.yaml deploys; section 2.2 of the deploy-watch plan) ----
// One series per new ReplicaSet: its creation time, and its Deployment as owner_name.
export function createdQuery(src: Sources, hours: number, workload?: string): string {
  const owner = workload ? `,owner_name=${q(workload)}` : '';
  return `max by (namespace, owner_name, replicaset) ((kube_replicaset_created{${ns(src)}} > time() - ${Math.round(hours * 3600)}) * on (namespace, replicaset) group_left (owner_name) kube_replicaset_owner{${ns(src)},owner_kind="Deployment"${owner}})`;
}

// Pods per ReplicaSet (owner_name), container and image_spec. image_spec keeps
// the tag of a digest-pinned image; the image label shows a bare sha256 there.
export const imagesQuery = (src: Sources) =>
  `count by (namespace, owner_name, container, image_spec) (kube_pod_container_info{${ns(src)}} * on (namespace, pod) group_left (owner_name) kube_pod_owner{${ns(src)},owner_kind="ReplicaSet"})`;

// What a rollout still has to do, per Deployment: replicas to update, to become
// available, and old ones to retire. 0 = complete. The last term matters for one
// replica: the new pod counts as updated while unready, and the old ready pod
// keeps available at 1.
const remaining = (sel: string) =>
  `max by (namespace, deployment) (clamp_min(kube_deployment_spec_replicas{${sel}} - kube_deployment_status_replicas_updated{${sel}}, 0) + clamp_min(kube_deployment_spec_replicas{${sel}} - kube_deployment_status_replicas_available{${sel}}, 0) + clamp_min(kube_deployment_status_replicas{${sel}} - kube_deployment_status_replicas_updated{${sel}}, 0))`;
const progressQuery = (src: Sources, workloads: string[]) => remaining(`${ns(src)},deployment=~${q(workloads.map(reEscape).join('|'))}`);
export const unfinishedQuery = (src: Sources) => `${remaining(ns(src))} > 0`;

// Stalled: replicas not on the new version for every minute of stall_minutes
// (before the controller gives up), or the controller's own
// ProgressDeadlineExceeded (Progressing false; progressDeadlineSeconds is 600 in
// the charts). The second catches a one-replica rollout, whose new pod counts as
// updated while it never becomes ready. min_over_time skips minutes with no
// sample, so the first also needs a sample in every one of them: a Deployment
// created a minute ago is not stalled. One series per Deployment.
export function stallQuery(src: Sources): string {
  const m = src.deploys.stall_minutes;
  const behind = `(kube_deployment_spec_replicas{${ns(src)}} - kube_deployment_status_replicas_updated{${ns(src)}})[${m}m:1m]`;
  return `max by (namespace, deployment) (min_over_time(${behind})) > 0 and on (namespace, deployment) max by (namespace, deployment) (count_over_time(${behind})) >= ${m} or on (namespace, deployment) max by (namespace, deployment, reason) (kube_deployment_status_condition{${ns(src)},condition="Progressing",status="false"}) == 1`;
}

// UNVERIFIED in this cluster: none of the apps is a StatefulSet.
const statefulsetsQuery = (src: Sources, workload?: string) => {
  const sel = `${ns(src)}${workload ? `,statefulset=${q(workload)}` : ''}`;
  return `kube_statefulset_status_update_revision{${sel}} unless on (namespace, statefulset, revision) kube_statefulset_status_current_revision{${sel}}`;
};

// An app Degraded or Missing at each of the last 5 minutes (a subquery, so it
// does not depend on the scrape interval).
const degradedQuery = (src: Sources) => `count_over_time(argocd_app_info{${dest(src)},health_status=~"Degraded|Missing"}[5m:1m]) >= 5`;

// A sync that ended Error or Failed in the window. A phase's counter appears
// with its first sync, so a series new in the window counts too: increase()
// needs two samples and would miss an app's first failure.
const failedSyncQuery = (src: Sources, windowMin: number) => {
  const failed = 'argocd_app_sync_total{phase=~"Error|Failed"}';
  return `(sum by (name, phase) (increase(${failed}[${windowMin}m])) > 0 or sum by (name, phase) (${failed} unless ${failed} offset ${windowMin}m)) and ${inDest(src)}`;
};

// ---- rows: stalled rollouts, Argo CD apps (urgent) --------------------------
// A state, not a rate: each window counts 1 when it held, so moving replica
// counts never make it "worse", and it stays a row for as long as it holds (a
// min(1 d, 7 d) baseline would hide a stall that also held yesterday).
const held = (c: Counts): Counts => ({ now: +(c.now > 0), h1: +(c.h1 > 0), d1: +(c.d1 > 0), d7: +(c.d7 > 0) });
const heldScore = (c: Counts): Score => ({ verdict: 'new', expected: 0, z: 1, trend: c.h1 ? 'ongoing' : 'started' });

function rolloutRow(service: string, subject: string, status: string | undefined, raw: Counts, detail: string, query: string): Row {
  const counts = held(raw);
  return { key: rowKey({ section: 'rollout', service, subject, status }), section: 'rollout', service, subject, ...(status ? { status } : {}), counts, score: heldScore(counts), detail, query };
}

// `flagged(key)`: whether a stalled row is still open from an earlier patrol.
// A stall ends when its rollout completes (every replica updated and available,
// the old ones retired), not when its symptom changes: once every pod is
// updated, new pods that never get ready no longer show as replicas behind.
export async function collectRollouts(tel: Telemetry, src: Sources, at: Date, flagged: (key: string) => boolean = () => false): Promise<Row[]> {
  const query = stallQuery(src);
  const [cells, unfinished] = await Promise.all([
    fourWay(tel, query, at, (s) => `${s.labels.namespace}\u0000${s.labels.deployment}`),
    tel.promInstant(unfinishedQuery(src), at),
    // Without Deployment series a stall would read as complete.
    requireSeries(tel, `kube_deployment_spec_replicas{${ns(src)}}`, at, 'kube-state-metrics deployment'),
  ]);
  const rows: Row[] = [];
  for (const [k, { counts, labels }] of cells) {
    if (!(counts.now > 0)) continue;
    const [namespace, deployment] = k.split('\u0000') as [string, string];
    const detail = labels.reason
      ? `the controller gave up on it: Progressing ${labels.reason} (ns ${namespace})`
      : `${Math.round(counts.now)} replica(s) not on the new version for ${src.deploys.stall_minutes}+ min (ns ${namespace})`;
    rows.push(rolloutRow(deployment, 'stalled', undefined, counts, detail, query));
  }
  for (const s of unfinished) {
    const { namespace = '?', deployment = '?' } = s.labels;
    const k = `${namespace}\u0000${deployment}`;
    if (cells.get(k)?.counts.now || !flagged(rowKey({ section: 'rollout', service: deployment, subject: 'stalled' }))) continue;
    const counts = { ...(cells.get(k)?.counts ?? { h1: 0, d1: 0, d7: 0 }), now: 1 };
    rows.push(rolloutRow(deployment, 'stalled', undefined, counts, `still not complete: ${Math.round(s.value)} replica(s) to update, become available or retire (ns ${namespace})`, unfinishedQuery(src)));
  }
  return rows;
}

export async function collectArgocd(tel: Telemetry, src: Sources, at: Date, windowMin: number): Promise<Row[]> {
  const degradedQ = degradedQuery(src);
  const failedQ = failedSyncQuery(src, windowMin);
  const [degraded, failed] = await Promise.all([
    fourWay(tel, degradedQ, at, (s) => `${s.labels.name}\u0000${s.labels.health_status}`),
    fourWay(tel, failedQ, at, (s) => `${s.labels.name}\u0000${s.labels.phase}`),
    // On, the scrape (argo-cd #1314) must be there: a missing one is a blind spot.
    requireSeries(tel, `argocd_app_info{${dest(src)}}`, at, 'Argo CD app'),
  ]);
  const rows: Row[] = [];
  for (const [k, { counts, labels }] of degraded) {
    if (!(counts.now > 0)) continue;
    const [app, health] = k.split('\u0000') as [string, string];
    rows.push(rolloutRow(app, 'argocd app', health, counts, `Argo CD app ${health} for 5+ min${labels.sync_status ? ` (${labels.sync_status})` : ''}`, degradedQ));
  }
  for (const [k, { counts }] of failed) {
    if (!(counts.now > 0)) continue;
    const [app, phase] = k.split('\u0000') as [string, string];
    rows.push(rolloutRow(app, 'argocd sync', phase, counts, `an Argo CD sync ended ${phase} in the last ${windowMin} min`, failedQ));
  }
  return rows;
}

// ---- deploys (context) --------------------------------------------------------
// Pods per ReplicaSet in one reading, with the image of each container.
interface Pods {
  pods: number;
  images: Map<string, string>; // container → image_spec
}
function byReplicaSet(samples: Sample[]): Map<string, Pods> {
  const out = new Map<string, Pods>();
  for (const s of samples) {
    const { namespace, owner_name: rs, container, image_spec: image } = s.labels;
    if (!rs || !image) continue;
    const k = `${namespace}/${rs}`;
    const e = out.get(k) ?? { pods: 0, images: new Map<string, string>() };
    e.images.set(container ?? '?', image);
    e.pods = Math.max(e.pods, s.value);
    out.set(k, e);
  }
  return out;
}

// The workload's own container (deployment == container in the charts), else its only one.
const imageOf = (p: Pods | undefined, workload: string) => p && (p.images.get(workload) ?? (p.images.size === 1 ? [...p.images.values()][0] : undefined));

// The workload's ReplicaSet with the most pods in a reading, other than `except`.
function runningRs(r: Map<string, Pods>, namespace: string, workload: string, except: string): Pods | undefined {
  let best: Pods | undefined;
  for (const [k, p] of r) {
    const rs = k.slice(namespace.length + 1);
    if (!k.startsWith(`${namespace}/`) || rs === except || !RS_HASH.test(rs) || rs.replace(RS_HASH, '') !== workload) continue;
    if (!best || p.pods > best.pods) best = p;
  }
  return best;
}

// The first minute with every replica updated and available, after one that
// wasn't. Never seen rolling (faster than the scrape) but done: complete, untimed.
function completion(points: Array<[number, number]>, created: number): { minutes?: number; at: number } | undefined {
  let rolling = false;
  for (const [t, v] of points) {
    if (v > 0) rolling = true;
    else if (rolling) return { minutes: Math.max(1, Math.round((t * 1000 - created) / MIN)), at: t * 1000 };
  }
  return points.length && !rolling ? { at: points.at(-1)![0] * 1000 } : undefined;
}

// Previous images are read a minute before each deploy: at most this many
// readings (the newest deploys first); older ones show "previous image not seen".
const MAX_READINGS = 30;

// Deploys of Deployments in the namespaces over the last `hours`, oldest first,
// with images old → new and the rollout state. `workload`: one Deployment.
export async function listDeploys(tel: Telemetry, src: Sources, at: Date, hours: number, workload?: string): Promise<Deploys> {
  const notes: string[] = [];
  const note =
    (what: string) =>
    (e: Error): undefined => {
      notes.push(`${what} not read: ${e.message.slice(0, 200)}`);
      return undefined;
    };
  const [present, created, statefulsets, argocd] = await Promise.all([
    tel.promInstant(`count(kube_replicaset_created{${ns(src)}})`, at),
    tel.promInstant(createdQuery(src, hours, workload), at),
    tel.promInstant(statefulsetsQuery(src, workload), at).catch(note('StatefulSets')),
    src.deploys.argocd ? argocdContext(tel, src, at, hours, workload).catch(note('Argo CD')) : undefined,
  ]);
  // No ReplicaSet series at all is kube-state-metrics gone, not "no deploys".
  if (!((present[0]?.value ?? 0) > 0)) return notRead(at, hours, new Error('deployment metrics missing (no kube_replicaset_created series)'));
  const deploys: Deploy[] = created
    .filter((s) => s.labels.owner_name && s.labels.replicaset && Number.isFinite(s.value))
    .map((s) => ({ namespace: s.labels.namespace ?? '?', workload: s.labels.owner_name!, replicaset: s.labels.replicaset!, at: new Date(s.value * 1000).toISOString(), state: 'unknown' as RolloutState }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.workload.localeCompare(b.workload));
  const out: Deploys = {
    at: at.toISOString(),
    hours,
    deploys,
    statefulsets: (statefulsets ?? []).map((s) => `${s.labels.namespace}/${s.labels.statefulset} → revision ${s.labels.revision}`).sort(),
    ...(argocd ? { argocd } : {}),
    notes,
  };
  if (!deploys.length) return out;

  const minute = (t: number) => Math.floor(t / MIN) * MIN;
  const before = (d: Deploy) => minute(Date.parse(d.at) - MIN);
  const times = [...new Set(deploys.map(before))].sort((a, b) => b - a).slice(0, MAX_READINGS);
  const workloads = [...new Set(deploys.map((d) => d.workload))];
  const [nowRead, earlier, progress, stalled] = await Promise.all([
    tel.promInstant(imagesQuery(src), at).then(byReplicaSet),
    Promise.all(times.map((t) => tel.promInstant(imagesQuery(src), new Date(t)).then(byReplicaSet))),
    tel.promRange(progressQuery(src, workloads), new Date(minute(Date.parse(deploys[0]!.at))), at, 60),
    tel.promInstant(stallQuery(src), at),
  ]);
  const readingAt = new Map(times.map((t, i) => [t, earlier[i]!]));
  const readings = [nowRead, ...earlier];
  const points = new Map(progress.map((s) => [`${s.labels.namespace}/${s.labels.deployment}`, s.points]));
  const stuck = new Set(stalled.map((s) => `${s.labels.namespace}/${s.labels.deployment}`));
  const since = (d: Deploy) => Math.round((at.getTime() - Date.parse(d.at)) / MIN);

  const groups = new Map<string, Deploy[]>();
  for (const d of deploys) groups.set(`${d.namespace}/${d.workload}`, [...(groups.get(`${d.namespace}/${d.workload}`) ?? []), d]);
  const doneAt = new Map<Deploy, number>();
  for (const [key, group] of groups)
    group.forEach((d, i) => {
      const rs = `${d.namespace}/${d.replicaset}`;
      const prev = readingAt.get(before(d));
      d.previous = prev && imageOf(runningRs(prev, d.namespace, d.workload, d.replicaset), d.workload);
      const next = group[i + 1];
      const end = next ? Date.parse(next.at) : at.getTime();
      const pts = (points.get(key) ?? []).filter(([t]) => t * 1000 >= Date.parse(d.at) && t * 1000 <= end);
      const took = completion(pts, Date.parse(d.at));
      if (took) doneAt.set(d, took.at);
      // Done, but its pods are gone and an older ReplicaSet of it runs: rolled back.
      const back = !next && took && !nowRead.has(rs) ? runningRs(nowRead, d.namespace, d.workload, d.replicaset) : undefined;
      if (next) d.state = took ? 'complete' : 'replaced';
      else if (stuck.has(key)) d.state = 'stalled';
      else if (!pts.length) d.state = 'unknown';
      else if (!took) d.state = 'rolling';
      else d.state = back ? 'rolled back' : 'complete';
      if (d.state === 'complete') d.minutes = took?.minutes;
      if (d.state === 'rolling' || d.state === 'stalled') d.minutes = since(d);
      if (back && d.state === 'rolled back') d.now = imageOf(back, d.workload);
    });
  // A ReplicaSet with no pods in those readings (rolled back, or replaced since)
  // is read when its rollout completed.
  const unseen = (d: Deploy) => !readings.some((r) => r.has(`${d.namespace}/${d.replicaset}`));
  const late = [...new Set(deploys.filter(unseen).flatMap((d) => (doneAt.has(d) ? [minute(doneAt.get(d)!)] : [])))].slice(0, MAX_READINGS);
  const lateRead = await Promise.all(late.map((t) => tel.promInstant(imagesQuery(src), new Date(t)).then(byReplicaSet)));
  for (const d of deploys) d.image = imageOf([...readings, ...lateRead].map((r) => r.get(`${d.namespace}/${d.replicaset}`)).find(Boolean), d.workload);
  return out;
}

async function argocdContext(tel: Telemetry, src: Sources, at: Date, hours: number, workload?: string): Promise<{ apps: string[]; syncs: string[] }> {
  const app = workload ? `,name=${q(workload)}` : '';
  const [apps, syncs] = await Promise.all([
    tel.promInstant(`count by (name, sync_status, health_status) (argocd_app_info{${dest(src)}${app},sync_status!="Synced"} or argocd_app_info{${dest(src)}${app},health_status!="Healthy"})`, at),
    tel.promInstant(`sum by (name, phase) (increase(argocd_app_sync_total{${app.slice(1)}}[${Math.round(hours * 60)}m])) > 0 and ${inDest(src)}`, at),
  ]);
  return {
    apps: apps.map((s) => `${s.labels.name} ${s.labels.sync_status}/${s.labels.health_status}`).sort(),
    syncs: syncs.map((s) => `${s.labels.name} ${s.labels.phase} ×${Math.max(1, Math.round(s.value))}`).sort(),
  };
}

// ---- text ---------------------------------------------------------------------
// HH:MMZ, with the date when it isn't the day of `at`.
const clock = (iso: string, at: string) => `${iso.slice(0, 10) === at.slice(0, 10) ? '' : `${iso.slice(5, 10)} `}${iso.slice(11, 16)}Z`;

function parts(spec: string): { name: string; tag?: string | undefined; digest?: string | undefined } {
  const [ref = '', digest] = spec.split('@');
  const last = ref.slice(ref.lastIndexOf('/') + 1);
  const colon = last.lastIndexOf(':');
  return colon > 0 ? { name: last.slice(0, colon), tag: last.slice(colon + 1), digest } : { name: last, digest };
}

// An image_spec as its tag ("1.2645.6"), or the name and a short digest when it has no tag.
export function tagOf(spec: string): string {
  const p = parts(spec);
  return p.tag ?? (p.digest ? `${p.name}@${p.digest.slice(0, 19)}` : p.name);
}

function change(d: Deploy): string {
  if (!d.image) return `image not read${d.previous ? ` (was ${tagOf(d.previous)})` : ''}`;
  if (!d.previous) return `${tagOf(d.image)} (previous image not seen)`;
  if (d.previous === d.image) return `restart, same image ${tagOf(d.image)}`;
  const named = parts(d.previous).name !== parts(d.image).name;
  const show = (s: string) => (named ? `${parts(s).name} ${tagOf(s)}` : tagOf(s));
  return `${show(d.previous)} → ${show(d.image)}`;
}

function stateText(d: Deploy): string {
  switch (d.state) {
    case 'complete':
      return d.minutes !== undefined ? `complete in ${d.minutes} min` : 'complete';
    case 'rolling':
      return `rolling for ${d.minutes} min`;
    case 'stalled':
      return `STALLED (${d.minutes} min since it started)`;
    case 'rolled back':
      return `rolled back: ${d.now ? `${tagOf(d.now)} runs again` : 'an older ReplicaSet runs again'}`;
    case 'replaced':
      return 'replaced by the next deploy before it completed';
    case 'unknown':
      return 'rollout state not read';
  }
}

export const deployLine = (d: Deploy, at: string) => `${clock(d.at, at)} ${d.namespace}/${d.workload}: ${change(d)} · ${stateText(d)}`;

export const deploysHeading = (x: Deploys) => `Deploys in the last ${x.hours} h (new ReplicaSets; scaling is not a deploy)`;

export function deployLines(x: Deploys): string[] {
  if (x.error) return [`- unknown: ${x.error}`];
  return [
    ...(x.deploys.length ? x.deploys.map((d) => `- ${deployLine(d, x.at)}`) : ['- none']),
    ...(x.statefulsets.length ? [`- StatefulSets rolling now: ${x.statefulsets.join(', ')}`] : []),
    ...(x.argocd ? [`- Argo CD apps not Synced and Healthy now: ${x.argocd.apps.join(', ') || 'none'}`, `- Argo CD syncs in the last ${x.hours} h: ${x.argocd.syncs.join(', ') || 'none'}`] : []),
    ...x.notes.map((n) => `- ${n}`),
  ];
}

export const notRead = (at: Date, hours: number, e: Error): Deploys => ({ at: at.toISOString(), hours, deploys: [], statefulsets: [], notes: [], error: e.message.slice(0, 300) });

// A row's service as a Deployment: app == deployment, except the aliases in sources.yaml.
export const workloadFor = (service: string, aliases: Record<string, string>) => aliases[service] ?? service;

// "first flagged 12 min after deploy ecom-service-production 1.2645.6 (12:17Z)":
// the service's last deploy in the 2 h before the row was first flagged. The
// patrol runs every 15 min, so this is when it was flagged, not when it started.
export function afterDeploy(service: string, firstSeen: string, x: Deploys, aliases: Record<string, string>): string | undefined {
  const w = workloadFor(service, aliases);
  const t = Date.parse(firstSeen);
  const d = x.deploys.filter((d) => d.workload === w && Date.parse(d.at) <= t && t - Date.parse(d.at) <= 2 * H).at(-1);
  return d && `first flagged ${Math.round((t - Date.parse(d.at)) / MIN)} min after deploy ${d.workload} ${d.image ? tagOf(d.image) : '(image not read)'} (${clock(d.at, x.at)})`;
}

// One line for a card that is posted anyway; a deploy is never a post of its own.
export function recentDeploys(x: Deploys | undefined, hours = 2, max = 5): string | undefined {
  if (!x?.deploys.length) return undefined;
  const from = Date.parse(x.at) - hours * H;
  const ds = x.deploys.filter((d) => Date.parse(d.at) >= from).reverse();
  if (!ds.length) return undefined;
  const one = (d: Deploy) => `${d.workload} ${d.image ? tagOf(d.image) : '?'} (${clock(d.at, x.at)}, ${d.state})`;
  return `Deploys in the last ${hours} h: ${ds.slice(0, max).map(one).join(', ')}${ds.length > max ? `, +${ds.length - max} more` : ''}`;
}
