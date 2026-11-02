import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Telemetry } from './clients/telemetry.js';
import type { LoadedAgent } from './engine/agent.js';
import { runAgent, type Engine, type RunResult } from './engine/run.js';
import { monitorTask } from './investigate/prompt.js';
import { checkReport, Report, ReportShape } from './investigate/report.js';
import { monitorTools } from './investigate/tools.js';
import { noticeCard, patrolCard, recoveredCard, reportCard, type Card } from './output/card.js';
import type { CardSink, EmitSlack } from './output/sink.js';
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
  if (noise.protected(r)) return true;
  if (r.measurement) return r.measurement.level === 'critical';
  if (r.section === 'alert') return false; // existing pages remain owned by Prometheus rules
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

export async function patrolOnce(
  tel: Telemetry,
  cfg: Config,
  noise: Noise,
  state: State,
  sink: CardSink,
  at: Date,
  o: PatrolOptions,
  monitor?: MonitorAgent,
): Promise<PatrolResult> {
  const log = o.log ?? (() => {});
  const summary = await buildSummary(tel, cfg, noise, state, at);
  const dir = join(cfg.outDir, 'patrols');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp(summary.at)}.md`), redact(renderSummary(summary)) + '\n');
  writeFileSync(join(dir, `${stamp(summary.at)}.json`), safeJson(summary, 1));
  log(
    `patrol ${summary.at}: ${summary.send.length} to send, ${summary.known.length} known, ${summary.suppressed.length} noise, ${summary.recovered.length} recovered, sources down: ${
      summary.sources
        .filter((s) => !s.ok)
        .map((s) => s.source)
        .join(', ') || 'none'
    }`,
  );

  const result: PatrolResult = { summary, cards: [], slack: [] };
  // slack: queued for the channel (sent when posting is on) with the rows it is about.
  const emit = (card: Card, name: string, slack?: EmitSlack) => {
    const file = sink.emit(card, name, o.post ? slack : undefined);
    result.cards.push(file);
    if (slack) result.slack.push(file);
  };
  // A failed send waits for the next patrol, including when the urgent card
  // was attempted before the investigator. Do not retry it again at finish().
  let slackWaiting = false;
  const flush = async () => {
    if (!o.post || slackWaiting) return;
    const f = await sink.flush(log);
    if (f) slackWaiting = f.pending > 0;
    if (f && f.sent + f.pending + f.failed > 0)
      log(`slack: ${f.sent} sent${f.pending ? `, ${f.pending} waiting for the next patrol` : ''}${f.failed ? `, ${f.failed} failed` : ''}`);
  };
  // Finish by saving the state and delivering any reports/recoveries. Urgent
  // rows take the separate fast path below, before the model starts.
  const finish = async () => {
    state.save();
    if(o.post) sink.outbox?.recordHealth(summary);
    if (o.post && sink.outbox?.threads && summary.recovered.length)
      for (const keys of sink.outbox.groupByThread(summary.recovered))
        sink.emit(recoveredCard(keys, summary.at), `${stamp(summary.at)}-recovered-${keys.length}`, { kind: 'recovered', keys, broadcast: false });
    await flush();
    return result;
  };
  const pending = [...summary.send, ...summary.known].filter((r) => state.needsInvestigation(r.key));
  if (!summary.send.length && !pending.length) return finish();

  // New or worse only: a 6-hour reminder of something already posted isn't news.
  const urgentRows = summary.send.filter((r) => r.novelty !== 'reminder' && urgent(r, noise));
  // A run only for something new and big enough to read (the card's "to look
  // at"): small or still-firing rows on their own don't spend one.
  const toInvestigate = pending.filter((r) => urgent(r, noise) || bucketOf({ ...r, novelty: 'fresh' }, cfg.attentionFloor, noise.protected(r)) === 'look');
  if (!summary.send.length && !toInvestigate.length) return finish();
  const worthALook = toInvestigate.length > 0;

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
  emit(card, `${stamp(summary.at)}-rows`, urgentRows.length ? { kind: 'rows', keys: urgentRows.map((r) => r.key), broadcast: true } : undefined);
  if (urgentRows.length) {
    log(`rows card to Slack: ${urgentRows.length} urgent row(s)`);
    await flush();
  }

  if (!skip && monitor) {
    const rowKeys = new Set(toInvestigate.map((r) => r.key));
    const challenge = needsChallenge(toInvestigate, noise);
    log(`investigating ${toInvestigate.length} row(s) with ${monitor.agent.spec.model}${challenge ? ', then a challenger' : ''}…`);
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
          description:
            'Submit one report per distinct problem. Call it once for every problem you found (several calls are fine). Invalid reports come back with the reason; fix and resubmit.',
          shape: ReportShape,
          evidenceOf: (r) => r.evidence,
          check: (r) => checkReport(r, rowKeys),
        },
        challenge,
      });
    } catch (e) {
      // Alert delivery is independent: record the failed investigation for a
      // bounded retry rather than silently declaring every row handled.
      result.skippedLlm = `investigator crashed: ${(e as Error).message.slice(0, 200)}`;
      log(result.skippedLlm);
      const exhausted = state.investigated(toInvestigate, new Set(), result.skippedLlm, true);
      if (exhausted.length)
        emit(
          noticeCard(
            'Investigation inconclusive',
            `${exhausted.length} signal(s) remain unexplained after two attempts. Alert rules remain active; a human should check the evidence.`,
          ),
          `${stamp(summary.at)}-inconclusive`,
          { kind: 'report', keys: exhausted, broadcast: true },
        );
      for (const r of summary.send) state.reported(r, at);
      return finish();
    }
    result.investigation = inv;
    const exhausted = state.investigated(toInvestigate, new Set(inv.outputs.flatMap((r) => r.rows)), inv.note ?? inv.status, inv.status !== 'skipped', inv.runId);
    if (exhausted.length)
      emit(
        noticeCard('Investigation inconclusive', `${exhausted.length} signal(s) remain unexplained after two attempts. Alert rules remain active; run ${inv.runId}.`),
        `${stamp(summary.at)}-inconclusive`,
        { kind: 'report', keys: exhausted, broadcast: true },
      );
    log(
      `investigation ${inv.status}: ${inv.outputs.length} report(s), ${inv.evidence.items.size} tool call(s), ${inv.turns} turn(s), $${inv.cost.toFixed(3)}${inv.challenge ? `, challenge ${inv.challenge.verdict}` : ''}${inv.note ? ` (${inv.note})` : ''}`,
    );
    const footer = `${monitor.agent.spec.model} · ${inv.evidence.items.size} tool calls · $${inv.cost.toFixed(2)} · run ${inv.runId}`;
    const byKey = new Map([...summary.send,...summary.known].map((r) => [r.key, r]));
    const ownersOf = (rep: Report) => [...new Set(rep.rows.map((k) => byKey.get(k) && o.owners?.ownerOf(byKey.get(k)!.service)).filter((x): x is string => !!x))];
    for (const [i, r] of inv.outputs.entries())
      emit(
        reportCard(r, summary.at, footer, inv.challenge, ownersOf(r)),
        `${stamp(summary.at)}-${i + 1}`,
        POSTED.has(r.severity) ? { kind: 'report', keys: r.rows, broadcast: true,urgent:r.severity==='critical'||r.rows.some(k=>byKey.has(k)&&urgent(byKey.get(k)!,noise)) } : undefined,
      );
    log(`${inv.outputs.filter((r) => POSTED.has(r.severity)).length} of ${inv.outputs.length} report(s) rated critical or major go to Slack`);
    if (inv.status !== 'ok') skip = `investigator ${inv.status}${inv.note ? `: ${inv.note}` : ''}`;
  }
  if (skip) result.skippedLlm = skip;

  for (const r of summary.send) state.reported(r, at);
  return finish();
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
