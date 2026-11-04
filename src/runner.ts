import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Telemetry } from './clients/telemetry.js';
import type { LoadedAgent } from './engine/agent.js';
import { finished, notRun, verdictOn } from './engine/challenge.js';
import { runAgent, type Engine, type RunResult } from './engine/run.js';
import { monitorTask } from './investigate/prompt.js';
import { checkReport, Report, ReportShape } from './investigate/report.js';
import { monitorTools } from './investigate/tools.js';
import { patrolCard, recoveredCard, reportCard, worseCard, type Card, type IssueRef } from './output/card.js';
import type { CardSink, EmitSlack } from './output/sink.js';
import { recentDeploys } from './patrol/deploys.js';
import { bucketOf } from './patrol/digest.js';
import { MUTE_DAYS, RANK, type Disposition, type Issue, type Issues, type Severity } from './patrol/issues.js';
import type { Noise } from './patrol/noise.js';
import type { Owners } from './patrol/owners.js';
import { ATTEMPTS, type State } from './patrol/state.js';
import { buildSummary, renderSummary, urgent, type FlaggedRow, type Summary } from './patrol/summary.js';
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

export { urgent } from './patrol/summary.js';

// Deterministic challenge gate, decided before the run: urgent rows always get
// the AI's work challenged, whatever severity it gives them.
export function needsChallenge(rows: FlaggedRow[], noise: Noise, clientErrors = false): boolean {
  return rows.some((r) => urgent(r, noise, clientErrors));
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
  | { action: 'muted'; issue: Issue; reopened?: boolean }; // same cause, and someone said Not an issue: not posted (reopened: it came back while the mute lasts)

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
  // Whether anything about the issue reached Slack (the outbox). Until it has,
  // a repeat is the issue's first post: shownInChannel counts it as shown.
  reached?: ((issue: string) => boolean) | undefined;
  // false: no challenger saw this report, so it may not be a reminder (a later
  // patrol's report reminds instead). A click or a delivery while the run was
  // going can make a reminder due that wasn't when the challenge was decided.
  remind?: boolean | undefined;
}

export function fileReport(issues: Issues, r: Report, at: Date, run?: string, o: FileOptions = {}): Filing {
  const filed = { title: r.title, severity: r.severity, rows: r.rows, hypothesis: r.cause.hypothesis, run };
  if (r.issue === 'new') return POSTED.has(r.severity) ? { action: 'opened', issue: issues.open(filed, at) } : { action: 'none' };
  // A recurrence reopens the issue only when it is worth posting; quietly
  // while a Not an issue from before it resolved still covers it.
  const quiet = mutedReturn(issues, r, at, o);
  const l = issues.link(r.issue, filed, at, { reopen: POSTED.has(r.severity), muted: quiet });
  if (l.reopenedFrom) return quiet ? { action: 'muted', issue: l.issue, reopened: true } : { action: 'reopened', issue: l.issue };
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
  if (POSTED.has(r.severity) && o.remind !== false && d?.kind !== 'acknowledged' && news && at.getTime() - Date.parse(news) >= REMIND_HOURS * 3600_000 && !o.newsPending?.(l.issue.id)) {
    issues.remind(l.issue.id, at, run);
    return { action: 'reminded', issue: l.issue };
  }
  return { action: 'linked', issue: l.issue };
}

// A report that brings back a resolved issue someone said is not an issue,
// while that mute lasts, stays muted: only rows the mute covered, none it
// can't silence (see breaksMute), and no rise in severity (a rise to critical
// ends a mute). Anything else reopens the issue as news and ends the mute, so
// does a row that joined it since (a minor report): reopened muted, the mute
// would cover that row too.
function mutedReturn(issues: Issues, r: Report, at: Date, o: FileOptions): boolean {
  if (!o.clicks || r.issue === 'new') return false;
  const i = issues.get(r.issue);
  const m = i?.status === 'resolved' ? issues.keptMute(i.id, at) : undefined;
  const covered = (k: string) => !!m?.rows.includes(k);
  return !!m && RANK[r.severity] <= RANK[i!.severity] && r.rows.every(covered) && i!.rows.every(covered) && !r.rows.some((k) => o.breaksMute?.(k));
}

// Would this report be shown in the channel, as a new message or a broadcast
// reply, rather than as a quiet reply in its issue's thread (or not at all)?
// fileReport's rule with the same options, read before the record changes.
// With no record, or an issue it can't find, the report is posted on its own:
// yes. A report that breaks a Not an issue mute counts as shown too.
export function shownInChannel(issues: Issues | undefined, r: Report, at: Date, o: FileOptions = {}): boolean {
  if (!POSTED.has(r.severity)) return false;
  if (!issues || r.issue === 'new') return true;
  const i = issues.get(r.issue);
  if (!i || RANK[r.severity] > RANK[i.severity]) return true; // on its own, or raised (a rise also ends a mute)
  if (i.status === 'resolved') return !mutedReturn(issues, r, at, o); // reopened, unless a Not an issue from before still covers it
  const d = o.clicks ? issues.disposition(i.id, at) : undefined;
  if (d?.kind === 'dismissed') return r.rows.some((k) => o.breaksMute?.(k)); // muted, unless a row breaks the mute
  if (o.reached && !o.reached(i.id)) return true; // opened without posting, or its first post failed: this one is its first
  if (d?.kind === 'acknowledged' || o.newsPending?.(i.id)) return false; // On it, or news still queued: no reminder
  const news = o.newsAt?.(i.id) ?? issues.lastNewsAt(i.id);
  return o.remind !== false && !!news && at.getTime() - Date.parse(news) >= REMIND_HOURS * 3600_000; // the 24 h reminder, when one may go out
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
      return f.reopened ? `reopened ${f.issue.id}: it came back, still Not an issue (not posted)` : `linked to ${f.issue.id} (Not an issue: not posted)`;
  }
}

// Rows Not an issue can't silence: protected journeys, and new or worse big
// jumps (urgent). They take the usual path: the rows card in the issue's
// thread, shown in the channel, and an AI run. The mute itself stays.
export function breaksMute(r: FlaggedRow, noise: Noise, clientErrors = false): boolean {
  return noise.protected(r) || (r.novelty !== 'reminder' && urgent(r, noise, clientErrors));
}

// Rows of an issue someone clicked On it or Not an issue on get no AI run.
// On it: rows that got worse (or came back) get one line by code in its
// thread, not shown in the channel. Not an issue: nothing, while the mute lasts.
// Protected journeys are never claimed, nor big jumps under Not an issue.
export function claimedRows(issues: Issues | undefined, rows: FlaggedRow[], noise: Noise, at: Date, clientErrors = false): Map<string, Disposition & { issue: string }> {
  if (!issues) return new Map();
  const claims = issues.claims(rows.filter((r) => !noise.protected(r)).map((r) => r.key), at);
  for (const r of rows) if (claims.get(r.key)?.kind === 'dismissed' && breaksMute(r, noise, clientErrors)) claims.delete(r.key);
  return claims;
}

export async function patrolOnce(tel: Telemetry, cfg: Config, noise: Noise, state: State, sink: CardSink, at: Date, o: PatrolOptions, monitor?: MonitorAgent): Promise<PatrolResult> {
  const log = o.log ?? (() => {});
  const summary = await buildSummary(tel, cfg, noise, state, at);
  const dir = join(cfg.outDir, 'patrols');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp(summary.at)}.md`), redact(renderSummary(summary)) + '\n');
  writeFileSync(join(dir, `${stamp(summary.at)}.json`), safeJson(summary, 1));
  log(`patrol ${summary.at}: ${summary.send.length} to send, ${summary.waiting.length} waiting, ${summary.known.length} known, ${summary.suppressed.length} noise, ${summary.recovered.length} recovered, sources down: ${summary.sources.filter((s) => !s.ok).map((s) => s.source).join(', ') || 'none'}`);

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
    // healthy observers and recoverAfterMinutes without firing), with one
    // recovery note in its thread. Its rows get no recovery note of their own,
    // also while some of them still fire. A row of no open issue gets one only
    // if a post about it is still unanswered (groupByThread).
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
        emit(recoveredCard(i.rows, summary.at, i.id, cfg.recoverAfterMinutes), `${stamp(summary.at)}-resolved-${i.id}`, sink.outbox?.threads ? { kind: 'recovered', keys: i.rows, broadcast: false, issue: i.id } : undefined);
        if (o.post) sink.outbox?.updateRoot(i.id); // its message says resolved, without buttons
      }
    }
    if (o.post && sink.outbox?.threads && loose.length)
      for (const keys of sink.outbox.groupByThread(loose)) sink.emit(recoveredCard(keys, summary.at, undefined, cfg.recoverAfterMinutes), `${stamp(summary.at)}-recovered-${keys.length}`, { kind: 'recovered', keys, broadcast: false });
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
  // by a click too. A big one breaks through Not an issue, as a new one does.
  const owedKnown = summary.known.filter((r) => state.needsInvestigation(r.key));
  // The buttons: rows of an issue someone is on, or said is not an issue, are
  // left out of the AI run and of the rows card (see claimedRows).
  const claims = record('reading the buttons', () => claimedRows(o.buttons ? o.issues : undefined, [...summary.send, ...owedKnown], noise, at, cfg.urgentClientErrors), new Map());
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
  const urgentRows = send.filter((r) => r.novelty !== 'reminder' && urgent(r, noise, cfg.urgentClientErrors));
  // The rows the investigator still owes an answer: new or worse, or left
  // uncovered by an earlier run. A reminder of a row it already explained is
  // not one: it would only be reported again. A row held back by a click isn't
  // in the run, so its record is left as it is: neither an attempt nor a deferral.
  const pending = [...send, ...owedKnown.filter((r) => !claims.has(r.key))].filter((r) => state.needsInvestigation(r.key));
  // A run only for a row big enough to read (the card's "to look at", sized as
  // if new): small rows on their own don't spend one.
  const worthALook = pending.some((r) => urgent(r, noise, cfg.urgentClientErrors) || bucketOf({ ...r, novelty: 'fresh' }, cfg.attentionFloor, noise.protected(r)) === 'look');

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
    const byKey = new Map(pending.map((r) => [r.key, r]));
    const filing: FileOptions = {
      newsAt: o.post && sink.outbox ? (id) => sink.outbox!.newsAt(id) : undefined,
      newsPending: o.post && sink.outbox ? (id) => sink.outbox!.newsPending(id) : undefined,
      reached: o.post && sink.outbox ? (id) => sink.outbox!.reached(id) : undefined,
      clicks: o.buttons,
      breaksMute: (k) => !!byKey.get(k) && breaksMute(byKey.get(k)!, noise, cfg.urgentClientErrors),
    };
    // A challenger checks the reports before the channel sees them: always for
    // urgent rows (the gate: rollout rows too), otherwise once a report would
    // be shown there as critical or major. Quiet replies in an issue's thread need none.
    const gate = needsChallenge(pending, noise, cfg.urgentClientErrors);
    const toChannel = (reports: Report[]) => gate || reports.some((r) => record('checking what the channel would see', () => shownInChannel(o.issues, r, at, filing), true));
    log(`investigating ${pending.length} row(s) with ${monitor.agent.spec.model}${gate ? ', then a challenger' : ''}…`);
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
        data: renderSummary(shown, { forModel: true }),
        tools: monitorTools(tel, cfg, at),
        output: {
          tool: 'submit_report',
          description: 'Submit one report per distinct problem. Call it once for every problem you found (several calls are fine). Invalid reports come back with the reason; fix and resubmit.',
          shape: ReportShape,
          evidenceOf: (r) => r.evidence,
          check: (r) => checkReport(r, rowKeys, issueIds),
        },
        challenge: toChannel,
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
    const ch = inv.challenge;
    log(`investigation ${inv.status}: ${inv.outputs.length} report(s), ${inv.evidence.items.size} tool call(s), ${inv.turns} turn(s), $${inv.cost.toFixed(3)}${ch ? `, challenge ${ch.verdict} ($${ch.cost.toFixed(3)}${ch.note ? `, ${ch.note}` : ''})` : ''}${inv.note ? ` (${inv.note})` : ''}`);
    const footer = `${monitor.agent.spec.model} · ${inv.evidence.items.size} tool calls · $${inv.cost.toFixed(2)} · run ${inv.runId}`;
    const ownersOf = (rep: Report) => [...new Set(rep.rows.map((k) => byKey.get(k) && o.owners?.ownerOf(byKey.get(k)!.service)).filter((x): x is string => !!x))];
    const answer: string[] = [];
    let toSlack = 0;
    let quiet = 0;
    let held = 0;
    // Only a run the challenger saw (or tried to) may send a reminder.
    const filed: FileOptions = { ...filing, remind: inv.challenge !== undefined };
    for (const [i, out] of inv.outputs.entries()) {
      // A report the challenger says doesn't hold up becomes minor: kept in the
      // run and answer.md, not posted, and it opens or raises no issue. So does
      // one the channel would see that the challenger did not agree with: it
      // said "partly", escalated, or didn't finish. Only a checked finding is
      // news. A protected journey is never hidden: it is posted with the objection.
      const item = verdictOn(inv.challenge, i + 1);
      const agreed = !!inv.challenge && finished(inv.challenge) && (item ? item.holds === 'yes' : inv.challenge.verdict === 'upheld');
      const news = POSTED.has(out.severity) && !agreed && record('checking what the channel would see', () => shownInChannel(o.issues, out, at, filed), true);
      const fails = POSTED.has(out.severity) && (item?.holds === 'no' || news);
      const kept = fails && out.rows.some((k) => !!byKey.get(k) && noise.protected(byKey.get(k)!));
      const r: Report = fails && !kept ? { ...out, severity: 'minor' } : out;
      if (fails && !kept) held++;
      const why = item?.holds === 'no' ? 'the second check says it does not hold up' : !inv.challenge || !finished(inv.challenge) ? 'the second check did not finish' : `the second check did not agree (${item?.holds ?? inv.challenge.verdict})`;
      const f: Filing = o.issues ? record(`filing report ${i + 1}`, () => fileReport(o.issues!, r, at, inv.runId, filed), { action: 'none' }) : { action: 'none' };
      result.filed.push(f);
      const cc = [...new Set([...(cfg.slackOncall && pagesOncall(f, r) ? [cfg.slackOncall] : []), ...ownersOf(r)])];
      const post = postFor(f, r);
      // What the channel sees of it: a new message or a broadcast reply, or a
      // repeat about an issue that never reached Slack (its first post). The
      // filing can differ from what the check was decided on (the record failed:
      // a post of its own). Shown with no challenge, it is marked not verified.
      const visible = !!post && (post.broadcast || (!!post.issue && o.post && !record('reading the outbox', () => sink.outbox?.reached(post.issue!) ?? true, false)));
      const unchecked = visible && !inv.challenge;
      const card = reportCard(r, summary.at, footer, unchecked ? notRun('it became news after the check was decided') : inv.challenge, cc, issueRef(f), recentDeploys(summary.deploys), item);
      emit(card, `${stamp(summary.at)}-${i + 1}`, post);
      // Back from resolved, or Not an issue ended: its buttons are back. Back
      // while Not an issue lasts: its message shows the mute again, with Undo.
      if (o.post && (f.action === 'reopened' || (f.action === 'muted' && f.reopened) || (f.action === 'raised' && f.unmuted))) sink.outbox?.updateRoot(f.issue.id);
      if (post) toSlack++;
      if (post?.repeat) quiet++;
      const note = `${filingNote(f, r)}${!fails ? '' : kept ? `; ${why}, posted anyway: a protected journey` : `; was ${out.severity}, ${why}`}${unchecked ? '; not verified: no second check ran' : ''}`;
      if (o.issues || fails || unchecked) log(`report ${i + 1} ${note}`);
      answer.push(`### Report ${i + 1} · ${note}`, '', card.markdown, '');
    }
    log(`${toSlack} of ${inv.outputs.length} report(s) go to Slack${quiet ? ` (${quiet} as a quiet reply in an issue's thread)` : ''}${held ? `; ${held} held back by the second check` : ''}`);
    // Only now, with the reports queued: if queueing threw, the rows are still owed.
    // A report the challenger says doesn't hold up still covers its rows: it is
    // kept as minor, and asking again would bring the same report back for
    // another challenge. Its rows are owed again when worse or after they recover.
    // Not admitted (caps, the kill switch on) or stopped (the kill switch, a cancel): deferred, not an attempt.
    investigated(new Set(inv.outputs.flatMap((r) => r.rows)), inv.note ?? inv.status, inv.status !== 'skipped' && inv.status !== 'stopped', inv.runId);
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
