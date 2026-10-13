import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Telemetry } from './clients/telemetry.js';
import { investigate, type InvestigationResult } from './investigate/run.js';
import { patrolCard, reportCard } from './output/card.js';
import type { CardSink } from './output/sink.js';
import type { Noise } from './patrol/noise.js';
import type { State } from './patrol/state.js';
import { buildSummary, renderSummary, type Summary } from './patrol/summary.js';

export interface PatrolOptions {
  llm: boolean;
  post: boolean;
  log?: (s: string) => void;
}

export interface PatrolResult {
  summary: Summary;
  investigation?: InvestigationResult;
  cards: string[];
  skippedLlm?: string;
}

const stamp = (iso: string) => iso.replace(/[:.]/g, '').slice(0, 15) + 'Z';

export async function patrolOnce(tel: Telemetry, cfg: Config, noise: Noise, state: State, sink: CardSink, at: Date, o: PatrolOptions): Promise<PatrolResult> {
  const log = o.log ?? (() => {});
  const summary = await buildSummary(tel, cfg, noise, state, at);
  const dir = join(cfg.outDir, 'patrols');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp(summary.at)}.md`), renderSummary(summary) + '\n');
  writeFileSync(join(dir, `${stamp(summary.at)}.json`), JSON.stringify(summary, null, 1));
  log(`patrol ${summary.at}: ${summary.send.length} to send, ${summary.known.length} known, ${summary.suppressed.length} noise, ${summary.recovered.length} recovered, sources down: ${summary.sources.filter((s) => !s.ok).map((s) => s.source).join(', ') || 'none'}`);

  const result: PatrolResult = { summary, cards: [] };
  if (!summary.send.length) {
    state.save();
    return result; // quiet patrol: no LLM call, no card, $0
  }

  // Decide whether the LLM runs. Each reason it doesn't is stated on the card.
  let skip: string | undefined;
  if (!o.llm) skip = 'LLM disabled for this run';
  else if (!cfg.llm.available) skip = 'no LLM credentials configured';
  else if (state.spentToday(at) + cfg.llm.maxUsdPerInvestigation > cfg.llm.dailyCapUsd) skip = `daily cap $${cfg.llm.dailyCapUsd} reached`;

  const covered = new Set<string>();
  if (!skip) {
    log(`investigating ${summary.send.length} row(s) with ${cfg.llm.model}…`);
    const inv = await investigate(tel, cfg, summary, at);
    result.investigation = inv;
    state.addSpend(at, inv.costUsd);
    log(`investigation ${inv.outcome}: ${inv.reports.length} report(s), ${inv.toolCalls} tool call(s), ${inv.turns} turn(s), $${inv.costUsd.toFixed(3)}${inv.note ? ` (${inv.note})` : ''}`);
    const footer = `${cfg.llm.model} · ${inv.toolCalls} tool calls · $${inv.costUsd.toFixed(2)}`;
    for (const [i, r] of inv.reports.entries()) {
      result.cards.push(await sink.emit(reportCard(r, summary.at, footer), `${stamp(summary.at)}-${i + 1}`, o.post && r.severity !== 'noise'));
      r.rows.forEach((k) => covered.add(k));
    }
    if (inv.outcome !== 'ok') skip = `investigator ${inv.outcome}${inv.note ? `: ${inv.note}` : ''}`;
  }

  // Anything the investigator didn't cover still gets reported, as raw rows.
  const uncovered: Summary = { ...summary, send: summary.send.filter((r) => !covered.has(r.key)) };
  if (uncovered.send.length) result.cards.push(await sink.emit(patrolCard(uncovered, skip ?? 'not covered by any report'), `${stamp(summary.at)}-rows`, o.post));
  if (skip) result.skippedLlm = skip;

  for (const r of summary.send) state.reported(r, at);
  state.save();
  return result;
}
