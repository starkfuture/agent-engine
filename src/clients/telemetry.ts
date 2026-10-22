import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../engine/text.js';

export interface Sample {
  labels: Record<string, string>;
  value: number;
}
export interface Series {
  labels: Record<string, string>;
  points: Array<[epochSec: number, value: number]>;
}
export interface LogLine {
  labels: Record<string, string>;
  tsNs: string;
  line: string;
}
export interface TraceHit {
  traceId: string;
  rootService: string;
  rootName: string;
  startSec: number;
  durationMs: number;
}

// Everything the patrol and the investigator may read. Read-only by construction:
// there is no method that writes anywhere.
export interface Telemetry {
  promInstant(query: string, at: Date): Promise<Sample[]>;
  promRange(query: string, start: Date, end: Date, stepSec: number): Promise<Series[]>;
  lokiRange(query: string, start: Date, end: Date, limit: number): Promise<LogLine[]>;
  tempoSearch(traceql: string, start: Date, end: Date, limit: number): Promise<TraceHit[]>;
  readonly has: { loki: boolean; tempo: boolean };
}

export class SourceError extends Error {
  constructor(
    readonly source: 'prometheus' | 'loki' | 'tempo',
    message: string,
  ) {
    super(`${source}: ${message}`);
  }
}

// Caps in-flight requests per backend so a patrol (or an investigation during an
// outage) can't pile load onto a struggling Prometheus or Loki.
class Gate {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

const sec = (d: Date) => Math.floor(d.getTime() / 1000);

type Source = 'prometheus' | 'loki' | 'tempo';
interface Route {
  base: string; // URL prefix; the backend's own API path follows
  headers: Record<string, string>;
}

// Tempo is shared and was overloaded by long-range TraceQL from agents: every
// search is at most this long, and regex matches are refused outright (a guard
// on regex shapes is easy to get round: "^.*", "(.*)").
export const TEMPO_MAX_MINUTES = 30;
export function traceqlProblem(q: string): string | undefined {
  if (/[=!]~/.test(q.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) return 'regex matches (=~, !~) are not allowed on the shared Tempo; match exact values (=, !=)';
  return undefined;
}

// Prometheus, Loki and Tempo over HTTP, either through Grafana's datasource
// proxy (local, with a token) or directly in-cluster (hosted). Same API paths.
class HttpTelemetry implements Telemetry {
  private readonly gates = { prometheus: new Gate(4), loki: new Gate(2), tempo: new Gate(2) };
  readonly has: { loki: boolean; tempo: boolean };

  constructor(
    private readonly routes: { prometheus: Route; loki?: Route | undefined; tempo?: Route | undefined },
    private readonly timeoutMs = 30_000,
    maxInFlight?: number,
  ) {
    this.has = { loki: Boolean(routes.loki), tempo: Boolean(routes.tempo) };
    if (maxInFlight) this.gates.prometheus = new Gate(maxInFlight);
  }

  private async get(source: Source, path: string, params: Record<string, string>) {
    const route = this.routes[source];
    if (!route) throw new SourceError(source, 'not configured');
    const u = new URL(`${route.base}${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return this.gates[source].run(async () => {
      let res: Response;
      try {
        res = await fetch(u, { headers: { ...route.headers, Accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        throw new SourceError(source, (e as Error).message);
      }
      const body = await res.text();
      if (!res.ok) throw new SourceError(source, `HTTP ${res.status}: ${body.slice(0, 300)}`);
      try {
        return JSON.parse(body) as any;
      } catch {
        throw new SourceError(source, `non-JSON response: ${body.slice(0, 200)}`);
      }
    });
  }

  async promInstant(query: string, at: Date): Promise<Sample[]> {
    const j = await this.get('prometheus', '/api/v1/query', { query, time: String(sec(at)) });
    if (j.status !== 'success') throw new SourceError('prometheus', j.error ?? 'query failed');
    return (j.data.result as any[]).map((r) => ({ labels: r.metric ?? {}, value: Number(r.value?.[1]) }));
  }

  async promRange(query: string, start: Date, end: Date, stepSec: number): Promise<Series[]> {
    const j = await this.get('prometheus', '/api/v1/query_range', { query, start: String(sec(start)), end: String(sec(end)), step: String(stepSec) });
    if (j.status !== 'success') throw new SourceError('prometheus', j.error ?? 'query failed');
    return (j.data.result as any[]).map((r) => ({
      labels: r.metric ?? {},
      points: (r.values as [number, string][]).map(([t, v]) => [t, Number(v)] as [number, number]),
    }));
  }

  async lokiRange(query: string, start: Date, end: Date, limit: number): Promise<LogLine[]> {
    const j = await this.get('loki', '/loki/api/v1/query_range', { query, start: `${sec(start)}000000000`, end: `${sec(end)}000000000`, limit: String(limit), direction: 'backward' });
    if (j.status !== 'success') throw new SourceError('loki', j.error ?? 'query failed');
    const out: LogLine[] = [];
    for (const s of j.data.result as any[]) for (const [ts, line] of s.values) out.push({ labels: s.stream ?? {}, tsNs: ts, line });
    return out;
  }

  async tempoSearch(traceql: string, start: Date, end: Date, limit: number): Promise<TraceHit[]> {
    const bad = traceqlProblem(traceql);
    if (bad) throw new SourceError('tempo', bad);
    const from = new Date(Math.max(start.getTime(), end.getTime() - TEMPO_MAX_MINUTES * 60_000));
    const j = await this.get('tempo', '/api/search', { q: traceql, start: String(sec(from)), end: String(sec(end)), limit: String(limit) });
    return ((j.traces ?? []) as any[]).map((t) => ({
      traceId: t.traceID,
      rootService: t.rootServiceName ?? '?',
      rootName: t.rootTraceName ?? '?',
      startSec: Math.floor(Number(t.startTimeUnixNano ?? 0) / 1e9),
      durationMs: Number(t.durationMs ?? 0),
    }));
  }
}

// In-cluster: the backends themselves (no Grafana token; the NetworkPolicy
// allows only these ports). Loki is multi-tenant: X-Scope-OrgID picks ours.
export interface DirectOptions {
  prometheusUrl: string;
  lokiUrl?: string | undefined;
  lokiOrgId?: string | undefined;
  tempoUrl?: string | undefined;
  timeoutMs?: number;
}
export class DirectTelemetry extends HttpTelemetry {
  constructor(o: DirectOptions) {
    const trim = (u: string) => u.replace(/\/$/, '');
    super(
      {
        prometheus: { base: trim(o.prometheusUrl), headers: {} },
        loki: o.lokiUrl ? { base: trim(o.lokiUrl), headers: o.lokiOrgId ? { 'X-Scope-OrgID': o.lokiOrgId } : {} } : undefined,
        tempo: o.tempoUrl ? { base: trim(o.tempoUrl), headers: {} } : undefined,
      },
      o.timeoutMs,
    );
  }
}

export interface GrafanaOptions {
  url: string;
  token: string;
  promUid: string;
  lokiUid?: string | undefined;
  tempoUid?: string | undefined;
  timeoutMs?: number;
  maxInFlight?: number;
}

// Local: through Grafana's datasource proxy with a token.
export class GrafanaTelemetry extends HttpTelemetry {
  constructor(private readonly o: GrafanaOptions) {
    const via = (uid: string): Route => ({ base: `${o.url}/api/datasources/proxy/uid/${encodeURIComponent(uid)}`, headers: { Authorization: `Bearer ${o.token}` } });
    super({ prometheus: via(o.promUid), loki: o.lokiUid ? via(o.lokiUid) : undefined, tempo: o.tempoUid ? via(o.tempoUid) : undefined }, o.timeoutMs, o.maxInFlight);
  }

  // Doctor only: which datasources this token can see.
  async datasources(): Promise<Array<{ uid: string; type: string; name: string }>> {
    const res = await fetch(`${this.o.url}/api/datasources`, {
      headers: { Authorization: `Bearer ${this.o.token}` },
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as any[]).map((d) => ({ uid: d.uid, type: d.type, name: d.name }));
  }
}

// ---- record / replay --------------------------------------------------------
// `export` runs the patrol against prod in recording mode; every response lands in
// a JSONL file keyed by (method, args). Replay serves those responses offline, so
// the 29 Sep incident stays testable after Prometheus retention drops it.

type Call = { m: keyof Omit<Telemetry, 'has'>; a: unknown[] };
const keyOf = (c: Call) =>
  createHash('sha256')
    .update(JSON.stringify([c.m, c.a.map((x) => (x instanceof Date ? x.toISOString() : x))]))
    .digest('hex')
    .slice(0, 32);

export class RecordingTelemetry implements Telemetry {
  readonly has: { loki: boolean; tempo: boolean };
  private readonly file: string;
  constructor(
    private readonly inner: Telemetry,
    dir: string,
  ) {
    this.has = inner.has;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'responses.jsonl');
  }
  private async rec<T>(c: Call, fn: () => Promise<T>): Promise<T> {
    try {
      const r = await fn();
      appendFileSync(this.file, JSON.stringify({ k: keyOf(c), c, r }) + '\n');
      return r;
    } catch (e) {
      appendFileSync(this.file, JSON.stringify({ k: keyOf(c), c, err: String((e as Error).message) }) + '\n');
      throw e;
    }
  }
  promInstant(q: string, at: Date) {
    return this.rec({ m: 'promInstant', a: [q, at] }, () => this.inner.promInstant(q, at));
  }
  promRange(q: string, s: Date, e: Date, st: number) {
    return this.rec({ m: 'promRange', a: [q, s, e, st] }, () => this.inner.promRange(q, s, e, st));
  }
  // Log lines are redacted before they touch disk; replay templates come out the
  // same because templating redacts first anyway.
  lokiRange(q: string, s: Date, e: Date, l: number) {
    return this.rec({ m: 'lokiRange', a: [q, s, e, l] }, async () =>
      (await this.inner.lokiRange(q, s, e, l)).map((x) => ({ ...x, line: redact(x.line) })),
    );
  }
  tempoSearch(q: string, s: Date, e: Date, l: number) {
    return this.rec({ m: 'tempoSearch', a: [q, s, e, l] }, () => this.inner.tempoSearch(q, s, e, l));
  }
}

export class ReplayTelemetry implements Telemetry {
  readonly has = { loki: true, tempo: true };
  private readonly store = new Map<string, { r?: unknown; err?: string }>();
  misses = 0;
  constructor(dir: string) {
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
    if (!files.length) throw new Error(`no recordings in ${dir}`);
    for (const f of files)
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n'))
        if (line) {
          const { k, r, err } = JSON.parse(line);
          this.store.set(k, { r, err });
        }
  }
  private play<T>(c: Call): Promise<T> {
    const hit = this.store.get(keyOf(c));
    const source = c.m.startsWith('prom') ? 'prometheus' : c.m.startsWith('loki') ? 'loki' : 'tempo';
    if (!hit) {
      this.misses++;
      return Promise.reject(new SourceError(source, 'not in recording'));
    }
    if (hit.err) return Promise.reject(new SourceError(source, `recorded error: ${hit.err}`));
    return Promise.resolve(hit.r as T);
  }
  promInstant(q: string, at: Date) {
    return this.play<Sample[]>({ m: 'promInstant', a: [q, at] });
  }
  promRange(q: string, s: Date, e: Date, st: number) {
    return this.play<Series[]>({ m: 'promRange', a: [q, s, e, st] });
  }
  lokiRange(q: string, s: Date, e: Date, l: number) {
    return this.play<LogLine[]>({ m: 'lokiRange', a: [q, s, e, l] });
  }
  tempoSearch(q: string, s: Date, e: Date, l: number) {
    return this.play<TraceHit[]>({ m: 'tempoSearch', a: [q, s, e, l] });
  }
}

export function readToken(file: string): string {
  if (!existsSync(file)) throw new Error(`Grafana token file not found: ${file}`);
  const t = readFileSync(file, 'utf8').trim();
  if (!t) throw new Error(`Grafana token file is empty: ${file}`);
  return t;
}
