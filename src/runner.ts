import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Telemetry } from './clients/telemetry.js';
import type { LoadedAgent } from './engine/agent.js';
import { runAgent, type Engine, type RunResult } from './engine/run.js';
import { monitorTask } from './investigate/prompt.js';
import { checkReport, Report, ReportShape } from './investigate/report.js';
import { monitorTools } from './investigate/tools.js';
import { patrolCard, reportCard, type Card } from './output/card.js';
import type { CardSink } from './output/sink.js';
import { bucketOf } from './patrol/digest.js';
import type { Noise } from './patrol/noise.js';
import type { Owners } from './patrol/owners.js';
import type { State } from './patrol/state.js';
import { buildSummary, renderSummary, type FlaggedRow, type Summary } from './patrol/summary.js';
import { redact, safeJson } from './engine/text.js';

export interface PatrolOptions {
  llm: boolean;
  post: boolean;
  trigger?: string; // 'patrol' (default) | 'replay' | 'manual'
  log?: (s: string) => void;
  owners?: Owners | undefined; // Slack mentions on posted cards; absent = none
}

export interface PatrolResult {
  summary: Summary;
  investigation?: RunResult<Report>;
  cards: string[];
  slack: string[]; // the cards meant for Slack, sent when posting is on
  skippedLlm?: string;
}

export interface MonitorAgent {
  engine: Engine;
  agent: LoadedAgent;
}

const stamp = (iso: string) => iso.replace(/[:.]/g, '').slice(0, 15) + 'Z';

// Rows the AI must never be able to hide: protected journeys (never_suppress)
// and big jumps. They are posted at once, with or without the AI.
export function urgent(r: FlaggedRow, noise: Noise): boolean {
  return noise.protected(r) || (r.counts.now >= 50 && r.counts.now >= 5 * Math.max(1, r.score.expected));
}

// Deterministic challenge gate: the model's own severity never decides whether
// its work gets challenged. Urgent rows do.
export function needsChallenge(rows: FlaggedRow[], noise: Noise): boolean {
  return rows.some((r) => urgent(r, noise));
}

// Everything else reaches Slack only as an AI report rated one of these. Minor
// and noise reports stay in the run folder, where the MCP answers from them.
export const POSTED: ReadonlySet<Report['severity']> = new Set(['critical', 'major']);

export async function patrolOnce(tel: Telemetry, cfg: Config, noise: Noise, state: State, sink: CardSink, at: Date, o: PatrolOptions, monitor?: MonitorAgent): Promise<PatrolResult> {
  const log = o.log ?? (() => {});
  const summary = await buildSummary(tel, cfg, noise, state, at);
  const dir = join(cfg.outDir, 'patrols');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp(summary.at)}.md`), redact(renderSummary(summary)) + '\n');
  writeFileSync(join(dir, `${stamp(summary.at)}.json`), safeJson(summary, 1));
  log(`patrol ${summary.at}: ${summary.send.length} to send, ${summary.known.length} known, ${summary.suppressed.length} noise, ${summary.recovered.length} recovered, sources down: ${summary.sources.filter((s) => !s.ok).map((s) => s.source).join(', ') || 'none'}`);

  const result: PatrolResult = { summary, cards: [], slack: [] };
  const emit = async (card: Card, name: string, slack: boolean) => {
    const file = await sink.emit(card, name, o.post && slack);
    result.cards.push(file);
    if (slack) result.slack.push(file);
  };
  if (!summary.send.length) {
    state.save();
    return result; // quiet patrol: no LLM call, no card, $0
  }

  // New or worse only: a 6-hour reminder of something already posted isn't news.
  const urgentRows = summary.send.filter((r) => r.novelty !== 'reminder' && urgent(r, noise));
  // A run only for something new and big enough to read (the card's "to look
  // at"): small or still-firing rows on their own don't spend one.
  const worthALook = urgentRows.length > 0 || summary.send.some((r) => bucketOf(r, cfg.attentionFloor, noise.protected(r)) === 'look');

  let skip: string | undefined;
  if (!o.llm) skip = 'LLM disabled for this run';
  else if (!monitor) skip = 'no monitor agent loaded';
  else if (!monitor.engine.llmAvailable) skip = 'no LLM credentials configured';
  else if (!worthALook) skip = 'nothing new above the attention floor';

  // Code's own card goes to Slack only for urgent rows, and first: the AI never
  // delays or hides those. Otherwise it stays on disk and the AI's reports decide.
  const card = patrolCard(summary, skip ? `not investigated: ${skip}` : 'AI investigation started', {
    owners: o.owners,
    floor: cfg.attentionFloor,
    protected: (r) => noise.protected(r),
    ref: `patrols/${stamp(summary.at)}.md`,
  });
  await emit(card, `${stamp(summary.at)}-rows`, urgentRows.length > 0);
  if (urgentRows.length) log(`rows card to Slack: ${urgentRows.length} urgent row(s)`);

  if (!skip && monitor) {
    const rowKeys = new Set(summary.send.map((r) => r.key));
    const challenge = needsChallenge(summary.send, noise);
    log(`investigating ${summary.send.length} row(s) with ${monitor.agent.spec.model}${challenge ? ', then a challenger' : ''}…`);
    let inv: RunResult<Report>;
    try {
      inv = await runAgent<Report>(monitor.engine, {
        agent: monitor.agent,
        trigger: o.trigger ?? 'patrol',
        task: monitorTask([...rowKeys]),
        data: renderSummary(summary),
        tools: monitorTools(tel, cfg, at),
        output: {
          tool: 'submit_report',
          description: 'Submit one report per distinct problem. Call it once for every problem you found (several calls are fine). Invalid reports come back with the reason; fix and resubmit.',
          shape: ReportShape,
          evidenceOf: (r) => r.evidence,
          check: (r) => checkReport(r, rowKeys),
        },
        challenge,
      });
    } catch (e) {
      // The rows card already went out; record why there is no report and keep the state moving.
      result.skippedLlm = `investigator crashed: ${(e as Error).message.slice(0, 200)}`;
      log(result.skippedLlm);
      for (const r of summary.send) state.reported(r, at);
      state.save();
      return result;
    }
    result.investigation = inv;
    log(`investigation ${inv.status}: ${inv.outputs.length} report(s), ${inv.evidence.items.size} tool call(s), ${inv.turns} turn(s), $${inv.cost.toFixed(3)}${inv.challenge ? `, challenge ${inv.challenge.verdict}` : ''}${inv.note ? ` (${inv.note})` : ''}`);
    const footer = `${monitor.agent.spec.model} · ${inv.evidence.items.size} tool calls · $${inv.cost.toFixed(2)} · run ${inv.runId}`;
    const byKey = new Map(summary.send.map((r) => [r.key, r]));
    const ownersOf = (rep: Report) => [...new Set(rep.rows.map((k) => byKey.get(k) && o.owners?.ownerOf(byKey.get(k)!.service)).filter((x): x is string => !!x))];
    for (const [i, r] of inv.outputs.entries()) await emit(reportCard(r, summary.at, footer, inv.challenge, ownersOf(r)), `${stamp(summary.at)}-${i + 1}`, POSTED.has(r.severity));
    log(`${inv.outputs.filter((r) => POSTED.has(r.severity)).length} of ${inv.outputs.length} report(s) rated critical or major go to Slack`);
    if (inv.status !== 'ok') skip = `investigator ${inv.status}${inv.note ? `: ${inv.note}` : ''}`;
  }
  if (skip) result.skippedLlm = skip;

  for (const r of summary.send) state.reported(r, at);
  state.save();
  return result;
}

// One patrol per window, 30 s after each boundary (so the last scrape is in),
// until the process ends, or after `passes` passes (tests). Each pass is
// reported to `onPass` whether or not anything records it.
export async function patrolLoop(o: {
  tel: Telemetry;
  cfg: Config;
  noise: Noise;
  state: State;
  sink: CardSink;
  windowMin: number;
  opts: PatrolOptions;
  monitor?: MonitorAgent | undefined;
  onPass?: ((at: Date, r?: PatrolResult) => void) | undefined;
  passes?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const w = o.windowMin * 60_000;
  for (let i = 0; o.passes === undefined || i < o.passes; i++) {
    const at = new Date(Math.floor(now().getTime() / w) * w);
    // Not `onPass?.(at, await patrolOnce(…))`: optional chaining skips
    // evaluating the arguments, so without a listener there'd be no patrol.
    let r: PatrolResult | undefined;
    try {
      r = await patrolOnce(o.tel, o.cfg, o.noise, o.state, o.sink, at, o.opts, o.monitor);
    } catch (e) {
      o.opts.log?.(`patrol failed: ${(e as Error).message}`);
    }
    o.onPass?.(at, r);
    if (o.passes !== undefined && i + 1 >= o.passes) break;
    await sleep(Math.max(5_000, at.getTime() + w + 30_000 - now().getTime()));
  }
}
