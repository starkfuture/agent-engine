import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Sample } from '../src/clients/telemetry.js';
import type { Config } from '../src/config.js';
import { loadAgent } from '../src/engine/agent.js';
import type { Session } from '../src/engine/session.js';
import { Store } from '../src/engine/store.js';
import type { Report } from '../src/investigate/report.js';
import { buildServer, type McpContext } from '../src/mcp/server.js';
import { Users } from '../src/mcp/users.js';
import { CardSink } from '../src/output/sink.js';
import { SlackOutbox, type SlackMessage, type Transport } from '../src/output/slack.js';
import { Issues, type Click } from '../src/patrol/issues.js';
import { Noise } from '../src/patrol/noise.js';
import { State } from '../src/patrol/state.js';
import { fileReport, patrolOnce, postFor, shownInChannel, type FileOptions, type MonitorAgent, type PatrolResult } from '../src/runner.js';
import { ACTION, controlsFor, onClick, type ButtonIds } from '../src/slack/buttons.js';
import { startButtons, type SocketClient } from '../src/slack/socket.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { fakeSession, ok } from './fake-session.js';
import { FakeTelemetry, H, testConfig } from './fake.js';

// ---- the world: legacy /v1 routes whose 400s fire on a schedule (as in issues.test.ts) --

type Schedule = Record<string, (t: number) => number>;
const T0 = Date.parse('2026-11-02T08:00:00Z');
const DAY = 24 * H;
const at = (hours: number) => new Date(T0 + hours * H);
const between = (from: number, to: number, n = 20) => (t: number) => (t >= T0 + from * H && t < T0 + to * H ? n : 0);
const key = (route: string) => `http|backend-production|${route}|400`;
// Firing from `from`, twice as bad from `worse` (a row "worse" since its last report).
const doubles = (from: number, worse: number, to = 40) => (t: number) => (t >= T0 + from * H && t < T0 + to * H ? (t >= T0 + worse * H ? 45 : 20) : 0);

function schedule(s: Schedule) {
  return new FakeTelemetry((query: string, when: Date): Sample[] => {
    if (query.startsWith('count(kube_pod_container_status_restarts_total')) return [{ labels: {}, value: 120 }];
    if (!query.includes('backend_be_production_http_requests_total')) return [];
    return Object.entries(s).flatMap(([route, f]) => [
      { labels: { route, status_code: '200' }, value: 1000 },
      { labels: { route, status_code: '400' }, value: f(when.getTime()) },
    ]);
  });
}
// Prometheus down: no rows, and nothing can recover (observers must be healthy).
const blind = new FakeTelemetry((query) => {
  if (query.startsWith('count(kube_pod_container_status_restarts_total')) return [{ labels: {}, value: 120 }];
  throw new Error('prometheus unreachable');
});

// ---- the model: one report per patrol over its rows, linked to the first listed issue --

type Decide = (rows: string[], issues: string[]) => Partial<Report>;
const link: Decide = (_rows, issues) => ({ issue: issues[0] ?? 'new' });
const report = (over: Partial<Report>): Report => ({
  title: 'Sign-in rejects emails with a trailing space',
  severity: 'major',
  status: 'active',
  started_at: '2026-11-02T08:00:00Z',
  what_broke: 'POST /v1/auth/login returns 400 for valid accounts',
  impact: '30 failed sign-ins in 15 min',
  cause: { hypothesis: 'email validation rejects a trailing space', confidence: 'medium' },
  evidence: [],
  suggested_fix: 'trim the email before validating it',
  not_checked: [],
  rows: [],
  issue: 'new',
  ...over,
});

function model(decide: Decide): Session & { seen: string[][] } {
  const seen: string[][] = [];
  const session = (req: Parameters<Session>[0]) =>
    fakeSession(async function* (sim) {
      if (sim.req.tools.some((t) => t.name === 'submit_challenge')) {
        await sim.mcp('submit_challenge', { objections: [], overall: 'Holds up: the counts match the evidence.' });
        yield ok(0.05, 1);
        return;
      }
      const p = sim.req.prompt;
      const rows = [...p.slice(p.indexOf('Row keys to cover')).matchAll(/^- (http\|[^\n]+)$/gm)].map((m) => m[1]!);
      const issues = [...p.matchAll(/^- (I-[0-9a-f]{4,6}) · /gm)].map((m) => m[1]!);
      seen.push(rows);
      const out = await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
      const id = /evidence_id: (E-[0-9a-f]{4}-\d+)/.exec(out.text)![1]!;
      const quote = /^\S+ 400 \| [1-9]\d*/m.exec(out.text)![0];
      const r = await sim.mcp('submit_report', report({ evidence: [{ id, quote, claim: 'the route returns 400' }], rows, ...decide(rows, issues) }));
      assert.equal(r.isError, false, r.text);
      yield ok(0.1, 3);
    })(req);
  return Object.assign(session, { seen });
}

// ---- Slack: the bot, recording posts and message updates -------------------------

type Sent = { text: string; blocks: unknown[]; thread_ts?: string | undefined; reply_broadcast?: boolean | undefined };
function bot(): Transport & { sent: Sent[]; updates: Array<{ ts: string } & SlackMessage> } {
  const sent: Sent[] = [];
  const updates: Array<{ ts: string } & SlackMessage> = [];
  return {
    threads: true,
    sent,
    updates,
    async post(m) {
      sent.push({ text: m.text, blocks: m.blocks, ...(m.thread_ts ? { thread_ts: m.thread_ts, reply_broadcast: m.reply_broadcast } : {}) });
      return `1700000000.${String(sent.length).padStart(6, '0')}`;
    },
    async update(ts, m) {
      updates.push({ ts, ...m });
    },
  };
}
const ROOT = '1700000000.000001';
type Block = { type: string; elements?: Array<{ action_id?: string; confirm?: unknown; text?: string | { text: string } }> };
// The buttons a message shows, and its last context line.
const buttons = (blocks: unknown[]) => (blocks as Block[]).filter((b) => b.type === 'actions').flatMap((b) => b.elements!.map((e) => e.action_id));
const note = (blocks: unknown[]) => (blocks as Block[]).filter((b) => b.type === 'context').map((b) => (b.elements![0]!.text as string) ?? '').at(-1) ?? '';
const OPEN = [ACTION.acknowledged, ACTION.dismissed];

const IDS: ButtonIds = { app: 'A0TESTAPP', team: 'T0TESTTEAM', channel: 'C0TEST123' };
const RESPONSE = 'https://hooks.slack.com/actions/T0TESTTEAM/1700000100/AbCdEf';
// Each click has its own time from Slack (action_ts), later than the one before.
let clicks = 0;
const nextActionTs = () => `1700000100.${String(++clicks).padStart(6, '0')}`;
function payload(action: string, issue: string, o: { user?: string; ts?: string; app?: string; team?: string; channel?: string; actionTs?: string } = {}) {
  const channel = o.channel ?? IDS.channel;
  return {
    type: 'block_actions',
    api_app_id: o.app ?? IDS.app,
    team: { id: o.team ?? IDS.team, domain: 'stark' },
    user: { id: o.user ?? 'U0ALICE', team_id: o.team ?? IDS.team },
    channel: { id: channel, name: 'prod-monitor' },
    container: { type: 'message', message_ts: o.ts ?? ROOT, channel_id: channel, is_ephemeral: false },
    response_url: RESPONSE,
    trigger_id: '1.2.3',
    actions: [{ action_id: action, block_id: 'issue_buttons', value: issue, type: 'button', action_ts: o.actionTs ?? nextActionTs() }],
  };
}

// A patrol world with one engine.db, the buttons on unless `buttons: false`.
function setup(o: { decide?: Decide; buttons?: boolean; noise?: Noise; recoverAfterMinutes?: number } = {}) {
  const c: Config = { ...testConfig(), ...(o.recoverAfterMinutes ? { recoverAfterMinutes: o.recoverAfterMinutes } : {}) };
  const db = join(c.runsDir, 'engine.db');
  const clock = { now: new Date(T0) };
  const issues = new Issues(db);
  const t = bot();
  const box = new SlackOutbox(db, t, { now: () => clock.now, sleep: async () => {}, gapMs: 0, ...(o.buttons === false ? {} : { controls: controlsFor(issues, () => clock.now) }) });
  const sink = new CardSink(c.outDir, box);
  const session = model(o.decide ?? link);
  const monitor: MonitorAgent = {
    engine: { store: new Store(db), runsDir: c.runsDir, stopFile: join(c.runsDir, 'STOP'), session, dailyCapUsd: 1000, llmAvailable: true },
    agent: loadAgent(join(c.agentsDir, 'monitor')),
  };
  const state = State.memory();
  const logs: string[] = [];
  const flags = { buttons: o.buttons !== false }; // SLACK_APP_TOKEN set, as the patrol sees it
  const patrol = async (tel: FakeTelemetry, hours: number): Promise<PatrolResult> => {
    clock.now = at(hours);
    return patrolOnce(tel, c, o.noise ?? new Noise({}), state, sink, at(hours), { llm: true, post: true, log: (s) => logs.push(s), issues, buttons: flags.buttons }, monitor);
  };
  // A click, recorded, then the outbox flushed as the socket does after the ack.
  const click = async (what: Click, issue: string, by: Parameters<typeof payload>[2] = {}, hours?: number) => {
    if (hours !== undefined) clock.now = at(hours);
    const r = onClick(payload(ACTION[what], issue, by), { issues, outbox: box, ids: IDS, now: () => clock.now });
    await box.flush();
    return r;
  };
  return { c, db, t, box, issues, session, patrol, click, logs, clock, flags, state };
}
const opened = (r: PatrolResult) => (r.filed[0]?.action === 'opened' ? r.filed[0].issue.id : assert.fail(`not opened: ${r.filed[0]?.action}`));

// ---- On it ------------------------------------------------------------------------

test('On it: reports stay in the thread with no reminder, and a row that gets worse gets a line by code instead of an AI run', async () => {
  const tel = schedule({ '/v1/auth/login': doubles(0, 9), '/v1/ownership/transfer': between(2, 40), '/v1/auth/signup': between(26, 40) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  assert.deepEqual(buttons(w.t.sent[0]!.blocks), OPEN, 'a new issue shows both buttons');
  assert.ok((w.t.sent[0]!.blocks as Block[]).find((b) => b.type === 'actions')!.elements!.find((e) => e.action_id === ACTION.dismissed)!.confirm, 'Not an issue asks first');

  const r = await w.click('acknowledged', id, { user: 'U0ALICE' }, 0.5);
  assert.match(r.reply!, new RegExp(`^On it: ${id} is yours`));
  assert.equal(r.respondTo, RESPONSE, 'the reply goes to the clicker only');
  assert.equal(w.t.sent.length, 1, 'a click posts nothing');
  assert.deepEqual(w.t.updates.map((u) => u.ts), [ROOT], 'it updates the message once');
  assert.deepEqual(buttons(w.t.updates[0]!.blocks), [ACTION.dismissed, ACTION.undo]);
  assert.match(note(w.t.updates[0]!.blocks), /On it: <@U0ALICE> since 11-02 08:30Z/);
  assert.equal(w.t.updates[0]!.text, w.t.sent[0]!.text, 'the message itself is unchanged');

  const sibling = await w.patrol(tel, 2); // another flow, same cause: a quiet reply, as before
  assert.equal(sibling.filed[0]?.action, 'linked');
  assert.deepEqual(w.t.sent.slice(1).map((s) => [s.thread_ts, s.reply_broadcast]), [[ROOT, false]]);

  // Twice as bad on a row of the issue: no AI run, one line by code in the thread.
  const worse = await w.patrol(tel, 9);
  assert.equal(w.session.seen.length, 2, 'no AI run');
  assert.equal(worse.investigation, undefined);
  assert.match(worse.skippedLlm!, /every row belongs to an issue someone clicked/);
  const line = w.t.sent.at(-1)!;
  assert.deepEqual([line.thread_ts, line.reply_broadcast], [ROOT, false]);
  assert.match(line.text, new RegExp(`^📈 Worse at 17:00Z on ${id}: backend-production · /v1/auth/login 400 now 45 \\(was 20\\) · On it: <@U0ALICE>$`));
  assert.ok(w.logs.includes(`${id}: 2 row(s) not investigated: On it, 1 worse: a line in its thread`));

  // A day after the issue last reached the channel: no reminder while someone is on it.
  const nextDay = await w.patrol(tel, 26);
  assert.deepEqual(w.session.seen.at(-1), [key('/v1/auth/signup')], 'only the new row is investigated');
  assert.equal(nextDay.filed[0]?.action, 'linked', 'not reminded');
  assert.deepEqual([w.t.sent.at(-1)!.thread_ts, w.t.sent.at(-1)!.reply_broadcast], [ROOT, false]);
  assert.deepEqual(w.issues.events(id).map((e) => e.type), ['opened', 'acknowledged', 'report_linked', 'worse_noted', 'report_linked']);
});

test('without a click the same world spends an AI run on the worse row and reminds the channel after 24 h', async () => {
  const tel = schedule({ '/v1/auth/login': doubles(0, 9), '/v1/ownership/transfer': between(2, 40), '/v1/auth/signup': between(26, 40) });
  const w = setup();
  await w.patrol(tel, 0);
  await w.patrol(tel, 2);
  await w.patrol(tel, 9);
  assert.equal(w.session.seen.length, 3);
  const nextDay = await w.patrol(tel, 26);
  assert.equal(nextDay.filed[0]?.action, 'reminded');
  assert.equal(w.t.sent.at(-1)!.reply_broadcast, true);
});

test('a row still owed an answer stays out of runs while someone is on its issue, and keeps its record: no attempt, no deferral', async () => {
  const tel = schedule({ '/v1/auth/login': doubles(0, 9) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  await w.click('acknowledged', id, { user: 'U0ALICE' }, 0.5);
  const owed = () => w.state.data.rows[key('/v1/auth/login')]!.investigation;
  await w.patrol(tel, 9); // twice as bad: a line by code, and the row is owed an answer again
  assert.deepEqual(owed(), { status: 'pending', attempts: 0 });
  for (const h of [9.25, 9.5]) assert.equal((await w.patrol(tel, h)).investigation, undefined, 'still owed, but held back by On it: no AI run');
  assert.equal(w.session.seen.length, 1);
  assert.deepEqual(owed(), { status: 'pending', attempts: 0 }, 'neither an attempt nor a deferral');
  await w.click('undo', id, { user: 'U0ALICE' }, 9.6);
  await w.patrol(tel, 9.75);
  assert.deepEqual(w.session.seen.at(-1), [key('/v1/auth/login')], 'investigated once the click is undone');
  assert.equal(owed()?.status, 'complete');
});

// ---- Not an issue -----------------------------------------------------------------

test('Not an issue: linked reports are not posted, its rows get no AI run, and a rise to critical lifts the mute', async () => {
  const tel = schedule({ '/v1/auth/login': doubles(0, 9), '/v1/ownership/transfer': between(2, 40), '/v1/auth/signup': between(26, 40) });
  const w = setup({ decide: (rows, issues) => ({ issue: issues[0] ?? 'new', severity: rows.includes(key('/v1/auth/signup')) ? 'critical' : 'major' }) });
  const id = opened(await w.patrol(tel, 0));
  const r = await w.click('dismissed', id, { user: 'U0BOB' }, 0.25);
  assert.match(r.reply!, new RegExp(`^Not an issue: ${id} is muted until it resolves, at most until 11-09 08:15Z`));
  assert.deepEqual(buttons(w.t.updates[0]!.blocks), [ACTION.undo]);
  assert.match(note(w.t.updates[0]!.blocks), /Not an issue: <@U0BOB> at 11-02 08:15Z\. Muted until it resolves, at most until 11-09 08:15Z/);

  // A sibling row the AI links to it: investigated (it wasn't the issue's yet), not posted.
  const sibling = await w.patrol(tel, 2);
  assert.equal(sibling.filed[0]?.action, 'muted');
  assert.equal(w.t.sent.length, 1, 'not posted');
  assert.ok(w.logs.includes(`report 1 linked to ${id} (Not an issue: not posted)`));
  assert.deepEqual(w.issues.get(id)!.rows, [key('/v1/auth/login'), key('/v1/ownership/transfer')], 'its rows joined the issue');

  // Its rows got worse: no AI run, nothing posted.
  const worse = await w.patrol(tel, 9);
  assert.equal(w.session.seen.length, 2);
  assert.equal(worse.cards.length, 1, 'the rows card stays on disk');
  assert.equal(w.t.sent.length, 1);
  assert.ok(w.logs.includes(`${id}: 2 row(s) not investigated: Not an issue`));

  // A new row, linked and rated critical: shown in the channel, and the mute is over.
  const critical = await w.patrol(tel, 26);
  assert.deepEqual(critical.filed.map((f) => f.action), ['raised']);
  assert.deepEqual([w.t.sent.at(-1)!.thread_ts, w.t.sent.at(-1)!.reply_broadcast], [ROOT, true]);
  assert.equal(w.issues.disposition(id, at(26)), undefined);
  assert.ok(w.logs.includes(`report 1 linked to ${id}: severity major → critical (broadcast; ends Not an issue)`));
  assert.deepEqual(buttons(w.t.updates.at(-1)!.blocks), OPEN, 'its buttons are back');
  assert.match(note(w.t.updates.at(-1)!.blocks), /Marked Not an issue before by <@U0BOB> on 11-02/);
  assert.deepEqual(w.issues.events(id).map((e) => e.type), ['opened', 'dismissed', 'report_linked', 'report_linked', 'severity_raised', 'mute_lifted']);

  // The dismissal stays a noise-rule candidate.
  assert.deepEqual(w.issues.noiseCandidates(), [{ issue: id, title: 'Sign-in rejects emails with a trailing space', status: 'open', rows: [key('/v1/auth/login')], dismissals: [{ by: 'U0BOB', at: at(0.25).toISOString(), rows: [key('/v1/auth/login')] }] }]);
});

test('a protected journey breaks through Not an issue: its rows card is shown in the channel and the AI investigates it', async () => {
  const noise = new Noise({ never_suppress: [{ route: '/v1/auth/login' }] });
  const tel = schedule({ '/v1/auth/login': doubles(0, 9), '/v1/ownership/transfer': doubles(0, 9) });
  const w = setup({ noise });
  const first = await w.patrol(tel, 0);
  const id = opened(first);
  // The protected row made a rows card first; the issue started in its thread, and the card got the buttons.
  assert.deepEqual(w.t.sent.map((s) => [s.thread_ts ?? 'root', s.reply_broadcast]), [['root', undefined], [ROOT, false]]);
  assert.deepEqual(buttons(w.t.sent[0]!.blocks), [], 'the rows card was posted before the issue existed');
  assert.deepEqual(w.t.updates.map((u) => [u.ts, buttons(u.blocks)]), [[ROOT, OPEN]], 'then updated to carry them');
  await w.click('dismissed', id, { user: 'U0BOB' }, 0.25);

  await w.patrol(tel, 9); // both rows twice as bad
  assert.deepEqual(w.session.seen.at(-1), [key('/v1/auth/login')], 'the protected row is investigated, the other is not');
  const sent = w.t.sent.slice(2);
  assert.match(sent[0]!.text, /^Patrol 2026-11-02 17:00Z/);
  assert.deepEqual([sent[0]!.thread_ts, sent[0]!.reply_broadcast], [ROOT, true], 'the rows card, shown in the channel');
  assert.deepEqual([sent[1]!.thread_ts, sent[1]!.reply_broadcast], [ROOT, false], 'its report, in the thread');
  assert.equal(sent.length, 2);
  assert.ok(!sent[0]!.text.includes('transfer') && !JSON.stringify(sent[0]!.blocks).includes('/v1/ownership/transfer'), 'the muted row is not on the card');
  assert.equal(w.issues.disposition(id, at(9))?.kind, 'dismissed', 'still muted for its other rows');
});

test('a big jump breaks through Not an issue: its rows card is shown in the issue thread and the AI investigates it; the mute stays', async () => {
  const jump = (t: number) => (t >= T0 && t < T0 + 40 * H ? (t >= T0 + 9 * H ? 300 : 20) : 0); // 15 times worse at +9 h: urgent
  const tel = schedule({ '/v1/auth/login': jump, '/v1/ownership/transfer': doubles(0, 9) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  await w.click('dismissed', id, { user: 'U0BOB' }, 0.25);
  const r = await w.patrol(tel, 9);
  assert.deepEqual(w.session.seen.at(-1), [key('/v1/auth/login')], 'the jump is investigated; the row that merely doubled is not');
  const sent = w.t.sent.slice(1);
  assert.match(sent[0]!.text, /^Patrol 2026-11-02 17:00Z/);
  assert.deepEqual([sent[0]!.thread_ts, sent[0]!.reply_broadcast], [ROOT, true], 'the rows card, in the issue thread and shown in the channel');
  assert.ok(!JSON.stringify(sent[0]!.blocks).includes('/v1/ownership/transfer'), 'the muted row is not on the card');
  assert.equal(r.filed[0]?.action, 'linked', 'its report follows the usual rule');
  assert.deepEqual([sent[1]!.thread_ts, sent[1]!.reply_broadcast], [ROOT, false]);
  assert.equal(sent.length, 2);
  assert.equal(w.issues.disposition(id, at(9))?.kind, 'dismissed', 'the mute stays');
});

test('the mute ends after 7 days even if the issue never resolves', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  await w.click('dismissed', id, {}, 0.25);
  const updates = w.t.updates.length;
  await w.patrol(blind, 7 * 24 - 0.25); // Prometheus down for a week: the issue can't resolve
  assert.equal(w.issues.disposition(id, at(7 * 24 - 0.25))?.kind, 'dismissed');
  assert.equal(w.issues.claims([key('/v1/auth/login')], at(7 * 24 - 0.25)).get(key('/v1/auth/login'))?.kind, 'dismissed');
  assert.equal(w.t.updates.length, updates);
  await w.patrol(blind, 7 * 24 + 0.5);
  assert.equal(w.issues.get(id)!.status, 'open');
  assert.equal(w.issues.disposition(id, at(7 * 24 + 0.5)), undefined);
  assert.deepEqual(w.issues.claims([key('/v1/auth/login')], at(7 * 24 + 0.5)), new Map(), 'its rows are investigated again');
  assert.deepEqual(w.issues.events(id).at(-1)!.data, { reason: '7 days' });
  assert.ok(w.logs.includes(`${id}: Not an issue ended after 7 days; its rows are investigated again`));
  assert.deepEqual(buttons(w.t.updates.at(-1)!.blocks), OPEN);
});

// I-8b89 on 11-03/04: a Major at 15:15Z, Not an issue at 15:28Z, its row quiet
// from the 15:30Z patrol, resolved at 16:15Z (an hour without firing, #22),
// and the same row back at 01:45Z. MUTE_DAYS from the click is 11-10 15:28Z.
const RIDES = '/v2/vehicles/:vin/rides';
const NOV3 = 31.25; // 11-03 15:15Z
const BACK = 41.75; // 11-04 01:45Z
const UNTIL = '2026-11-10T15:28:00.000Z';
async function dismissedThenResolved(o: { rides?: (t: number) => number; also?: Schedule; decide?: Decide } = {}) {
  const tel = schedule({ [RIDES]: o.rides ?? ((t) => between(NOV3, NOV3 + 0.25)(t) || between(BACK, BACK + 0.25)(t)), ...o.also });
  const w = setup({ recoverAfterMinutes: 60, ...(o.decide ? { decide: o.decide } : {}) });
  const id = opened(await w.patrol(tel, NOV3));
  await w.click('dismissed', id, { user: 'U0BOB' }, NOV3 + 13 / 60);
  for (const h of [31.5, 31.75, 32]) assert.deepEqual((await w.patrol(tel, h)).resolved, [], 'held for an hour without firing');
  assert.deepEqual((await w.patrol(tel, 32.25)).resolved, [id], 'resolved at 16:15Z');
  return { w, tel, id };
}

test('I-8b89: Not an issue outlasts the issue resolving, and the same row back at the same severity stays muted', async () => {
  const { w, tel, id } = await dismissedThenResolved();
  assert.equal(w.issues.disposition(id, at(32.25)), undefined, 'resolved: no mute in force');
  assert.deepEqual(w.issues.keptMute(id, at(32.25)), { kind: 'dismissed', by: 'U0BOB', at: at(NOV3 + 13 / 60).toISOString(), until: UNTIL, rows: [key(RIDES)] }, 'but kept for its return');
  assert.deepEqual(w.issues.events(id).at(-1)!.data, { rows: [key(RIDES)], kept: 'dismissed', until: UNTIL });
  const sent = w.t.sent.length; // the issue and its one resolved note
  const updates = w.t.updates.length;

  const back = await w.patrol(tel, BACK);
  assert.deepEqual(back.filed.map((f) => f.action), ['muted']);
  assert.equal(w.t.sent.length, sent, 'no "Back again" in the channel, nor in the thread');
  assert.ok(w.logs.includes(`report 1 reopened ${id}: it came back, still Not an issue (not posted)`));
  assert.equal(back.investigation?.challenge, undefined, 'a report the buttons keep quiet is not challenged');
  assert.equal(w.issues.get(id)!.status, 'open');
  assert.deepEqual(w.issues.disposition(id, at(BACK)), { kind: 'dismissed', by: 'U0BOB', at: at(NOV3 + 13 / 60).toISOString(), until: UNTIL }, 'the same mute, to its first end');
  // Its message shows the mute again, with Undo: not its buttons as if unmuted.
  assert.equal(w.t.updates.length, updates + 1);
  assert.deepEqual(buttons(w.t.updates.at(-1)!.blocks), [ACTION.undo]);
  assert.match(note(w.t.updates.at(-1)!.blocks), /^🔕 Not an issue: <@U0BOB> at 11-03 15:28Z/);
  assert.deepEqual(w.issues.events(id).map((e) => e.type), ['opened', 'dismissed', 'resolved', 'reopened', 'report_linked']);
  assert.equal(w.issues.lastNewsAt(id), at(NOV3).toISOString(), 'a quiet return is not news');
  assert.deepEqual(w.issues.claims([key(RIDES)], at(BACK + 0.25)).get(key(RIDES))?.kind, 'dismissed', 'its row gets no AI run again while the mute lasts');
  assert.deepEqual(
    w.issues.noiseCandidates().map((c) => [c.issue, c.status, c.rows, c.dismissals.length]),
    [[id, 'open', [key(RIDES)], 1]],
    'still one noise-rule candidate',
  );
});

test('a return more than a day after the issue resolved still links to it and stays muted, while the mute lasts', async () => {
  const later = 32.25 + 26; // 11-04 18:15Z: past the 24 h a resolved issue is otherwise listed
  const { w, tel, id } = await dismissedThenResolved({ rides: (t) => between(NOV3, NOV3 + 0.25)(t) || between(later, later + 0.25)(t) });
  assert.deepEqual(w.issues.listed(at(later)).issues.map((i) => i.id), [id], 'listed for the investigator while its mute lasts');
  assert.deepEqual(w.issues.listed(new Date(Date.parse(UNTIL) + 1)).issues, [], 'and no longer once it is over');
  const sent = w.t.sent.length;
  const back = await w.patrol(tel, later);
  assert.equal(w.session.seen.length, 2, 'its return is investigated');
  assert.deepEqual(back.filed.map((f) => f.action), ['muted'], 'it links instead of opening a new issue');
  assert.equal(w.t.sent.length, sent);
});

test('a return Not an issue does not cover reopens the issue as news and ends the mute: a big jump, a row it did not cover, a rise to critical', async () => {
  const cases = {
    'a big jump': await dismissedThenResolved({ rides: (t) => between(NOV3, NOV3 + 0.25)(t) || between(BACK, BACK + 0.25, 300)(t) }),
    'a row it did not cover': await dismissedThenResolved({ also: { '/v2/vehicles/:vin/trips': between(BACK, BACK + 0.25) } }),
    'a rise to critical': await dismissedThenResolved({ decide: (_rows, issues) => ({ issue: issues[0] ?? 'new', severity: issues.length ? 'critical' : 'major' }) }),
  };
  for (const [what, { w, tel, id }] of Object.entries(cases)) {
    const back = await w.patrol(tel, BACK);
    assert.deepEqual(back.filed.map((f) => f.action), ['reopened'], what);
    assert.deepEqual([w.t.sent.at(-1)!.thread_ts, w.t.sent.at(-1)!.reply_broadcast], [ROOT, true], `${what}: shown in the channel`);
    assert.ok(w.logs.includes(`report 1 reopened ${id}: it came back (broadcast)`), what);
    assert.equal(w.issues.disposition(id, at(BACK)), undefined, `${what}: the mute is over`);
    assert.deepEqual(w.issues.events(id).find((e) => e.type === 'mute_lifted')?.data.reason, what === 'a rise to critical' ? 'critical' : 'came back', what);
    assert.deepEqual(buttons(w.t.updates.at(-1)!.blocks), OPEN, `${what}: its buttons are back`);
    assert.match(note(w.t.updates.at(-1)!.blocks), /Marked Not an issue before by <@U0BOB> on 11-03/, what);
  }
  const jump = cases['a big jump'].w.t.sent.at(-2)!;
  assert.match(jump.text, /^Patrol 2026-11-04 01:45Z/, 'the big jump got its rows card first, as any urgent row');
});

test("what the channel would see of a resolved issue's return is what fileReport posts, with a Not an issue kept or not", () => {
  const k = key(RIDES);
  const world = (severity: Report['severity']) => {
    const issues = Issues.memory();
    const i = issues.open({ title: 'Rides return 401', severity, rows: [k], hypothesis: 'h' }, at(0));
    issues.click(i.id, 'dismissed', 'U0BOB', at(0.25));
    issues.resolve(i.id, at(1));
    return { issues, id: i.id };
  };
  const clicks: FileOptions = { clicks: true };
  const trips = key('/v2/vehicles/:vin/trips');
  const cases: Array<{ what: string; was?: Report['severity']; over?: Partial<Report>; hours?: number; o?: FileOptions; minorFirst?: string[]; action: string }> = [
    { what: 'the same row, the same severity', action: 'muted' },
    { what: 'a lower severity', was: 'critical', action: 'muted' },
    { what: 'critical again, on an issue that was critical', was: 'critical', over: { severity: 'critical' }, action: 'muted' },
    { what: 'a protected row or a big jump', o: { ...clicks, breaksMute: (x) => x === k }, action: 'reopened' },
    { what: 'a row the mute did not cover', over: { rows: [k, trips] }, action: 'reopened' },
    { what: 'a row that joined while it was resolved (a minor report), which the mute would then cover too', minorFirst: [trips], action: 'reopened' },
    { what: 'a rise to critical', over: { severity: 'critical' }, action: 'reopened' },
    { what: 'after its mute ended', hours: 7 * 24 + 1, action: 'reopened' },
    { what: 'the buttons off', o: {}, action: 'reopened' },
  ];
  for (const c of cases) {
    const { issues, id } = world(c.was ?? 'major');
    if (c.minorFirst) assert.equal(fileReport(issues, report({ rows: c.minorFirst, issue: id, severity: 'minor' }), at(5), undefined, clicks).action, 'linked');
    const r = report({ rows: [k], issue: id, ...c.over });
    const when = at(c.hours ?? 10);
    const o = c.o ?? clicks;
    const shown = shownInChannel(issues, r, when, o);
    const f = fileReport(issues, r, when, undefined, o);
    assert.equal(f.action, c.action, c.what);
    assert.equal(shown, !!postFor(f, r)?.broadcast, `${c.what}: shownInChannel reads fileReport's rule`);
    assert.equal(issues.get(id)!.status, 'open', c.what);
    assert.equal(issues.disposition(id, when)?.kind, c.action === 'muted' ? 'dismissed' : undefined, c.what);
  }
});

// ---- Undo -------------------------------------------------------------------------

test('Undo takes a click back: the issue is open again, and an undone Not an issue is no noise-rule candidate', async () => {
  const tel = schedule({ '/v1/auth/login': doubles(0, 9) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  await w.click('dismissed', id, { user: 'U0BOB' }, 0.25);
  const undo = await w.click('undo', id, { user: 'U0BOB' }, 0.3);
  assert.equal(undo.reply, `Undone: nobody is on ${id} and it isn't muted.`);
  assert.deepEqual(w.t.updates.map((u) => buttons(u.blocks)), [[ACTION.undo], OPEN]);
  assert.ok(!JSON.stringify(w.t.updates[1]!.blocks).includes('Not an issue before'), 'no "marked before": the click was taken back');
  assert.deepEqual(w.issues.noiseCandidates(), []);
  const again = await w.click('undo', id, {}, 0.4);
  assert.equal(again.reply, `${id} has no On it or Not an issue to undo. Nothing changed.`);
  assert.equal(w.t.updates.length, 2);
  await w.patrol(tel, 9);
  assert.equal(w.session.seen.length, 2, 'its worse row is investigated again');

  // On it, then Undo: nobody is on it.
  await w.click('acknowledged', id, { user: 'U0ALICE' }, 10);
  await w.click('undo', id, { user: 'U0ALICE' }, 10.1);
  assert.equal(w.issues.disposition(id, at(10.1)), undefined);
  assert.deepEqual(w.issues.events(id).map((e) => e.type), ['opened', 'dismissed', 'undone', 'report_linked', 'acknowledged', 'undone']);
});

// ---- clicks -----------------------------------------------------------------------

test('a click from elsewhere or on a message that is not an issue gets a reply and changes nothing', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  const tries = [
    { channel: 'C0ELSEWHERE' },
    { team: 'T0OTHERTEAM' },
    { app: 'A0OTHERAPP' },
    { ts: '1700000000.999999' }, // a message the engine didn't post as an issue
  ];
  for (const t of tries) {
    const r = await w.click('acknowledged', id, t);
    assert.match(r.reply!, /Nothing changed\.$/, JSON.stringify(t));
    assert.equal(r.respondTo, RESPONSE);
    assert.equal(r.updated, undefined);
  }
  const wrongIssue = await w.click('acknowledged', 'I-0000');
  assert.match(wrongIssue.reply!, /isn't an issue the engine tracks/);
  assert.deepEqual(onClick({ type: 'view_submission' }, { issues: w.issues, outbox: w.box, ids: IDS }), {}, 'not a button click: nothing to say');
  assert.deepEqual(w.issues.events(id).map((e) => e.type), ['opened']);
  assert.deepEqual(w.t.updates, []);
  assert.equal(w.t.sent.length, 1);
});

test('a click Slack delivers again, or one older than a recorded click, changes nothing', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  const ctx = { issues: w.issues, outbox: w.box, ids: IDS, now: () => w.clock.now };
  const dismiss = payload(ACTION.dismissed, id, { user: 'U0BOB' });
  onClick(dismiss, ctx);
  await w.box.flush();
  await w.click('undo', id, { user: 'U0BOB' });
  // The same envelope again, after a lost acknowledgement: no new mute.
  const replay = onClick(dismiss, ctx);
  assert.equal(replay.reply, `${id} has a later click than this one. Nothing changed.`);
  assert.equal(replay.updated, undefined);
  assert.equal(w.issues.disposition(id, w.clock.now), undefined);
  // Out of order: Alice clicked On it before Bob's Not an issue, and arrives after it.
  const alice = payload(ACTION.acknowledged, id, { user: 'U0ALICE' });
  const bob = payload(ACTION.dismissed, id, { user: 'U0BOB' });
  onClick(bob, ctx);
  assert.equal(onClick(alice, ctx).updated, undefined);
  assert.equal(w.issues.disposition(id, w.clock.now)?.kind, 'dismissed');
  assert.deepEqual(w.issues.events(id).map((e) => e.type), ['opened', 'dismissed', 'undone', 'dismissed']);
});

test('a delayed older click loses to a newer one, also when the newer one changed nothing', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  const ctx = { issues: w.issues, outbox: w.box, ids: IDS, now: () => w.clock.now };
  const t = (n: number) => `1700000200.${String(n).padStart(6, '0')}`;
  // An Undo with nothing to undo, then an On it clicked before it arrives late.
  assert.equal(onClick(payload(ACTION.undo, id, { user: 'U0ALICE', actionTs: t(6) }), ctx).reply, `${id} has no On it or Not an issue to undo. Nothing changed.`);
  assert.equal(onClick(payload(ACTION.acknowledged, id, { user: 'U0ALICE', actionTs: t(4) }), ctx).updated, undefined);
  assert.equal(w.issues.disposition(id, w.clock.now), undefined);
  // On it, On it again (no change), then a delayed Undo from between the two.
  assert.equal(onClick(payload(ACTION.acknowledged, id, { user: 'U0ALICE', actionTs: t(10) }), ctx).updated, id);
  assert.equal(onClick(payload(ACTION.acknowledged, id, { user: 'U0ALICE', actionTs: t(30) }), ctx).updated, undefined, 'no second update');
  assert.equal(onClick(payload(ACTION.undo, id, { user: 'U0ALICE', actionTs: t(20) }), ctx).updated, undefined);
  assert.equal(w.issues.disposition(id, w.clock.now)?.kind, 'acknowledged');
  await w.box.flush();
  assert.equal(w.t.updates.length, 1);
});

test('with the buttons off, recorded clicks are kept and ignored: posting is as before, and they apply again when the buttons are back', async () => {
  const tel = schedule({ '/v1/auth/login': doubles(0, 9), '/v1/ownership/transfer': between(2, 40), '/v1/auth/signup': between(12, 40) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  await w.click('dismissed', id, { user: 'U0BOB' }, 0.25);
  w.flags.buttons = false; // SLACK_APP_TOKEN removed
  const sibling = await w.patrol(tel, 2);
  assert.equal(sibling.filed[0]?.action, 'linked');
  assert.deepEqual([w.t.sent.at(-1)!.thread_ts, w.t.sent.at(-1)!.reply_broadcast], [ROOT, false], 'posted in its thread, as before');
  await w.patrol(tel, 9);
  assert.equal(w.session.seen.length, 3, 'the worse row is investigated');
  assert.equal(w.issues.disposition(id, at(9))?.kind, 'dismissed', 'the click is kept');
  w.flags.buttons = true;
  const back = await w.patrol(tel, 12);
  assert.equal(back.filed[0]?.action, 'muted');
});

test('a click Slack delivers again at the latest click time changes nothing, also after its mute was lifted', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  const ctx = { issues: w.issues, outbox: w.box, ids: IDS, now: () => w.clock.now };
  const t = (n: number) => `1700000300.${String(n).padStart(6, '0')}`;
  onClick(payload(ACTION.dismissed, id, { user: 'U0BOB', actionTs: t(1) }), ctx);
  const again = payload(ACTION.dismissed, id, { user: 'U0BOB', actionTs: t(2) });
  onClick(again, ctx); // the same button again before the message changed: nothing new to record
  w.issues.liftMute(id, w.clock.now); // a rise to critical ended the mute
  assert.equal(onClick(again, ctx).updated, undefined, 'its redelivery');
  assert.equal(w.issues.disposition(id, w.clock.now), undefined);
});

test('a click and its message update commit together: when the update cannot be queued, the click is not recorded', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  const ctx = { issues: w.issues, outbox: w.box, ids: IDS, now: () => w.clock.now };
  const raw = new DatabaseSync(w.db);
  raw.exec(`CREATE TRIGGER outbox_full BEFORE INSERT ON slack_outbox BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  assert.throws(() => onClick(payload(ACTION.dismissed, id, { user: 'U0BOB' }), ctx), /disk full/);
  assert.equal(w.issues.disposition(id, w.clock.now), undefined);
  assert.deepEqual(w.issues.events(id).map((e) => e.type), ['opened']);
  raw.exec(`DROP TRIGGER outbox_full`);
  assert.equal(onClick(payload(ACTION.dismissed, id, { user: 'U0BOB' }), ctx).updated, id, 'clicked again, it goes through');
  await w.box.flush();
  assert.equal(w.t.updates.length, 1);
});

test('a duplicate click makes one update; two clicks before a flush make one too', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 0.25) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  await w.click('acknowledged', id);
  const twice = await w.click('acknowledged', id);
  assert.equal(twice.reply, `${id} is already marked On it by you. Nothing changed.`);
  assert.equal(w.t.updates.length, 1);

  // Bob takes it over and then says Not an issue, both before the outbox sends.
  onClick(payload(ACTION.acknowledged, id, { user: 'U0BOB' }), { issues: w.issues, outbox: w.box, ids: IDS, now: () => w.clock.now });
  onClick(payload(ACTION.dismissed, id, { user: 'U0BOB' }), { issues: w.issues, outbox: w.box, ids: IDS, now: () => w.clock.now });
  await w.box.flush();
  assert.equal(w.t.updates.length, 2, 'one update, showing the latest');
  assert.deepEqual(buttons(w.t.updates[1]!.blocks), [ACTION.undo]);

  // Resolved: the message says so and loses its buttons; a late click changes nothing.
  const back = await w.patrol(tel, 0.25);
  assert.deepEqual(back.resolved, [id]);
  assert.deepEqual(buttons(w.t.updates.at(-1)!.blocks), []);
  assert.equal(note(w.t.updates.at(-1)!.blocks), `✅ ${id} resolved at 11-02 08:15Z`);
  assert.equal(w.issues.disposition(id, at(0.25)), undefined, 'resolving ends the mute');
  const late = await w.click('undo', id);
  assert.equal(late.reply, `${id} is resolved. Nothing changed.`);
  assert.equal(w.t.updates.length, 3);
});

test('Socket Mode: a click is recorded before Slack is acknowledged, then the clicker gets a reply and the message one update', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  const handlers = new Map<string, (a: { body?: unknown; ack?: () => Promise<void> }) => void>();
  const client: SocketClient = { on: (e, f) => handlers.set(e, f), start: async () => {}, disconnect: async () => {} };
  const replies: Array<[string, string]> = [];
  const logs: string[] = [];
  const socket = startButtons({
    appToken: 'xapp-1-A0TESTAPP-1-abcdef',
    appId: IDS.app,
    channel: IDS.channel,
    team: async () => IDS.team,
    issues: w.issues,
    outbox: w.box,
    log: (s) => logs.push(s),
    client: () => client,
    respond: async (url, text) => void replies.push([url, text]),
    now: () => w.clock.now,
  });
  await socket.ready;
  const seenAtAck: Array<string | undefined> = [];
  handlers.get('interactive')!({ body: payload(ACTION.acknowledged, id), ack: async () => void seenAtAck.push(w.issues.disposition(id, w.clock.now)?.kind) });
  for (let i = 0; i < 50 && !w.t.updates.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seenAtAck, ['acknowledged'], 'persisted before the ack');
  assert.equal(replies.length, 1);
  assert.equal(replies[0]![0], RESPONSE);
  assert.match(replies[0]![1], /^On it:/);
  assert.equal(w.t.updates.length, 1, 'flushed after the ack');
  assert.ok(logs.includes(`${id}: On it (Slack button)`));
  assert.ok(!logs.some((l) => l.includes('hooks.slack.com')), 'no response URL in the logs');
  await socket.stop();
});

test('Socket Mode: the workspace comes from the bot, and a click from another one changes nothing', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  const handlers = new Map<string, (a: { body?: unknown; ack?: () => Promise<void> }) => void>();
  const client: SocketClient = { on: (e, f) => handlers.set(e, f), start: async () => {}, disconnect: async () => {} };
  const replies: string[] = [];
  let calls = 0;
  const waits: number[] = [];
  const socket = startButtons({
    appToken: 'xapp-1-A0TESTAPP-1-abcdef',
    appId: IDS.app,
    channel: IDS.channel,
    team: async () => (++calls === 1 ? Promise.reject(new Error('Slack: HTTP 503')) : 'T0BOTSTEAM'),
    issues: w.issues,
    outbox: w.box,
    log: () => {},
    client: () => client,
    respond: async (_url, text) => void replies.push(text),
    sleep: async (ms) => void waits.push(ms),
  });
  await socket.ready;
  assert.equal(calls, 2, 'auth.test retried');
  assert.deepEqual(waits, [60_000], 'after a minute');
  let acked = false;
  handlers.get('interactive')!({ body: payload(ACTION.dismissed, id), ack: async () => void (acked = true) });
  for (let i = 0; i < 50 && !replies.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(acked);
  assert.match(replies[0]!, /only in the monitor channel/);
  assert.equal(w.issues.disposition(id, w.clock.now), undefined);
  await socket.stop();
});

// ---- off unless configured --------------------------------------------------------

test('no buttons without the app token: messages as before, and nothing is updated', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 0.25) });
  const w = setup({ buttons: false });
  const id = opened(await w.patrol(tel, 0));
  assert.deepEqual(buttons(w.t.sent[0]!.blocks), []);
  assert.equal(w.box.buttons, false);
  w.box.updateRoot(id);
  await w.patrol(tel, 0.25); // resolved
  assert.deepEqual(w.t.updates, []);
  assert.deepEqual(w.box.status(), [{ status: 'sent', n: 2 }]);

  const { loadConfig } = await import('../src/config.js');
  const slack = { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_CHANNEL_ID: 'C0CBLUZLW4S' };
  assert.equal(loadConfig(slack).slackApp, undefined);
  assert.deepEqual(loadConfig({ ...slack, SLACK_APP_TOKEN: 'xapp-1-A0CCRGAHVGF-1234567890123-0a1b2c' }).slackApp, { token: 'xapp-1-A0CCRGAHVGF-1234567890123-0a1b2c', appId: 'A0CCRGAHVGF' });
  assert.throws(() => loadConfig({ ...slack, SLACK_APP_TOKEN: 'xoxb-not-an-app-token' }), /app-level token/);
  assert.throws(() => loadConfig({ ...slack, SLACK_APP_TOKEN: 'xapp-unknown-shape' }), /SLACK_APP_ID/);
  assert.equal(loadConfig({ ...slack, SLACK_APP_TOKEN: 'xapp-unknown-shape', SLACK_APP_ID: 'A0CCRGAHVGF' }).slackApp?.appId, 'A0CCRGAHVGF');
});

// ---- noise-rule candidates, for admins ---------------------------------------------

test('admins read Not an issue clicks as noise-rule candidates over MCP; members do not see the tool', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const w = setup();
  const id = opened(await w.patrol(tel, 0));
  await w.click('dismissed', id, { user: 'U0BOB' }, 0.25);
  const users = Users.load(join(mkdtempSync(join(tmpdir(), 'users-')), 'users.json'));
  users.add('root', { admin: true });
  users.add('dev');
  const ctx: McpContext = { cfg: { ...w.c, mcp: { ...w.c.mcp, usersFile: users.file } }, engine: { store: new Store(w.db), runsDir: w.c.runsDir, stopFile: join(w.c.runsDir, 'STOP'), session: w.session, dailyCapUsd: 1000, llmAvailable: true }, users, repos: new Map(), issues: w.issues };
  const connect = async (name: string) => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildServer(ctx, users.list().find((u) => u.name === name)!).connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    return client;
  };
  const admin = await connect('root');
  const got = (await admin.callTool({ name: 'noise_candidates', arguments: {} })) as { content: Array<{ text: string }> };
  assert.match(got.content[0]!.text, new RegExp(`^${id} · open · Not an issue 1× · Sign-in rejects emails with a trailing space\\n  rows: http\\|backend-production\\|/v1/auth/login\\|400\\n  2026-11-02T08:15Z by U0BOB`));
  assert.match(got.content[0]!.text, /reviewed change to config\/noise\.yaml/);
  const member = await connect('dev');
  assert.ok(!(await member.listTools()).tools.some((t) => t.name === 'noise_candidates'));
});

// ---- 11-02/03, simulated (the schedule of issues.test.ts) ---------------------------

test('11-02/03 simulated: a click after the first post saves the AI runs its own rows would trigger, and the channel sees one message', async () => {
  const NOV2: Schedule = {
    '/v1/auth/login': doubles(0, 9, 21),
    '/v1/ownership/transfer': doubles(1.5, 17, 21),
    '/v1/auth/signup': between(4, 21),
    '/v1/auth/password/reset': between(12, 21),
    '/v1/account/email': between(14.5, 21),
  };
  const hours = Array.from({ length: 21 * 4 }, (_, i) => i / 4);
  const visible = (s: Sent[]) => s.filter((x) => !x.thread_ts || x.reply_broadcast).length;
  const run = async (click?: Click) => {
    const w = setup();
    for (const h of hours) {
      await w.patrol(schedule(NOV2), h);
      if (click && h === 0) await w.click(click, w.issues.openIssues()[0]!.id, {}, 0.1);
    }
    return w;
  };
  const none = await run();
  assert.equal(none.session.seen.length, 7, 'as in issues.test.ts: two of them for rows that got worse');
  const onIt = await run('acknowledged');
  assert.equal(onIt.session.seen.length, 5, 'new sibling rows still get a run: only the investigator links them');
  assert.equal(visible(onIt.t.sent), 1);
  assert.equal(onIt.t.sent.filter((s) => s.text.startsWith('📈 Worse')).length, 2, 'the two worse rows: a line each, in the thread');
  const notAnIssue = await run('dismissed');
  assert.equal(notAnIssue.session.seen.length, 5);
  assert.equal(notAnIssue.t.sent.length, 1, 'nothing after the first message');
  assert.equal(notAnIssue.issues.openIssues()[0]!.rows.length, 5, 'the linked rows joined the issue');
});
