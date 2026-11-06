import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Telemetry } from './clients/telemetry.js';
import type { LoadedAgent } from './engine/agent.js';
import { storedChallenge } from './engine/answer.js';
import { finished, verdictOn, type ChallengeResult } from './engine/challenge.js';
import type { EvidenceItem } from './engine/evidence.js';
import { runAgent, type Engine, type ToolFactory } from './engine/run.js';
import { fence, redactDeep, safeJson } from './engine/text.js';
import { taskRows } from './investigate/prompt.js';
import { Report, reportOutput, ReportShape } from './investigate/report.js';
import { monitorTools } from './investigate/tools.js';
import { RANK } from './patrol/issues.js';
import type { Noise } from './patrol/noise.js';
import { urgentKind } from './patrol/summary.js';
import type { Section } from './patrol/types.js';
import { POSTED } from './runner.js';

// An offline eval of the monitor: a past production run (an episode: its
// input.md and evidence.jsonl, from export_run) is run again, with the AI's
// tools answering from that run's recorded tool results instead of telemetry.
// The model calls are real: same store, caps and STOP file as any run. What an
// AI change (prompt, severity rules, model) does is read against prod's own
// reports and a human label.

export const Label = z.object({ expect: z.enum(['post', 'no-post']), severity: ReportShape.severity.optional(), note: z.string().optional() });
export type Label = z.infer<typeof Label>;

export interface Episode {
  dir: string;
  task: string;
  data?: string;
  evidence: EvidenceItem[];
  prod?: Array<Pick<Report, 'title' | 'severity' | 'rows'> & { issue?: string | undefined }>; // output.json
  prodChallenge?: ChallengeResult; // challenge.json
  label?: Label;
}

// input.md as runAgent writes it: a header, then the prompt (the task, and the
// context fenced as data). The model gets that prompt again, byte for byte.
const HEADER = /^# (\S+) @ \S+\n\nengine: .*\ntrigger: .*\nchallenge: .*\n\n/;
const CONTEXT = `\n\n${fence('context', '').slice(0, -'\n>>>'.length)}`;
export function promptOf(md: string): { agent: string; task: string; data?: string } {
  const m = HEADER.exec(md);
  if (!m) throw new Error('input.md does not start with a run header');
  const prompt = md.slice(m[0].length).replace(/\n$/, '');
  const at = prompt.lastIndexOf(CONTEXT);
  if (at < 0 || !prompt.endsWith('\n>>>')) return { agent: m[1]!, task: prompt };
  return { agent: m[1]!, task: prompt.slice(0, at), data: prompt.slice(at + CONTEXT.length, -'\n>>>'.length) };
}

const ProdReports = z.array(Report.pick({ title: true, severity: true, rows: true }).extend({ issue: z.string().optional() }));
const read = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8');

export function loadEpisode(dir: string): Episode {
  for (const f of ['input.md', 'evidence.jsonl']) if (!existsSync(join(dir, f))) throw new Error(`no ${f} (an episode holds a run's input.md and evidence.jsonl)`);
  const p = promptOf(read(dir, 'input.md'));
  if (p.agent !== 'monitor') throw new Error(`input.md is from a ${p.agent} run; the eval runs monitor episodes`);
  const evidence = read(dir, 'evidence.jsonl')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvidenceItem);
  const prodChallenge = storedChallenge(dir);
  return {
    dir,
    task: p.task,
    ...(p.data !== undefined ? { data: p.data } : {}),
    evidence,
    ...(existsSync(join(dir, 'output.json')) ? { prod: ProdReports.parse(JSON.parse(read(dir, 'output.json'))) } : {}),
    ...(prodChallenge ? { prodChallenge } : {}),
    ...(existsSync(join(dir, 'label.json')) ? { label: Label.parse(JSON.parse(read(dir, 'label.json'))) } : {}),
  };
}

export interface Miss {
  by: string;
  tool: string;
  args: unknown; // redacted
}
export interface Tally {
  hits: { author: number; challenger: number };
  misses: Miss[]; // not in the recording
  ambiguous: Miss[]; // recorded more than once with different results
}

// A tool call as the evidence stores it: redacted args (redactDeep, which a
// second pass leaves as they are), keys in a fixed order.
const sorted = (_k: string, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v);
const callKey = (tool: string, args: unknown) => `${tool} ${JSON.stringify(redactDeep(args), sorted)}`;

// Never asked: every handler of the tools below is replaced.
const offline = async (): Promise<never> => {
  throw new Error('an eval reads no telemetry');
};
const OFFLINE: Telemetry = { has: { loki: true, tempo: true }, promInstant: offline, promRange: offline, lokiRange: offline, lokiMetric: offline, tempoSearch: offline };

// The monitor's tools, with their real names, descriptions and schemas,
// answered from a run's recorded results. A call with the same (tool, args) as
// a recorded one gets that result, as a new evidence item of this run, so ids
// and quote checks work as in production; the author's recording is preferred
// for the author, the challenger's for the challenger. Anything else is a miss:
// an error for the model, counted for the eval. So is a call recorded more than
// once with different results (args that differ only in redacted values, say
// two emails): which one it was can't be told, and no order is guessed.
export function recordedTools(items: EvidenceItem[], cfg: Config, tally: Tally): ToolFactory {
  const recorded = new Map<string, EvidenceItem[]>();
  for (const e of items) recorded.set(callKey(e.tool, e.args), [...(recorded.get(callKey(e.tool, e.args)) ?? []), e]);
  return (evidence, by) =>
    monitorTools(OFFLINE, cfg, new Date(0))(evidence, by).map((t) => ({
      ...t,
      handler: async (raw: unknown) => {
        // As the SDK's MCP server hands args to a handler: parsed by the
        // schema (unknown keys dropped). A no-op behind the real server.
        const parsed = z.object(t.inputSchema).safeParse(raw);
        const args: unknown = parsed.success ? parsed.data : raw;
        const found = recorded.get(callKey(t.name, args)) ?? [];
        const pool = found.some((e) => e.by === by) ? found.filter((e) => e.by === by) : found;
        const miss = { by, tool: t.name, args: redactDeep(args) };
        if (!pool.length) {
          tally.misses.push(miss);
          return { content: [{ type: 'text' as const, text: `error: not in this episode's recording: this offline run answers only the tool calls the recorded run made, with the same arguments` }], isError: true };
        }
        if (new Set(pool.map((e) => e.text)).size > 1) {
          tally.ambiguous.push(miss);
          return { content: [{ type: 'text' as const, text: `error: ambiguous in this episode's recording: the recorded run made this call more than once with different results (its arguments may differ only in redacted values), so this offline run can't tell which to answer` }], isError: true };
        }
        const item = pool[0]!;
        tally.hits[by]++;
        // The text exactly as production's model saw it: already redacted and
        // cut to size (cut again, its "[truncated N chars]" would change).
        const ev = Object.assign(evidence.add(by, t.name, args, ''), { text: item.text });
        return { content: [{ type: 'text' as const, text: evidence.stamp(ev) }] };
      },
    }));
}

// A row key (section|service|subject|status) read back into its fields.
function rowOf(key: string) {
  const [section = '', service = '', ...rest] = key.split('|');
  const status = rest.pop() ?? '';
  return { section: section as Section, service, subject: rest.join('|'), status };
}

// The patrol's posting rule (src/runner.ts) with no issue record, where every
// critical or major report is news: it posts once a finished challenge agrees
// with it, and, disagreed or unchecked, only for a protected journey.
export function wouldPost(r: Pick<Report, 'severity' | 'rows'>, item: number, c: ChallengeResult | undefined, noise: Noise): boolean {
  if (!POSTED.has(r.severity)) return false;
  const v = verdictOn(c, item);
  const agreed = !!c && finished(c) && (v ? v.holds === 'yes' : c.verdict === 'upheld');
  return agreed || r.rows.some((k) => noise.protected(rowOf(k)));
}

export interface EvalReport {
  title: string;
  severity: Report['severity'];
  rows: string[];
  issue?: string;
  holds?: 'yes' | 'partly' | 'no'; // the challenger's verdict on it
  posts: boolean;
}

export interface EvalResult {
  episode: string;
  run: { id: string; status: string; note?: string; dir?: string };
  cost: number; // author and challenger
  turns: number; // the author's
  challenge?: { verdict: string; cost: number; turns: number; note?: string };
  reports: EvalReport[];
  hits: Tally['hits'];
  misses: Miss[];
  ambiguous: Miss[];
  // Why this run says nothing either way: it didn't finish, its author got no
  // recorded result, or a challenge it was due didn't finish.
  inconclusive?: string;
  prod?: { reports: EvalReport[]; challenge?: string };
  label?: Label;
  outcome?: 'match' | 'mismatch' | 'inconclusive'; // with a label
}

const view = (reports: NonNullable<Episode['prod']>, c: ChallengeResult | undefined, noise: Noise): EvalReport[] =>
  reports.map((r, i) => {
    const v = verdictOn(c, i + 1);
    return { title: r.title, severity: r.severity, rows: r.rows, ...(r.issue ? { issue: r.issue } : {}), ...(v ? { holds: v.holds } : {}), posts: wouldPost(r, i + 1, c, noise) };
  });

// A label holds when the run posts what it expects (some report, or none) and,
// with a severity, when that is its most severe report's.
function matchLabel(label: Label, reports: EvalReport[]): boolean {
  const top = reports.reduce<EvalReport['severity'] | undefined>((m, r) => (!m || RANK[r.severity] > RANK[m] ? r.severity : m), undefined);
  return reports.some((r) => r.posts) === (label.expect === 'post') && (!label.severity || top === label.severity);
}

// One episode: the monitor on its prompt, with its recorded tools; the
// challenger as the patrol decides it, unless `challenge` is false. Run
// folders go under <episode>/runs; the outcome to <episode>/eval-result.json.
export async function evalEpisode(engine: Engine, agent: LoadedAgent, cfg: Config, noise: Noise, dir: string, o: { challenge?: boolean } = {}): Promise<EvalResult> {
  const ep = loadEpisode(dir);
  const { rows, issues } = taskRows(ep.task);
  if (!rows.length) throw new Error('the task in input.md lists no row keys');
  const tally: Tally = { hits: { author: 0, challenger: 0 }, misses: [], ambiguous: [] };
  // The patrol's challenge gate (needsChallenge and toChannel in src/runner.ts)
  // with no issue record: urgent rows, or a report that would be posted. Row
  // keys tell two kinds of urgent row, rollout rows and protected journeys. The
  // third, a big jump (50+ events and 5× the expected count), needs the row's
  // counts and score: an episode has them only as redacted summary text, not by
  // row key. A run with only big jumps is challenged once a report would post.
  const urgentRows = rows.some((k) => urgentKind(rowOf(k), noise));
  const gate = (reports: Report[]) => urgentRows || reports.some((x) => POSTED.has(x.severity));
  const r = await runAgent<Report>(
    { ...engine, runsDir: join(dir, 'runs') },
    {
      agent,
      trigger: 'eval',
      task: ep.task,
      ...(ep.data !== undefined ? { data: ep.data } : {}),
      tools: recordedTools(ep.evidence, cfg, tally),
      output: reportOutput(new Set(rows), new Set(issues)),
      challenge: o.challenge === false ? false : gate,
    },
  );
  const c = r.challenge;
  const reports = view(r.outputs, c, noise);
  const inconclusive =
    r.status !== 'ok' && r.status !== 'no_output'
      ? `the run ended ${r.status}${r.note ? ` (${r.note})` : ''}`
      : !tally.hits.author
        ? 'the author got no recorded result'
        : r.outputs.length && gate(r.outputs) && !(c && finished(c))
          ? `a challenge was due and ${c ? `did not finish (${c.note ?? c.verdict})` : 'was skipped'}`
          : undefined;
  const result: EvalResult = {
    episode: dir,
    run: { id: r.runId, status: r.status, ...(r.note ? { note: r.note } : {}), ...(r.dir ? { dir: r.dir } : {}) },
    cost: r.cost,
    turns: r.turns,
    ...(c ? { challenge: { verdict: c.verdict, cost: c.cost, turns: c.turns, ...(c.note ? { note: c.note } : {}) } } : {}),
    reports,
    hits: tally.hits,
    misses: tally.misses,
    ambiguous: tally.ambiguous,
    ...(inconclusive ? { inconclusive } : {}),
    ...(ep.prod ? { prod: { reports: view(ep.prod, ep.prodChallenge, noise), ...(ep.prodChallenge ? { challenge: ep.prodChallenge.verdict } : {}) } } : {}),
    ...(ep.label ? { label: ep.label, outcome: inconclusive ? 'inconclusive' : matchLabel(ep.label, reports) ? 'match' : 'mismatch' } : {}),
  };
  writeFileSync(join(dir, 'eval-result.json'), safeJson(result, 1) + '\n');
  return result;
}

const severities = (rs: EvalReport[]) => rs.map((r) => `${r.severity}${r.posts ? ' (posts)' : ''}`).join(', ') || 'none';
const calls = (hits: number, misses: number, ambiguous: number) => `${hits} hit(s), ${misses} miss(es), ${ambiguous} ambiguous: ${misses + ambiguous} of ${hits + misses + ambiguous} call(s) unanswered`;
const hitsOf = (r: EvalResult) => r.hits.author + r.hits.challenger;

export function evalLine(r: EvalResult): string {
  return [
    `${basename(r.episode)}: ${r.run.status}${r.run.note ? ` (${r.run.note})` : ''}`,
    `reports ${severities(r.reports)}`,
    ...(r.prod ? [`prod ${severities(r.prod.reports)}`] : []),
    calls(hitsOf(r), r.misses.length, r.ambiguous.length),
    `${r.turns} turns`,
    `$${r.cost.toFixed(2)}`,
    ...(r.label ? [`label ${r.label.expect}${r.label.severity ? ` ${r.label.severity}` : ''}: ${r.outcome === 'mismatch' ? 'MISMATCH' : r.outcome}`] : []),
    ...(r.inconclusive ? [`inconclusive: ${r.inconclusive}`] : []),
  ].join(' · ');
}

export function evalTotals(rs: EvalResult[], failed = 0): string {
  const n = (o: EvalResult['outcome']) => rs.filter((r) => r.outcome === o).length;
  const sum = (f: (r: EvalResult) => number) => rs.reduce((s, r) => s + f(r), 0);
  return [
    `${rs.length} episode(s)${failed ? `, ${failed} failed` : ''}`,
    `labels: ${n('match')} match, ${n('mismatch')} mismatch, ${n('inconclusive')} inconclusive`,
    calls(sum(hitsOf), sum((r) => r.misses.length), sum((r) => r.ambiguous.length)),
    `$${sum((r) => r.cost).toFixed(2)}`,
  ].join(' · ');
}
