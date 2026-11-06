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

// A label says, per problem among the run's rows, what the run should do with
// it. A problem's rows are exact row keys, or JavaScript regexes between
// slashes (/^http\|auth\|/), unanchored; row keys start with their section, so
// never with a slash. A report is on a problem when one of its rows is.
// `expect` decides the posting checks; `actionable` (someone should act on it)
// is recorded, and a problem that is not cannot expect a post. An actionable
// one may expect none: a minor one, say.
const regexOf = (pattern: string): RegExp | undefined => (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/') ? new RegExp(pattern.slice(1, -1)) : undefined);
// A pattern that starts with a slash is a regex or a mistake (/x/i, a lone /):
// as a row key it would match nothing, silently.
const valid = (pattern: string) => {
  if (!pattern.startsWith('/')) return true;
  try {
    return !!regexOf(pattern);
  } catch {
    return false;
  }
};
export const Problem = z
  .object({
    id: z.string().min(1),
    rows: z.array(z.string().min(1).refine(valid, 'neither a row key nor a valid /regex/')).min(1),
    actionable: z.boolean(),
    severity: ReportShape.severity.optional(),
    expect: z.enum(['post', 'no-post']),
    note: z.string().optional(),
  })
  .refine((p) => p.actionable || p.expect === 'no-post', { message: 'a problem that is not actionable cannot expect a post', path: ['expect'] });
export type Problem = z.infer<typeof Problem>;
// v2: the problems. v1, still valid: {expect, severity?, note?}, the whole run
// as one implicit problem over all of the task's rows. A v1 expect or severity
// beside problems is refused, not dropped: it would no longer say anything.
const perProblem = z.undefined({ error: 'with problems, expect and severity go on each problem' }).optional();
const LabelV2 = z
  .object({ problems: z.array(Problem).min(1), note: z.string().optional(), expect: perProblem, severity: perProblem })
  .refine((l) => new Set(l.problems.map((p) => p.id)).size === l.problems.length, { message: 'problem ids must be unique', path: ['problems'] });
const LabelV1 = z.object({ expect: z.enum(['post', 'no-post']), severity: ReportShape.severity.optional(), note: z.string().optional(), problems: z.undefined().optional() });
export const Label = z.union([LabelV2, LabelV1]);
export type Label = z.infer<typeof Label>;
// As Label.parse, with the error of the form the file is in.
export const parseLabel = (json: unknown): Label => (json && typeof json === 'object' && 'problems' in json ? LabelV2 : LabelV1).parse(json);

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
    ...(existsSync(join(dir, 'label.json')) ? { label: parseLabel(JSON.parse(read(dir, 'label.json'))) } : {}),
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

// The material-miss rule (plan 1.2, open question 2), in one place so it is
// easy to change. A material unanswered call makes the episode inconclusive:
// - any ambiguous call (the recording had it, but can't tell which answer);
// - an author miss on a tool the recorded run also called (by its author or
//   challenger): the recording should have been able to answer, so this run
//   went where it can't follow.
// A miss on a tool the recording never had is a new tool (one added since,
// reaching the eval through monitorTools), listed and not material; so is a
// challenger's miss on a recorded tool.
export type MissClass = 'material' | 'new tool, not in recording' | 'not material';
export function classifyMiss(call: Miss, how: 'miss' | 'ambiguous', recorded: ReadonlySet<string>): MissClass {
  if (how === 'ambiguous') return 'material';
  if (!recorded.has(call.tool)) return 'new tool, not in recording';
  return call.by === 'author' ? 'material' : 'not material';
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
  // As the patrol does (runner.ts): a severity rated too high by a finished check is not posted.
  const agreed = !!c && finished(c) && (v ? v.holds === 'yes' && v.severity !== 'too_high' : c.verdict === 'upheld');
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
  material: Array<Miss & { how: 'miss' | 'ambiguous' }>; // the unanswered calls classifyMiss makes material
  newTools: string[]; // missed tools the recording never had: not material
  // Why this run says nothing either way: it didn't finish, its author got no
  // recorded result, a challenge it was due didn't finish, a material
  // unanswered call, or a wrong label (a problem to post that no row of the
  // task is, a row under both a problem to post and one not to).
  inconclusive?: string;
  prod?: { reports: EvalReport[]; challenge?: string };
  label?: Label;
  score?: Score; // with a label
  outcome?: 'match' | 'mismatch' | 'inconclusive'; // with a label
}

const view = (reports: NonNullable<Episode['prod']>, c: ChallengeResult | undefined, noise: Noise): EvalReport[] =>
  reports.map((r, i) => {
    const v = verdictOn(c, i + 1);
    return { title: r.title, severity: r.severity, rows: r.rows, ...(r.issue ? { issue: r.issue } : {}), ...(v ? { holds: v.holds } : {}), posts: wouldPost(r, i + 1, c, noise) };
  });

// ---------- the label against the run's reports ----------

type Severity = Report['severity'];
export interface ProblemScore {
  id: string;
  actionable: boolean;
  expect: Problem['expect'];
  severity?: Severity; // the label's
  inRun: boolean; // one of the task's rows is the problem's
  reports: number; // the run's reports on it
  posted: number; // of them, the ones that would post
  top?: Severity; // what the run made of it: its top posted report's severity, else its top report's
  missed?: true; // expects a post, has a row in the run, and got no post
  severityMiss?: true; // top is not the label's severity
  falsePosts?: number; // posts on a no-post problem
  duplicate?: true; // two or more posts on a problem that expects one
}
export interface Score {
  problems: ProblemScore[];
  unlabelled: number[]; // posted reports on no problem at all (item numbers, from 1): false posts
  missed: number;
  severity: number;
  falsePosts: number; // posted reports on no problem that expects a post, or on any no-post problem
  duplicates: number; // problems posted twice or more
  // A wrong label, so the episode is inconclusive (and no match):
  notInRun: string[]; // problems to post that no row of the task is
  conflicts: string[]; // task rows under both a problem to post and one not to: no report on them can be right
  match: boolean;
}

// The label as problems. v1's implicit one is the whole run, all of the task's
// rows: it can't tell two problems apart, so it counts no duplicates.
export function problemsOf(label: Label, taskRows: readonly string[]): Array<Problem & { implicit?: true }> {
  if (label.problems) return label.problems;
  return [{ id: 'label', rows: [...taskRows], actionable: label.expect === 'post', expect: label.expect, ...(label.severity ? { severity: label.severity } : {}), implicit: true }];
}

const topOf = (rs: readonly EvalReport[]) => rs.reduce<Severity | undefined>((m, r) => (!m || RANK[r.severity] > RANK[m] ? r.severity : m), undefined);
function matcher(patterns: readonly string[]): (row: string) => boolean {
  const exact = new Set(patterns);
  const res = patterns.map(regexOf).filter((re): re is RegExp => !!re);
  return (row) => exact.has(row) || res.some((re) => re.test(row));
}

// Each problem against the reports that would post (plan 1.2 gates). Any of
// these is a mismatch:
// - missed: a problem that expects a post has no posted report on it (one
//   with no row in the run is a label error instead, as is a task row under
//   both a problem to post and one not to);
// - severity: with a label severity, the run's top severity on the problem is
//   another one (its top posted report's, else its top report's, so a no-post
//   problem labelled minor wants a minor report); not judged on a problem
//   missed, falsely posted, or with no row in the run;
// - false post: a posted report on no problem that expects a post, or on any
//   no-post problem;
// - duplicate: two or more posted reports on one problem that expects a post.
export function scoreLabel(label: Label, taskRows: readonly string[], reports: readonly EvalReport[]): Score {
  const problems = problemsOf(label, taskRows).map((p) => ({ p, on: matcher(p.rows) }));
  const scored = problems.map(({ p, on }): ProblemScore => {
    const mine = reports.filter((r) => r.rows.some(on));
    const posted = mine.filter((r) => r.posts);
    const top = topOf(posted.length ? posted : mine);
    const inRun = taskRows.some(on);
    const missed = p.expect === 'post' && inRun && !posted.length;
    const falsePosts = p.expect === 'no-post' ? posted.length : 0;
    return {
      id: p.id,
      actionable: p.actionable,
      expect: p.expect,
      ...(p.severity ? { severity: p.severity } : {}),
      inRun,
      reports: mine.length,
      posted: posted.length,
      ...(top ? { top } : {}),
      ...(missed ? { missed: true as const } : {}),
      ...(p.severity && inRun && !missed && !falsePosts && top !== p.severity ? { severityMiss: true as const } : {}),
      ...(falsePosts ? { falsePosts } : {}),
      ...(p.expect === 'post' && !p.implicit && posted.length > 1 ? { duplicate: true as const } : {}),
    };
  });
  // Is the report on a problem (one that expects that, if given)?
  const lands = (r: EvalReport, expect?: Problem['expect']) => problems.some(({ p, on }) => (!expect || p.expect === expect) && r.rows.some(on));
  const missed = scored.filter((s) => s.missed).length;
  const severity = scored.filter((s) => s.severityMiss).length;
  const falsePosts = reports.filter((r) => r.posts && (!lands(r, 'post') || lands(r, 'no-post'))).length;
  const duplicates = scored.filter((s) => s.duplicate).length;
  const notInRun = scored.filter((s) => s.expect === 'post' && !s.inRun).map((s) => s.id);
  const under = (k: string, expect: Problem['expect']) => problems.some(({ p, on }) => p.expect === expect && on(k));
  const conflicts = taskRows.filter((k) => under(k, 'post') && under(k, 'no-post'));
  return {
    problems: scored,
    unlabelled: reports.flatMap((r, i) => (r.posts && !lands(r) ? [i + 1] : [])),
    missed,
    severity,
    falsePosts,
    duplicates,
    notInRun,
    conflicts,
    match: !missed && !severity && !falsePosts && !duplicates && !notInRun.length && !conflicts.length,
  };
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
  const recorded = new Set(ep.evidence.map((e) => e.tool));
  const unanswered = [...tally.misses.map((m) => ({ ...m, how: 'miss' as const })), ...tally.ambiguous.map((m) => ({ ...m, how: 'ambiguous' as const }))];
  const material = unanswered.filter((m) => classifyMiss(m, m.how, recorded) === 'material');
  const newTools = [...new Set(unanswered.filter((m) => classifyMiss(m, m.how, recorded) === 'new tool, not in recording').map((m) => m.tool))];
  const score = ep.label ? scoreLabel(ep.label, rows, reports) : undefined;
  const reasons = [
    r.status !== 'ok' && r.status !== 'no_output'
      ? `the run ended ${r.status}${r.note ? ` (${r.note})` : ''}`
      : !tally.hits.author
        ? 'the author got no recorded result'
        : r.outputs.length && gate(r.outputs) && !(c && finished(c))
          ? `a challenge was due and ${c ? `did not finish (${c.note ?? c.verdict})` : 'was skipped'}`
          : undefined,
    material.length ? `${material.length} material unanswered call(s): ${material.map((m) => `${m.how === 'ambiguous' ? 'ambiguous' : 'missed'} ${m.tool} (${m.by})`).join(', ')}` : undefined,
    score?.notInRun.length ? `the label's problem(s) to post ${score.notInRun.join(', ')} match no row of the task` : undefined,
    score?.conflicts.length ? `the label puts row(s) ${score.conflicts.join(', ')} under both a problem to post and one not to` : undefined,
  ].filter((x): x is string => !!x);
  const inconclusive = reasons.join('; ') || undefined;
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
    material,
    newTools,
    ...(inconclusive ? { inconclusive } : {}),
    ...(ep.prod ? { prod: { reports: view(ep.prod, ep.prodChallenge, noise), ...(ep.prodChallenge ? { challenge: ep.prodChallenge.verdict } : {}) } } : {}),
    ...(ep.label && score ? { label: ep.label, score, outcome: inconclusive ? 'inconclusive' : score.match ? 'match' : 'mismatch' } : {}),
  };
  writeFileSync(join(dir, 'eval-result.json'), safeJson(result, 1) + '\n');
  return result;
}

const severities = (rs: EvalReport[]) => rs.map((r) => `${r.severity}${r.posts ? ' (posts)' : ''}`).join(', ') || 'none';
const calls = (hits: number, misses: number, ambiguous: number) => `${hits} hit(s), ${misses} miss(es), ${ambiguous} ambiguous: ${misses + ambiguous} of ${hits + misses + ambiguous} call(s) unanswered`;
const hitsOf = (r: EvalResult) => r.hits.author + r.hits.challenger;
const labelName = (l: Label) => (l.problems ? `${l.problems.length} problem(s)` : `${l.expect}${l.severity ? ` ${l.severity}` : ''}`);
const faults = (s: Pick<Score, 'missed' | 'severity' | 'falsePosts' | 'duplicates'>) =>
  [s.missed && `${s.missed} missed`, s.severity && `${s.severity} severity`, s.falsePosts && `${s.falsePosts} false post(s)`, s.duplicates && `${s.duplicates} duplicate(s)`].filter(Boolean).join(', ');

export function evalLine(r: EvalResult): string {
  return [
    `${basename(r.episode)}: ${r.run.status}${r.run.note ? ` (${r.run.note})` : ''}`,
    `reports ${severities(r.reports)}`,
    ...(r.prod ? [`prod ${severities(r.prod.reports)}`] : []),
    calls(hitsOf(r), r.misses.length, r.ambiguous.length),
    ...(r.newTools.length ? [`new tool, not in recording: ${r.newTools.join(', ')}`] : []),
    `${r.turns} turns`,
    `$${r.cost.toFixed(2)}`,
    ...(r.label ? [`label ${labelName(r.label)}: ${r.outcome === 'mismatch' && r.score ? `MISMATCH (${faults(r.score)})` : r.outcome}`] : []),
    ...(r.inconclusive ? [`inconclusive: ${r.inconclusive}`] : []),
  ].join(' · ');
}

// One line per labelled problem, and one for posted reports on no problem.
export function problemLines(r: EvalResult): string[] {
  const s = r.score;
  if (!s) return [];
  const verdict = (p: ProblemScore) =>
    [p.missed && 'MISSED', p.severityMiss && `SEVERITY ${p.top ?? 'none'}, label ${p.severity}`, p.falsePosts && `FALSE POST ×${p.falsePosts}`, p.duplicate && `DUPLICATE ×${p.posted}`].filter(Boolean).join(', ') || 'ok';
  const what = (p: ProblemScore) =>
    p.inRun ? `${p.reports} report(s), ${p.posted} posted${p.top ? `, top ${p.top}` : ''} · ${verdict(p)}` : `no row of it in this run${p.expect === 'post' ? ' · LABEL ERROR (inconclusive)' : ''}`;
  return [
    ...s.problems.map((p) => `  ${p.id} (${p.actionable ? 'actionable' : 'not actionable'}, ${p.expect}${p.severity ? ` ${p.severity}` : ''}): ${what(p)}`),
    ...(s.unlabelled.length ? [`  on no problem: ${s.unlabelled.map((i) => `${r.reports[i - 1]!.severity} "${r.reports[i - 1]!.title}"`).join(', ')} · FALSE POST ×${s.unlabelled.length}`] : []),
    ...(s.conflicts.length ? [`  under a problem to post and one not to: ${s.conflicts.join(', ')} · LABEL ERROR (inconclusive)`] : []),
  ];
}

// The eval's exit code: 1 on any mismatch, any inconclusive episode, or an
// episode that could not run at all (`failed`: a broken folder, say).
export const evalExitCode = (rs: readonly EvalResult[], failed = 0): 0 | 1 => (failed > 0 || rs.some((r) => r.inconclusive !== undefined || r.outcome === 'mismatch') ? 1 : 0);

// Representative $/day (plan 1.2 f): the eval's mean cost per run (author and
// challenger, over the episodes whose run started) × the monitor runs per day
// that a detector replay counts. Undefined when no episode ran.
export interface CostPerDay {
  runs: number;
  perRun: number;
  runsPerDay: number;
  perDay: number;
}
export function costPerDay(rs: ReadonlyArray<Pick<EvalResult, 'cost' | 'run'>>, runsPerDay: number): CostPerDay | undefined {
  if (!Number.isFinite(runsPerDay) || runsPerDay < 0) throw new Error(`runs per day must be a number ≥ 0, not ${runsPerDay}`);
  const ran = rs.filter((r) => r.run.status !== 'skipped');
  if (!ran.length) return undefined;
  const perRun = ran.reduce((s, r) => s + r.cost, 0) / ran.length;
  return { runs: ran.length, perRun, runsPerDay, perDay: perRun * runsPerDay };
}
const perDayText = (d: CostPerDay | undefined, runsPerDay: number) =>
  d ? `$${d.perRun.toFixed(2)}/run × ${d.runsPerDay} runs/day = $${d.perDay.toFixed(2)}/day` : `$/day at ${runsPerDay} runs/day: no episode ran`;

// Problems count in judged episodes only: an inconclusive one says nothing about
// them. An unlabelled inconclusive episode is counted too: it fails the exit code.
export function evalTotals(rs: EvalResult[], failed = 0, runsPerDay?: number): string {
  const n = (o: EvalResult['outcome']) => rs.filter((r) => r.outcome === o).length;
  const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
  const judged = rs.flatMap((r) => (r.score && !r.inconclusive ? [r.score] : []));
  const problems = sum(judged, (s) => s.problems.filter((p) => p.inRun).length);
  const all = { missed: sum(judged, (s) => s.missed), severity: sum(judged, (s) => s.severity), falsePosts: sum(judged, (s) => s.falsePosts), duplicates: sum(judged, (s) => s.duplicates) };
  const unlabelledInconclusive = rs.filter((r) => !r.label && r.inconclusive !== undefined).length;
  return [
    `${rs.length} episode(s)${failed ? `, ${failed} failed` : ''}`,
    `labels: ${n('match')} match, ${n('mismatch')} mismatch, ${n('inconclusive')} inconclusive`,
    ...(unlabelledInconclusive ? [`unlabelled: ${unlabelledInconclusive} inconclusive`] : []),
    ...(rs.some((r) => r.score) ? [`problems: ${problems} judged${faults(all) ? `, ${faults(all)}` : judged.length ? ', all as labelled' : ''}`] : []),
    calls(sum(rs, hitsOf), sum(rs, (r) => r.misses.length), sum(rs, (r) => r.ambiguous.length)),
    `$${sum(rs, (r) => r.cost).toFixed(2)}`,
    ...(runsPerDay !== undefined ? [perDayText(costPerDay(rs, runsPerDay), runsPerDay)] : []),
  ].join(' · ');
}
