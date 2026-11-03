import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Telemetry } from './clients/telemetry.js';
import type { LoadedAgent } from './engine/agent.js';
import { runAgent, type Engine, type RunResult } from './engine/run.js';
import { monitorTask } from './investigate/prompt.js';
import { checkReport, Report, ReportShape } from './investigate/report.js';
import { monitorTools } from './investigate/tools.js';
import { patrolCard, recoveredCard, reportCard, worseCard, type Card, type IssueRef } from './output/card.js';
import type { CardSink, EmitSlack } from './output/sink.js';
import { bucketOf } from './patrol/digest.js';
import { MUTE_DAYS, type Disposition, type Issue, type Issues, type Severity } from './patrol/issues.js';
import type { Noise } from './patrol/noise.js';
import type { Owners } from './patrol/owners.js';
import { ATTEMPTS, type State } from './patrol/state.js';
import { buildSummary, renderSummary, type FlaggedRow, type Summary } from './patrol/summary.js';
import { redact, safeJson } from './engine/text.js';

export interface PatrolOptions {
  llm: boolean;
  post: boolean;
  trigger?: string; // 'patrol' (default) | 'replay' | 'manual'
  log?: (s: string) => void;
  owners?: Owners | undefined; // Slack mentions on posted cards; absent = none
  issues?: Issues | undefined; // the issue record (engine.db); absent = every report stands alone, as before
  // The buttons are on (SLACK_APP_TOKEN with the bot): On it and Not an issue
  // change what is posted and investigated. Off: clicks stay in the record,
  // ignored until they are back on.
  buttons?: boolean | undefined;
}

export interface PatrolResult {
  summary: Summary;
  investigation?: RunResult<Report>;
  cards: string[];
  slack: string[]; // the cards meant for Slack, sent when posting is on
  skippedLlm?: string;
  filed: Filing[]; // per AI report, in order: what it did to the issue record
  resolved: string[]; // issues whose rows were all back to normal this patrol
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

// What one AI report did to the issue record. The posting rule reads it.
export type Filing =
  | { action: 'none' } // no issue record, or "new" and not posted (minor, noise)
  | { action: 'opened'; issue: Issue }
  | { action: 'linked'; issue: Issue } // same cause, same or lower severity; or not posted
  | { action: 'raised'; issue: Issue; from: Severity; unmuted?: boolean } // unmuted: it ended a Not an issue mute
  | { action: 'reopened'; issue: Issue } // it was resolved and came back
  | { action: 'reminded'; issue: Issue } // same cause, but the channel has heard nothing about it for REMIND_HOURS
  | { action: 'muted'; issue: Issue }; // same cause, and someone said Not an issue: not posted

// An open issue whose rows never all recover (a chronic one) would otherwise
// hide every later report in its thread for good: at most once in this many
// hours, a report linked to it is shown in the channel again.
export const REMIND_HOURS = 24;

export interface FileOptions {
  // When the channel last saw a post about the issue, once Slack accepted it
  // (the outbox). Unset, or nothing delivered yet: the record's queued news.
  newsAt?: ((issue: string) => string | undefined) | undefined;
  newsPending?: ((issue: string) => boolean) | undefined; // news for the channel about it still queued: no reminder on top
  clicks?: boolean | undefined; // the buttons are on: On it and Not an issue apply
  breaksMute?: ((key: string) => boolean) | undefined; // a row Not an issue can't silence (see breaksMute)
}

export function fileReport(issues: Issues, r: Report, at: Date, run?: string, o: FileOptions = {}): Filing {
  const filed = { title: r.title, severity: r.severity, rows: r.rows, hypothesis: r.cause.hypothesis, run };
  if (r.issue === 'new') return POSTED.has(r.severity) ? { action: 'opened', issue: issues.open(filed, at) } : { action: 'none' };
  // A recurrence reopens the issue only when it is worth posting.
  const l = issues.link(r.issue, filed, at, { reopen: POSTED.has(r.severity) });
  if (l.reopenedFrom) return { action: 'reopened', issue: l.issue };
  // The buttons: On it and Not an issue last until the issue resolves.
  const d = o.clicks ? issues.disposition(l.issue.id, at) : undefined;
  if (l.raisedFrom) {
    // A rise to critical ends Not an issue: it is news again.
    if (d?.kind === 'dismissed') issues.liftMute(l.issue.id, at, run);
    return { action: 'raised', issue: l.issue, from: l.raisedFrom, ...(d?.kind === 'dismissed' ? { unmuted: true } : {}) };
  }
  if (d?.kind === 'dismissed' && !r.rows.some((k) => o.breaksMute?.(k))) return { action: 'muted', issue: l.issue };
  // Someone is on it: no reminder in the channel.
  const news = o.newsAt?.(l.issue.id) ?? l.lastNewsAt;
  if (POSTED.has(r.severity) && d?.kind !== 'acknowledged' && news && at.getTime() - Date.parse(news) >= REMIND_HOURS * 3600_000 && !o.newsPending?.(l.issue.id)) {
    issues.remind(l.issue.id, at, run);
    return { action: 'reminded', issue: l.issue };
  }
  return { action: 'linked', issue: l.issue };
}

// The posting rule. News (a new issue, a higher severity, a recurrence) is a
// new message or a broadcast reply; the same cause again is a quiet reply in
// the issue's thread, or nothing where there is no thread (the webhook).
export function postFor(f: Filing, r: Report): EmitSlack | undefined {
  if (!POSTED.has(r.severity) || f.action === 'muted') return undefined;
  if (f.action === 'none') return { kind: 'report', keys: r.rows, broadcast: true };
  if (f.action === 'linked') return { kind: 'report', keys: r.rows, broadcast: false, issue: f.issue.id, repeat: true };
  return { kind: 'report', keys: r.rows, broadcast: true, issue: f.issue.id };
}

// Posts that @mention the on-call (SLACK_ONCALL): critical news only, as a new
// issue, a rise to critical or a return as critical. Never a quiet repeat, a
// reminder, a major or a recovery. Without an issue record, a critical report
// the model calls new.
export function pagesOncall(f: Filing, r: Report): boolean {
  if (r.severity !== 'critical') return false;
  return f.action === 'opened' || f.action === 'raised' || f.action === 'reopened' || (f.action === 'none' && r.issue === 'new');
}

const issueRef = (f: Filing): IssueRef | undefined =>
  f.action === 'none' ? undefined : { id: f.issue.id, title: f.issue.title, change: f.action === 'opened' ? 'new' : f.action === 'linked' || f.action === 'reminded' || f.action === 'muted' ? 'update' : f.action, ...(f.action === 'raised' ? { from: f.from } : {}) };

function filingNote(f: Filing, r: Report): string {
  switch (f.action) {
    case 'none':
      return POSTED.has(r.severity) ? 'no issue record: posted on its own' : `${r.severity}: not posted`;
    case 'opened':
      return `opened ${f.issue.id} (${r.severity})`;
    case 'linked':
      return `linked to ${f.issue.id} (${POSTED.has(r.severity) ? 'no broadcast' : `${r.severity}: not posted`})`;
    case 'raised':
      return `linked to ${f.issue.id}: severity ${f.from} → ${r.severity} (broadcast${f.unmuted ? '; ends Not an issue' : ''})`;
    case 'reopened':
      return `reopened ${f.issue.id}: it came back (broadcast)`;
    case 'reminded':
      return `linked to ${f.issue.id}: open with no news in the channel for ${REMIND_HOURS} h (broadcast)`;
    case 'muted':
      return `linked to ${f.issue.id} (Not an issue: not posted)`;
  }
}

// Rows Not an issue can't silence: protected journeys, and new or worse big
// jumps (urgent). They take the usual path: the rows card in the issue's
// thread, shown in the channel, and an AI run. The mute itself stays.
export function breaksMute(r: FlaggedRow, noise: Noise): boolean {
  return noise.protected(r) || ((r.novelty === 'fresh' || r.novelty === 'worse') && urgent(r, noise));
}

// Rows of an issue someone clicked On it or Not an issue on get no AI run.
// On it: rows that got worse (or came back) get one line by code in its
// thread, not shown in the channel. Not an issue: nothing, while the mute lasts.
// Protected journeys are never claimed, nor big jumps under Not an issue.
export function claimedRows(issues: Issues | undefined, rows: FlaggedRow[], noise: Noise, at: Date): Map<string, Disposition & { issue: string }> {
  if (!issues) return new Map();
  const claims = issues.claims(rows.filter((r) => !noise.protected(r)).map((r) => r.key), at);
  for (const r of rows) if (claims.get(r.key)?.kind === 'dismissed' && breaksMute(r, noise)) claims.delete(r.key);
  return claims;
}

export async function patrolOnce(tel: Telemetry, cfg: Config, noise: Noise, state: State, sink: CardSink, at: Date, o: PatrolOptions, monitor?: MonitorAgent): Promise<PatrolResult> {
  const log = o.log ?? (() => {});
  const summary = await buildSummary(tel, cfg, noise, state, at);
  const dir = join(cfg.outDir, 'patrols');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp(summary.at)}.md`), redact(renderSummary(summary)) + '\n');
  writeFileSync(join(dir, `${stamp(summary.at)}.json`), safeJson(summary, 1));
  log(`patrol ${summary.at}: ${summary.send.length} to send, ${summary.known.length} known, ${summary.suppressed.length} noise, ${summary.recovered.length} recovered, sources down: ${summary.sources.filter((s) => !s.ok).map((s) => s.source).join(', ') || 'none'}`);

  const result: PatrolResult = { summary, cards: [], slack: [], filed: [], resolved: [] };
  // The issue record must never stop a patrol: on a database error the reports
  // are posted on their own, as before the record existed.
  const record = <T>(what: string, f: () => T, fallback: T): T => {
    try {
      return f();
    } catch (e) {
      log(`issues: ${what} failed: ${(e as Error).message.slice(0, 200)}`);
      return fallback;
    }
  };
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
    if (f && f.sent + f.pending + f.failed > 0) log(`slack: ${f.sent} sent${f.pending ? `, ${f.pending} waiting for the next patrol` : ''}${f.failed ? `, ${f.failed} failed` : ''}`);
  };
  // Finish by saving the state and delivering any reports/recoveries. Urgent
  // rows take the separate fast path below, before the model starts.
  const finish = async () => {
    state.save();
    // An issue is resolved once every row of it is back to normal (which needs
    // healthy observers), with one recovery note in its thread. Its rows get no
    // recovery note of their own, also while some of them still fire.
    let loose = summary.recovered;
    const issues = o.issues;
    if (issues) {
      const open = record('listing open issues', () => issues.openIssues(), []);
      const held = new Set(open.flatMap((i) => i.rows));
      loose = summary.recovered.filter((k) => !held.has(k));
      for (const i of open) {
        const back = i.rows.filter((k) => state.recoveredAt(k) !== undefined).length;
        if (back < i.rows.length) {
          if (i.rows.some((k) => summary.recovered.includes(k))) log(`${i.id}: ${back} of ${i.rows.length} row(s) back to normal, still open`);
          continue;
        }
        if (!record(`resolving ${i.id}`, () => (issues.resolve(i.id, at), true), false)) continue;
        result.resolved.push(i.id);
        log(`${i.id} resolved: all ${i.rows.length} row(s) back to normal`);
        emit(recoveredCard(i.rows, summary.at, i.id), `${stamp(summary.at)}-resolved-${i.id}`, sink.outbox?.threads ? { kind: 'recovered', keys: i.rows, broadcast: false, issue: i.id } : undefined);
        if (o.post) sink.outbox?.updateRoot(i.id); // its message says resolved, without buttons
      }
    }
    if (o.post && sink.outbox?.threads && loose.length)
      for (const keys of sink.outbox.groupByThread(loose)) sink.emit(recoveredCard(keys, summary.at), `${stamp(summary.at)}-recovered-${keys.length}`, { kind: 'recovered', keys, broadcast: false });
    await flush();
    return result;
  };
  // A Not an issue mute ends after MUTE_DAYS even if the issue never resolves.
  if (o.issues && o.buttons)
    for (const id of record('ending mutes', () => o.issues!.endMutes(at), [])) {
      log(`${id}: Not an issue ended after ${MUTE_DAYS} days; its rows are investigated again`);
      if (o.post) sink.outbox?.updateRoot(id);
    }

  // Rows still owed an answer from an earlier patrol (see below) are held back
  // by a click too.
  const owedKnown = summary.known.filter((r) => state.needsInvestigation(r.key));
  // The buttons: rows of an issue someone is on, or said is not an issue, are
  // left out of the AI run and of the rows card (see claimedRows).
  const claims = record('reading the buttons', () => claimedRows(o.buttons ? o.issues : undefined, [...summary.send, ...owedKnown], noise, at), new Map());
  const send = claims.size ? summary.send.filter((r) => !claims.has(r.key)) : summary.send;
  const shown = claims.size ? { ...summary, send } : summary; // for the rows card and the investigator
  const byIssue = new Map<string, FlaggedRow[]>();
  for (const r of summary.send) {
    const c = claims.get(r.key);
    if (c) byIssue.set(c.issue, [...(byIssue.get(c.issue) ?? []), r]);
  }
  for (const [id, rows] of byIssue) {
    const c = claims.get(rows[0]!.key)!;
    const worse = c.kind === 'acknowledged' ? rows.filter((r) => r.novelty === 'worse' || r.novelty === 'fresh') : [];
    log(`${id}: ${rows.length} row(s) not investigated: ${c.kind === 'acknowledged' ? `On it${worse.length ? `, ${worse.length} worse: a line in its thread` : ''}` : 'Not an issue'}`);
    if (!worse.length) continue;
    const lines = worse.map((r) => ({ key: r.key, now: r.counts.now, was: state.data.rows[r.key]?.lastReportedNow }));
    emit(worseCard(lines, summary.at, id, c.by), `${stamp(summary.at)}-worse-${id}`, { kind: 'rows', keys: worse.map((r) => r.key), broadcast: false, issue: id, repeat: true });
    record(`noting worse rows on ${id}`, () => o.issues!.noteWorse(id, at, worse.map((r) => r.key)), undefined);
  }

  // New or worse only: a 6-hour reminder of something already posted isn't news.
  const urgentRows = send.filter((r) => r.novelty !== 'reminder' && urgent(r, noise));
  // The rows the investigator still owes an answer: new or worse, or left
  // uncovered by an earlier run. A reminder of a row it already explained is
  // not one: it would only be reported again. A row held back by a click isn't
  // in the run, so its record is left as it is: neither an attempt nor a deferral.
  const pending = [...send, ...owedKnown.filter((r) => !claims.has(r.key))].filter((r) => state.needsInvestigation(r.key));
  // A run only for a row big enough to read (the card's "to look at", sized as
  // if new): small rows on their own don't spend one.
  const worthALook = pending.some((r) => urgent(r, noise) || bucketOf({ ...r, novelty: 'fresh' }, cfg.attentionFloor, noise.protected(r)) === 'look');

  let skip: string | undefined;
  if (!o.llm) skip = 'LLM disabled for this run';
  else if (!monitor) skip = 'no monitor agent loaded';
  else if (!monitor.engine.llmAvailable) skip = 'no LLM credentials configured';
  else if (!worthALook) skip = send.length ? 'nothing new above the attention floor' : 'every row belongs to an issue someone clicked On it or Not an issue on';
  // Quiet patrol: no LLM call, no card, $0. Rows owed an answer from an
  // earlier patrol make it a patrol only when they can be investigated now.
  if (!summary.send.length && skip) return finish();

  // Code's own card goes to Slack only for urgent rows, and first: the AI never
  // delays or hides those. Otherwise it stays on disk and the AI's reports decide.
  // A protected journey among the urgent rows needs a person now: the card mentions the on-call.
  const oncall = urgentRows.some((r) => noise.protected(r)) ? cfg.slackOncall : undefined;
  const card = patrolCard(shown, skip ? `not investigated: ${skip}` : 'AI investigation started', {
    owners: o.owners,
    oncall,
    floor: cfg.attentionFloor,
    protected: (r) => noise.protected(r),
    ref: `patrols/${stamp(summary.at)}.md`,
  });
  // Urgent rows that all belong to one open issue go into its thread, still broadcast.
  const rowsIssue = urgentRows.length && o.issues ? record('finding the issue of urgent rows', () => o.issues!.holding(urgentRows.map((r) => r.key)), undefined) : undefined;
  // A patrol with only rows owed from earlier patrols writes no card: its run is the record.
  if (summary.send.length) emit(card, `${stamp(summary.at)}-rows`, urgentRows.length ? { kind: 'rows', keys: urgentRows.map((r) => r.key), broadcast: true, issue: rowsIssue?.id } : undefined);
  // The channel heard about the issue: that restarts its reminder clock.
  if (rowsIssue && o.post) record(`noting the rows card on ${rowsIssue.id}`, () => o.issues!.rowsPosted(rowsIssue.id, at, urgentRows.map((r) => r.key)), undefined);
  if (urgentRows.length) {
    log(`rows card to Slack: ${urgentRows.length} urgent row(s)${rowsIssue ? ` (in ${rowsIssue.id}'s thread)` : ''}`);
    await flush();
  }

  if (!skip && monitor) {
    const rowKeys = new Set(pending.map((r) => r.key));
    // The issues the investigator may link to: open, or resolved in the last 24 h.
    const none = { issues: [], more: 0 };
    const listed = o.issues ? record('listing issues', () => o.issues!.listed(at), none) : none;
    const issueIds = new Set(listed.issues.map((i) => i.id));
    const challenge = needsChallenge(pending, noise);
    log(`investigating ${pending.length} row(s) with ${monitor.agent.spec.model}${challenge ? ', then a challenger' : ''}…`);
    // Rows no report covered stay pending for another attempt, then are given
    // up: in the log and the state file, never a Slack post.
    const investigated = (covered: Set<string>, outcome: string, attempted: boolean, runId?: string) => {
      const gaveUp = state.investigated(pending, covered, outcome, attempted, runId);
      if (gaveUp.length) log(`gave up on ${gaveUp.length} row(s) after ${ATTEMPTS} attempts: ${gaveUp.join(', ')}`);
    };
    // One skipped run per hold, not one per patrol: while the cap or the kill
    // switch that refused an earlier run still holds, the refusal isn't recorded
    // again. A daily cap ends with its UTC day.
    const now = monitor.engine.now?.() ?? new Date();
    const hold = state.data.held;
    const heldBy = hold && (!/daily cap/.test(hold.reason) || hold.since.slice(0, 10) === now.toISOString().slice(0, 10)) ? hold.reason : undefined;
    let inv: RunResult<Report>;
    let admitted = false;
    try {
      inv = await runAgent<Report>(monitor.engine, {
        agent: monitor.agent,
        trigger: o.trigger ?? 'patrol',
        task: monitorTask([...rowKeys], listed),
        data: renderSummary(shown),
        tools: monitorTools(tel, cfg, at),
        output: {
          tool: 'submit_report',
          description: 'Submit one report per distinct problem. Call it once for every problem you found (several calls are fine). Invalid reports come back with the reason; fix and resubmit.',
          shape: ReportShape,
          evidenceOf: (r) => r.evidence,
          check: (r) => checkReport(r, rowKeys, issueIds),
        },
        challenge,
        heldBy,
        onAdmitted: () => {
          admitted = true;
        },
      });
    } catch (e) {
      // The rows card already went out; record why there is no report and keep the state moving.
      result.skippedLlm = `investigator crashed: ${(e as Error).message.slice(0, 200)}`;
      log(result.skippedLlm);
      // Before admission (the store locked, say), nothing ran: a deferral. After it, an attempt.
      investigated(new Set(), result.skippedLlm, admitted);
      for (const r of summary.send) state.reported(r, at);
      return finish();
    }
    if (hold && heldBy !== undefined && inv.status === 'skipped' && inv.note === heldBy) {
      investigated(new Set(), hold.reason, false, hold.runId);
      result.skippedLlm = `deferred: ${hold.reason} (since ${hold.since}, run ${hold.runId})`;
      log(result.skippedLlm);
      for (const r of summary.send) state.reported(r, at);
      return finish();
    }
    if (inv.status === 'skipped') state.data.held = { reason: inv.note ?? 'skipped', since: now.toISOString(), runId: inv.runId };
    else delete state.data.held;
    result.investigation = inv;
    // Not admitted (caps, the kill switch on) or stopped (the kill switch, a cancel): deferred, not an attempt.
    investigated(new Set(inv.outputs.flatMap((r) => r.rows)), inv.note ?? inv.status, inv.status !== 'skipped' && inv.status !== 'stopped', inv.runId);
    log(`investigation ${inv.status}: ${inv.outputs.length} report(s), ${inv.evidence.items.size} tool call(s), ${inv.turns} turn(s), $${inv.cost.toFixed(3)}${inv.challenge ? `, challenge ${inv.challenge.verdict}` : ''}${inv.note ? ` (${inv.note})` : ''}`);
    const footer = `${monitor.agent.spec.model} · ${inv.evidence.items.size} tool calls · $${inv.cost.toFixed(2)} · run ${inv.runId}`;
    const byKey = new Map(pending.map((r) => [r.key, r]));
    const ownersOf = (rep: Report) => [...new Set(rep.rows.map((k) => byKey.get(k) && o.owners?.ownerOf(byKey.get(k)!.service)).filter((x): x is string => !!x))];
    const answer: string[] = [];
    let toSlack = 0;
    let quiet = 0;
    const filing: FileOptions = {
      newsAt: o.post && sink.outbox ? (id) => sink.outbox!.newsAt(id) : undefined,
      newsPending: o.post && sink.outbox ? (id) => sink.outbox!.newsPending(id) : undefined,
      clicks: o.buttons,
      breaksMute: (k) => !!byKey.get(k) && breaksMute(byKey.get(k)!, noise),
    };
    for (const [i, r] of inv.outputs.entries()) {
      const f: Filing = o.issues ? record(`filing report ${i + 1}`, () => fileReport(o.issues!, r, at, inv.runId, filing), { action: 'none' }) : { action: 'none' };
      result.filed.push(f);
      const cc = [...new Set([...(cfg.slackOncall && pagesOncall(f, r) ? [cfg.slackOncall] : []), ...ownersOf(r)])];
      const card = reportCard(r, summary.at, footer, inv.challenge, cc, issueRef(f));
      const post = postFor(f, r);
      emit(card, `${stamp(summary.at)}-${i + 1}`, post);
      // Back from resolved, or Not an issue ended: its buttons are back.
      if (o.post && (f.action === 'reopened' || (f.action === 'raised' && f.unmuted))) sink.outbox?.updateRoot(f.issue.id);
      if (post) toSlack++;
      if (post?.repeat) quiet++;
      if (o.issues) log(`report ${i + 1} ${filingNote(f, r)}`);
      answer.push(`### Report ${i + 1} · ${filingNote(f, r)}`, '', card.markdown, '');
    }
    log(`${toSlack} of ${inv.outputs.length} report(s) go to Slack${quiet ? ` (${quiet} as a quiet reply in an issue's thread)` : ''}`);
    // get_run reads answer.md: the reports, with the issue each one went to.
    if (inv.dir && answer.length)
      try {
        writeFileSync(join(inv.dir, 'answer.md'), redact([`# Monitor reports · patrol ${summary.at}`, '', ...answer].join('\n')));
      } catch {
        /* the cards and output.json have it all */
      }
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
