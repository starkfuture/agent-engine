import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Config, Sources } from './config.js';
import { ReplayTelemetry, SourceError, type Telemetry } from './clients/telemetry.js';
import { rowMatcher, validRowPattern } from './eval.js';
import { bucketOf } from './patrol/digest.js';
import type { Noise } from './patrol/noise.js';
import { State } from './patrol/state.js';
import { buildSummary, urgent, type FlaggedRow, type Summary } from './patrol/summary.js';
import type { Section, SourceHealth } from './patrol/types.js';
import { needsChallenge } from './runner.js';

// Detector replay (plan 1.2 d): the patrol over recordings, with no AI and no
// Slack, scored against an expect file. It answers three questions a change to
// detection must not make worse: is every labelled problem still flagged, and
// as soon (latency); how many rows does a normal day flag; and how many AI runs
// a day would the gate start (runs/day, for the representative $/day).
//
// Flagged: a patrol flags a problem when its summary.send holds a row whose key
// matches one of the problem's patterns and whose novelty is fresh or worse:
// news that passed the confirm hold (PATROL_CONFIRM_PATROLS) and the noise
// rules. Rows waiting for their second patrol, known rows, reminders and
// suppressed rows don't flag. Per problem it also says when a matching row was
// first urgent (the rows card goes to Slack at once, without the AI) and first
// in an AI run the gate would start.
//
// Nothing is written but what the caller writes from the result: no patrol
// files, no cards, no state, no issue record.

// ---- the expect file --------------------------------------------------------------

// With its zone (Z or ±hh:mm): without one, Date.parse reads the time as the
// machine's local time, and a latency would move with the time zone it runs in.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const iso = z.string().refine((s) => ISO.test(s) && !Number.isNaN(Date.parse(s)), 'an ISO time with its zone, e.g. 2026-10-26T10:22:30Z');
export const ExpectProblem = z.object({
  id: z.string().min(1),
  onset: iso, // when it started; a patrol at or after it may flag it
  // Exact row keys, or JavaScript regexes between slashes, as in label.json.
  rows: z.array(z.string().min(1).refine(validRowPattern, 'neither a row key nor a valid /regex/')).min(1),
  // urgent: the rows card should take it to Slack at once; normal: the AI decides.
  urgency: z.enum(['urgent', 'normal']),
  note: z.string().optional(),
});
export type ExpectProblem = z.infer<typeof ExpectProblem>;

export const ExpectRecording = z
  .object({
    dir: z.string().min(1), // a folder of *.jsonl (export or RecordingTelemetry), relative to the expect file
    name: z.string().min(1).optional(), // default: the folder's name
    from: iso.optional(), // default: export.json's from
    to: iso.optional(), // default: export.json's to
    // config: the sources of SRE_SOURCES_FILE; export: the ones export.json was recorded with (legacy recordings).
    sources: z.enum(['config', 'export']).default('config'),
    // Patrols in the first minutes build the carried state and are not counted per day
    // (an empty state makes chronic rows look new); problems are judged in them all the same.
    warmup_minutes: z.number().int().min(0).default(0),
    problems: z.array(ExpectProblem).default([]), // none: a control day
    note: z.string().optional(),
  })
  .refine((r) => new Set(r.problems.map((p) => p.id)).size === r.problems.length, { message: 'problem ids must be unique in a recording', path: ['problems'] });
export type ExpectRecording = z.infer<typeof ExpectRecording>;

export const Expect = z.object({ recordings: z.array(ExpectRecording).min(1), note: z.string().optional() });
export type Expect = z.infer<typeof Expect>;

// Parses the file; each dir is resolved against the file's folder.
export function loadExpect(file: string): Expect {
  const e = Expect.parse(JSON.parse(readFileSync(file, 'utf8')));
  const recordings = e.recordings.map((r) => ({ ...r, dir: resolve(dirname(file), r.dir) }));
  const names = recordings.map(nameOf);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`${file}: two recordings are named ${dup}; give one a "name"`);
  return { ...e, recordings };
}
const nameOf = (r: ExpectRecording) => r.name ?? basename(r.dir);

// What `export` writes beside its recording.
interface ExportMeta {
  from?: string;
  to?: string;
  stepMinutes?: number;
  windowMinutes?: number;
  sources?: Partial<Sources>;
}
function exportMeta(dir: string): ExportMeta {
  const f = resolve(dir, 'export.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as ExportMeta) : {};
}
// export.json holds the sources as the engine of the day had them: older ones
// lack later fields, which get the defaults sources.yaml would give them.
function exportSources(meta: ExportMeta, dir: string): Sources {
  const s = meta.sources;
  if (!s?.http_families || !s.workloads || !s.logs || !s.traces) throw new Error(`${dir}: "sources": "export" needs an export.json with its sources`);
  return { ...s, error_counters: s.error_counters ?? [], deploys: { aliases: {}, stall_minutes: 10, argocd: false, ...s.deploys } } as Sources;
}

// ---- the gate (gate-sim) ----------------------------------------------------------

// The AI-run gate of patrolOnce (src/runner.ts: owedKnown 306, urgentRows 328,
// pending 333, worthALook 336, the challenger 387) with no buttons and no
// issue record, so no row is claimed. Keep it in step with the runner: the
// test "the gate simulation starts a run exactly when the patrol does"
// (test/detect.test.ts) compares the two.
export interface Gate {
  urgentRows: FlaggedRow[]; // the rows card goes to Slack at once
  owedKnown: FlaggedRow[]; // known rows an earlier run left uncovered
  pending: FlaggedRow[]; // what a run would be asked to cover
  look: FlaggedRow[]; // the pending rows worth a run
  run: boolean;
  challenger: boolean; // challenged whatever the reports say (needsChallenge): urgent rows
}
export function gateOf(s: Summary, state: State, noise: Noise, cfg: Pick<Config, 'attentionFloor' | 'urgentClientErrors'>): Gate {
  const owedKnown = s.known.filter((r) => state.needsInvestigation(r.key));
  const urgentRows = s.send.filter((r) => r.novelty !== 'reminder' && urgent(r, noise, cfg.urgentClientErrors));
  const pending = [...s.send, ...owedKnown].filter((r) => state.needsInvestigation(r.key));
  const look = pending.filter((r) => urgent(r, noise, cfg.urgentClientErrors) || bucketOf({ ...r, novelty: 'fresh' }, cfg.attentionFloor, noise.protected(r)) === 'look');
  const run = look.length > 0;
  return { urgentRows, owedKnown, pending, look, run, challenger: run && needsChallenge(pending, noise, cfg.urgentClientErrors) };
}

// Which rows a run's reports cover, in place of the model: all (the fewest
// runs) or none (each row tried ATTEMPTS times, then given up: the most).
export type Cover = 'all' | 'none';

export interface SimPatrol {
  at: Date;
  summary: Summary;
  gate: Gate;
}

// The patrol at every step from `from` (aligned to the window) to `to`, with
// one carried state, as patrolOnce would run it with the AI on and the
// reports covering rows as `cover` says. Caps, deferral and the buttons are
// not modelled.
export async function* simulate(tel: Telemetry, cfg: Config, noise: Noise, from: Date, to: Date, stepMin: number, cover: Cover): AsyncGenerator<SimPatrol> {
  const state = State.memory();
  for (let t = align(from, cfg.windowMinutes); t <= to; t = new Date(t.getTime() + stepMin * 60_000)) {
    const summary = await buildSummary(tel, cfg, noise, state, t);
    const gate = gateOf(summary, state, noise, cfg);
    if (gate.run) state.investigated(gate.pending, cover === 'all' ? new Set(gate.pending.map((r) => r.key)) : new Set(), 'simulated', true);
    for (const r of summary.send) state.reported(r, t);
    yield { at: t, summary, gate };
  }
}
const align = (d: Date, min: number) => new Date(Math.floor(d.getTime() / (min * 60_000)) * min * 60_000);

// ---- "not in recording" -----------------------------------------------------------

// A query the recording lacks: ReplayTelemetry rejects it with this, per backend.
const NOT_IN_RECORDING = /not in recording/;

// Counts the recording's misses per backend (prometheus, loki, tempo).
class Counted implements Telemetry {
  readonly has: Telemetry['has'];
  readonly misses = { prometheus: 0, loki: 0, tempo: 0 };
  constructor(private readonly inner: Telemetry) {
    this.has = inner.has;
  }
  private async c<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (e) {
      if (e instanceof SourceError && e.message === `${e.source}: not in recording`) this.misses[e.source]++;
      throw e;
    }
  }
  promInstant(...a: Parameters<Telemetry['promInstant']>) {
    return this.c(this.inner.promInstant(...a));
  }
  promRange(...a: Parameters<Telemetry['promRange']>) {
    return this.c(this.inner.promRange(...a));
  }
  lokiRange(...a: Parameters<Telemetry['lokiRange']>) {
    return this.c(this.inner.lokiRange(...a));
  }
  lokiMetric(...a: Parameters<Telemetry['lokiMetric']>) {
    return this.c(this.inner.lokiMetric(...a));
  }
  tempoSearch(...a: Parameters<Telemetry['tempoSearch']>) {
    return this.c(this.inner.tempoSearch(...a));
  }
}

// The patrol sources a row section comes from.
const FROM: Record<Section, (source: string) => boolean> = {
  http: (s) => s.startsWith('http:'),
  drop: (s) => s.startsWith('http:'),
  errors: (s) => s.startsWith('counter:'),
  workload: (s) => s === 'workloads',
  rollout: (s) => s === 'rollouts' || s === 'argocd',
  logs: (s) => s === 'logs',
  traces: (s) => s === 'traces',
};
// The section of a row pattern: a row key's first field, or a regex anchored on
// it (/^rollout\|…/) with no alternation outside a group (/^http\|a|^logs\|b/
// matches two sections). Undefined when the pattern doesn't say for sure: such
// a problem is never "not in recording", so unflagged it is lost, not excused.
export function sectionOf(pattern: string): Section | undefined {
  const re = pattern.startsWith('/') ? pattern.slice(1, -1) : undefined;
  if (re !== undefined && alternates(re)) return undefined;
  const m = re !== undefined ? /^\^([a-z]+)\\\|/.exec(re) : /^([a-z]+)\|/.exec(pattern);
  return m && Object.hasOwn(FROM, m[1]!) ? (m[1] as Section) : undefined;
}
// A `|` outside any group and character class: the regex is an alternation.
function alternates(re: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < re.length; i++) {
    const c = re[i];
    if (c === '\\') i++;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth <= 0) return true;
  }
  return false;
}
// Every source the problem's rows can come from failed this patrol because
// its queries are not in the recording.
function unreadable(sections: Section[], sources: SourceHealth[]): string[] | undefined {
  const blind: string[] = [];
  for (const sec of sections) {
    const rel = sources.filter((s) => FROM[sec](s.source));
    if (!rel.length || !rel.every((s) => !s.ok && NOT_IN_RECORDING.test(s.error ?? ''))) return undefined;
    blind.push(...rel.map((s) => s.source));
  }
  return [...new Set(blind)];
}

// Per patrol source over a recording: read, failed because its queries are not
// in the recording, read with a check that is not (a presence check, the
// targets total), or blind for another reason (a recorded error). Deploy
// context counts as the source "deploys". Never a pass or a fail.
export interface SourceTally {
  source: string;
  patrols: number;
  read: number;
  notInRecording: number;
  partlyNotInRecording: number;
  blind: number;
  error?: string; // the first error that wasn't a miss
}
function tally(t: Map<string, SourceTally>, s: Summary): void {
  const one = (source: string, ok: boolean, error: string | undefined, notes: string[]) => {
    const x = t.get(source) ?? { source, patrols: 0, read: 0, notInRecording: 0, partlyNotInRecording: 0, blind: 0 };
    t.set(source, x);
    x.patrols++;
    if (ok) {
      x.read++;
      if (notes.some((n) => NOT_IN_RECORDING.test(n))) x.partlyNotInRecording++;
    } else if (NOT_IN_RECORDING.test(error ?? '')) x.notInRecording++;
    else {
      x.blind++;
      x.error ??= (error ?? 'unknown error').slice(0, 200);
    }
  };
  for (const x of s.sources) one(x.source, x.ok, x.error, x.note ? [x.note] : []);
  one('deploys', !s.deploys.error, s.deploys.error, s.deploys.notes);
}

// ---- the replay -------------------------------------------------------------------

export interface ProblemResult {
  id: string;
  onset: string;
  urgency: 'urgent' | 'normal';
  note?: string;
  // detected: flagged at or after onset. lost: never, though its sources could be
  // read. not in recording: never, and every source its rows come from failed for
  // want of its queries in every patrol from onset (neither a pass nor a fail).
  status: 'detected' | 'lost' | 'not in recording';
  flaggedAt?: string;
  latencyMin?: number; // flaggedAt − onset (production patrols 30 s after that)
  rows?: string[]; // the matching rows flagged then
  urgentAt?: string; // first patrol at or after onset with a matching row urgent
  urgentLatencyMin?: number;
  aiAt?: string; // first patrol at or after onset whose AI run (the gate, cover all) holds a matching row
  aiLatencyMin?: number;
  urgencyMiss?: true; // detected, labelled urgent, and never urgent at or after onset
  flaggedBeforeOnset?: string; // a matching row flagged before onset: the label may match a chronic row
  notInRecording?: string[]; // with status 'not in recording': the sources
}

export interface RecordingResult {
  name: string;
  dir: string;
  from: string;
  to: string;
  stepMinutes: number;
  windowMinutes: number;
  sourcesFrom: 'config' | 'export'; // the expect file's "sources"
  sourcesSha256: string; // of the sources it was replayed with: two runs compare like with like only if equal
  control: boolean; // no problems: a control day
  patrols: number;
  counted: number; // patrols after the warm-up: the per-day figures count these
  countedFrom: string;
  days: number; // counted × step, in days
  flagged: number; // rows flagged (fresh or worse in send), summed over counted patrols
  flaggedKeys: number; // distinct
  urgent: number; // flagged rows that were urgent
  reminders: number; // send rows that were 6-hour reminders (not flagged)
  waiting: number; // rows held for the confirm patrol
  // AI runs the gate starts (cover all / none). challenger: of the all runs, those
  // challenged whatever the reports say (an urgent row); a run whose report the
  // channel would see as critical or major is challenged too, which only the
  // model decides, so this is a lower bound.
  runs: { all: number; none: number; challenger: number };
  perDay: { flagged: number; runs: { all: number; none: number } };
  problems: ProblemResult[];
  sources: SourceTally[];
  misses: { total: number; prometheus: number; loki: number; tempo: number }; // queries not in the recording
}

export interface DetectResult {
  recordings: RecordingResult[];
  totals: {
    problems: number;
    detected: number;
    lost: number;
    notInRecording: number;
    urgencyMisses: number;
    latencyMin?: { median: number; max: number };
    // Over the control recordings (no problems), counted patrols only.
    control?: { recordings: number; days: number; flaggedPerDay: number; runsPerDay: { all: number; none: number } };
  };
}

const MIN = 60_000;
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const round1 = (n: number) => Math.round(n * 10) / 10;
const minutes = (a: Date, b: Date) => round1((a.getTime() - b.getTime()) / MIN);

export async function detectRecording(rec: ExpectRecording, cfg: Config, noise: Noise, log: (s: string) => void = () => {}): Promise<RecordingResult> {
  const name = nameOf(rec);
  const meta = exportMeta(rec.dir);
  const fromS = rec.from ?? meta.from;
  const toS = rec.to ?? meta.to;
  if (!fromS || !toS) throw new Error(`${name}: no from/to, and no export.json that has them`);
  // A recording answers only the window it was made with: its queries carry it.
  const w = meta.windowMinutes ?? cfg.windowMinutes;
  const step = meta.stepMinutes ?? w;
  // Production patrols once per window. Another step changes what the confirm
  // hold, the recovery hold and runs per day mean, so its figures would not
  // compare with production's or with a baseline's.
  if (step !== w) throw new Error(`${name}: recorded every ${step} min with a ${w}-min window; the detector replay patrols once per window, as production does`);
  const rcfg: Config = { ...cfg, windowMinutes: w, sources: rec.sources === 'export' ? exportSources(meta, rec.dir) : cfg.sources };
  const from = align(new Date(fromS), w);
  const to = new Date(toS);
  const countFrom = new Date(from.getTime() + rec.warmup_minutes * MIN);
  let last = from;
  while (last.getTime() + step * MIN <= to.getTime()) last = new Date(last.getTime() + step * MIN);
  for (const p of rec.problems) if (Date.parse(p.onset) > last.getTime()) throw new Error(`${name}/${p.id}: onset ${p.onset} is after the last patrol of the recording (${last.toISOString()})`);

  const raw = new ReplayTelemetry(rec.dir);
  const tel = new Counted(raw);
  const probs = rec.problems.map((p) => {
    const sections = p.rows.map(sectionOf);
    return { p, on: rowMatcher(p.rows), onset: new Date(p.onset), sections: sections.every((s) => !!s) ? [...new Set(sections as Section[])] : undefined, r: { id: p.id, onset: new Date(p.onset).toISOString(), urgency: p.urgency, ...(p.note ? { note: p.note } : {}) } as ProblemResult, readable: false, blind: new Set<string>() };
  });
  const sources = new Map<string, SourceTally>();
  const keys = new Set<string>();
  const out = { patrols: 0, counted: 0, flagged: 0, urgent: 0, reminders: 0, waiting: 0, all: 0, challenger: 0, none: 0 };
  for await (const { at, summary, gate } of simulate(tel, rcfg, noise, from, to, step, 'all')) {
    out.patrols++;
    tally(sources, summary);
    const news = summary.send.filter((r) => r.novelty === 'fresh' || r.novelty === 'worse');
    if (at >= countFrom) {
      out.counted++;
      out.flagged += news.length;
      for (const r of news) keys.add(r.key);
      out.urgent += gate.urgentRows.length;
      out.reminders += summary.send.length - news.length;
      out.waiting += summary.waiting.length;
      if (gate.run) out.all++;
      if (gate.challenger) out.challenger++;
    }
    for (const x of probs) {
      const hit = news.filter((r) => x.on(r.key));
      if (at < x.onset) {
        if (hit.length) x.r.flaggedBeforeOnset ??= at.toISOString();
        continue;
      }
      if (hit.length && !x.r.flaggedAt) Object.assign(x.r, { flaggedAt: at.toISOString(), latencyMin: minutes(at, x.onset), rows: [...new Set(hit.map((r) => r.key))] });
      if (!x.r.urgentAt && gate.urgentRows.some((r) => x.on(r.key))) Object.assign(x.r, { urgentAt: at.toISOString(), urgentLatencyMin: minutes(at, x.onset) });
      if (!x.r.aiAt && gate.run && gate.pending.some((r) => x.on(r.key))) Object.assign(x.r, { aiAt: at.toISOString(), aiLatencyMin: minutes(at, x.onset) });
      const blind = x.sections ? unreadable(x.sections, summary.sources) : undefined;
      if (blind) for (const s of blind) x.blind.add(s);
      else x.readable = true;
    }
  }
  const misses = { total: raw.misses, ...tel.misses };
  // The same patrols with no row ever covered: the most runs.
  for await (const { at, gate } of simulate(raw, rcfg, noise, from, to, step, 'none')) if (at >= countFrom && gate.run) out.none++;

  const problems = probs.map((x) => {
    const r = x.r;
    r.status = r.flaggedAt ? 'detected' : x.readable ? 'lost' : 'not in recording';
    if (r.status === 'not in recording') r.notInRecording = [...x.blind];
    if (r.status === 'detected' && r.urgency === 'urgent' && !r.urgentAt) r.urgencyMiss = true;
    return r;
  });
  const days = (out.counted * step) / (24 * 60);
  const perDay = (n: number) => (days > 0 ? round1(n / days) : 0);
  log(`${name}: ${out.patrols} patrols, ${misses.total} query(ies) not in the recording`);
  return {
    name,
    dir: rec.dir,
    from: from.toISOString(),
    to: to.toISOString(),
    stepMinutes: step,
    windowMinutes: w,
    sourcesFrom: rec.sources,
    sourcesSha256: sha256(JSON.stringify(rcfg.sources)),
    control: rec.problems.length === 0,
    patrols: out.patrols,
    counted: out.counted,
    countedFrom: countFrom.toISOString(),
    days: Math.round(days * 1000) / 1000,
    flagged: out.flagged,
    flaggedKeys: keys.size,
    urgent: out.urgent,
    reminders: out.reminders,
    waiting: out.waiting,
    runs: { all: out.all, none: out.none, challenger: out.challenger },
    perDay: { flagged: perDay(out.flagged), runs: { all: perDay(out.all), none: perDay(out.none) } },
    problems,
    sources: [...sources.values()],
    misses,
  };
}

export async function detect(e: Expect, cfg: Config, noise: Noise, log?: (s: string) => void): Promise<DetectResult> {
  const recordings: RecordingResult[] = [];
  for (const rec of e.recordings) recordings.push(await detectRecording(rec, cfg, noise, log));
  const all = recordings.flatMap((r) => r.problems);
  const lat = all.flatMap((p) => (p.latencyMin !== undefined ? [p.latencyMin] : [])).sort((a, b) => a - b);
  const control = recordings.filter((r) => r.control && r.counted > 0);
  const cdays = control.reduce((s, r) => s + (r.counted * r.stepMinutes) / (24 * 60), 0);
  const sum = (f: (r: RecordingResult) => number) => control.reduce((s, r) => s + f(r), 0);
  return {
    recordings,
    totals: {
      problems: all.length,
      detected: all.filter((p) => p.status === 'detected').length,
      lost: all.filter((p) => p.status === 'lost').length,
      notInRecording: all.filter((p) => p.status === 'not in recording').length,
      urgencyMisses: all.filter((p) => p.urgencyMiss).length,
      ...(lat.length ? { latencyMin: { median: lat.length % 2 ? lat[(lat.length - 1) / 2]! : round1((lat[lat.length / 2 - 1]! + lat[lat.length / 2]!) / 2), max: lat.at(-1)! } } : {}),
      ...(control.length && cdays > 0
        ? { control: { recordings: control.length, days: Math.round(cdays * 1000) / 1000, flaggedPerDay: round1(sum((r) => r.flagged) / cdays), runsPerDay: { all: round1(sum((r) => r.runs.all) / cdays), none: round1(sum((r) => r.runs.none) / cdays) } } }
        : {}),
    },
  };
}

// 1 on a lost labelled problem. "not in recording" is neither a pass nor a fail.
export const detectExitCode = (r: DetectResult): 0 | 1 => (r.totals.lost > 0 ? 1 : 0);

// ---- output -----------------------------------------------------------------------

const t = (s: string) => s.replace(/:00\.000Z$/, 'Z').replace(/\.000Z$/, 'Z');
const range = (a: number, b: number) => (a === b ? `${a}` : `${a}–${b}`);

export function problemLine(p: ProblemResult): string {
  const head = `  ${p.id} (${p.urgency}): `;
  if (p.status === 'not in recording') return `${head}not in recording: ${p.notInRecording!.join(', ')} (onset ${t(p.onset)})`;
  if (p.status === 'lost') return `${head}LOST: no matching row flagged from onset ${t(p.onset)}${p.flaggedBeforeOnset ? ` (one was flagged before onset, at ${t(p.flaggedBeforeOnset)}: the label may match a chronic row)` : ''}`;
  const rows = p.rows!;
  return [
    `${head}flagged ${t(p.flaggedAt!)}, ${p.latencyMin} min after onset ${t(p.onset)}`,
    p.urgentAt ? `urgent ${t(p.urgentAt)}` : p.urgencyMiss ? 'NOT URGENT (labelled urgent)' : 'not urgent',
    p.aiAt ? `AI run ${t(p.aiAt)}` : 'no AI run',
    `${rows[0]}${rows.length > 1 ? ` +${rows.length - 1}` : ''}`,
  ].join(' · ') + (p.flaggedBeforeOnset ? ` · also flagged before onset, at ${t(p.flaggedBeforeOnset)}` : '');
}

export function recordingLines(r: RecordingResult): string[] {
  const src = (f: (x: SourceTally) => number, what: string) => {
    const xs = r.sources.filter((x) => f(x) > 0).map((x) => `${x.source} ${f(x)}/${x.patrols}`);
    return xs.length ? [`${what}: ${xs.join(', ')}`] : [];
  };
  const m = r.misses;
  const by = (['prometheus', 'loki', 'tempo'] as const).filter((k) => m[k] > 0).map((k) => `${k} ${m[k]}`);
  return [
    `${r.name}${r.control ? ' (control)' : ''}: ${r.patrols} patrols ${t(r.from)} → ${t(r.to)} (step ${r.stepMinutes} min, window ${r.windowMinutes} min, sources from ${r.sourcesFrom === 'export' ? 'export.json' : 'the config'})`,
    ...r.problems.map(problemLine),
    `  counted ${r.counted} patrols from ${t(r.countedFrom)} (${r.days} d): ${r.flagged} flagged rows (${r.flaggedKeys} keys), ${r.urgent} urgent, ${r.reminders} reminders, ${r.waiting} waiting · AI runs ${range(r.runs.all, r.runs.none)} (challenger ${r.runs.challenger}) · per day: ${r.perDay.flagged} flagged, ${range(r.perDay.runs.all, r.perDay.runs.none)} runs`,
    ...[...src((x) => x.notInRecording, 'not in recording'), ...src((x) => x.partlyNotInRecording, 'a check not in recording'), ...src((x) => x.blind, 'blind (not a miss)')].map((l) => `  ${l}`),
    `  ${m.total} query(ies) not in the recording${by.length ? ` (${by.join(', ')})` : ''}`,
  ];
}

export function totalsLine(r: DetectResult): string {
  const x = r.totals;
  const c = x.control;
  return [
    `detector replay: ${r.recordings.length} recording(s)`,
    `${x.problems} problem(s): ${x.detected} detected, ${x.lost} lost, ${x.notInRecording} not in recording${x.urgencyMisses ? `, ${x.urgencyMisses} not urgent as labelled` : ''}`,
    ...(x.latencyMin ? [`latency median ${x.latencyMin.median} min, max ${x.latencyMin.max} min`] : []),
    c ? `control days (${c.recordings}, ${c.days} d): ${c.flaggedPerDay} flagged rows/day, ${range(c.runsPerDay.all, c.runsPerDay.none)} AI runs/day` : 'no control day',
  ].join(' · ');
}

export const detectLines = (r: DetectResult): string[] => [...r.recordings.flatMap(recordingLines), totalsLine(r)];

// The JSON summary a baseline is kept as: the result, with what produced it.
// Two summaries compare like with like (only the build differs) when the
// expect file, the patrol settings, the noise rules and each recording's
// sourcesSha256 are the same.
export function detectJson(r: DetectResult, o: { expect: string; build?: string | undefined; cfg: Config }): unknown {
  const c = o.cfg;
  return {
    kind: 'detector-replay',
    version: 1,
    createdAt: new Date().toISOString(),
    expect: o.expect,
    expectSha256: sha256(readFileSync(o.expect)),
    ...(o.build ? { build: o.build } : {}),
    config: {
      windowMinutes: c.windowMinutes,
      confirmPatrols: c.confirmPatrols,
      recoverAfterMinutes: c.recoverAfterMinutes,
      attentionFloor: c.attentionFloor,
      urgentClientErrors: c.urgentClientErrors,
      sourcesFile: process.env.SRE_SOURCES_FILE ?? 'config/sources.yaml',
      noiseFile: c.noiseFile,
      noiseSha256: existsSync(c.noiseFile) ? sha256(readFileSync(c.noiseFile)) : null,
    },
    exitCode: detectExitCode(r),
    ...r,
  };
}
