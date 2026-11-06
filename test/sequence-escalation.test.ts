import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Sample } from '../src/clients/telemetry.js';
import type { Config } from '../src/config.js';
import { loadAgent } from '../src/engine/agent.js';
import type { Session } from '../src/engine/session.js';
import { Store } from '../src/engine/store.js';
import type { Report } from '../src/investigate/report.js';
import { CardSink } from '../src/output/sink.js';
import { SlackOutbox, type Transport } from '../src/output/slack.js';
import { Issues, type Click } from '../src/patrol/issues.js';
import { Noise } from '../src/patrol/noise.js';
import { Owners } from '../src/patrol/owners.js';
import { State } from '../src/patrol/state.js';
import { patrolOnce, type MonitorAgent, type PatrolResult } from '../src/runner.js';
import { ACTION, controlsFor, onClick, type ButtonIds } from '../src/slack/buttons.js';
import { fakeSession, ok } from './fake-session.js';
import { FakeTelemetry, H, testConfig } from './fake.js';

// Escalation as a sequence of patrols: a major issue is posted, and whether
// anyone clicks On it decides if its backup is asked in its thread N minutes
// later. The world and helpers are copied from buttons.test.ts.

type Schedule = Record<string, (t: number) => number>;
const T0 = Date.parse('2026-11-02T08:00:00Z');
const at = (hours: number) => new Date(T0 + hours * H);
const between = (from: number, to: number, n = 20) => (t: number) => (t >= T0 + from * H && t < T0 + to * H ? n : 0);

function schedule(s: Schedule) {
  return new FakeTelemetry((query: string, when: Date): Sample[] => {
    if (/^count\(kube_(pod_container_status_restarts_total|deployment_spec_replicas)\b/.test(query)) return [{ labels: {}, value: 120 }];
    if (!query.includes('backend_be_production_http_requests_total')) return [];
    return Object.entries(s).flatMap(([route, f]) => [
      { labels: { route, status_code: '200' }, value: 1000 },
      { labels: { route, status_code: '400' }, value: f(when.getTime()) },
    ]);
  });
}

// The model: one report per patrol over its rows, linked to the first listed issue.
const report = (over: Partial<Report>): Report => ({
  title: 'Sign-in rejects emails with a trailing space',
  severity: 'major',
  status: 'active',
  started_at: '2026-11-02T08:00:00Z',
  what_broke: 'POST /v1/auth/login returns 400 for valid accounts',
  impact: '30 failed sign-ins in 15 min',
  reach: 'many',
  cause: { hypothesis: 'email validation rejects a trailing space', confidence: 'medium' },
  evidence: [],
  suggested_fix: 'trim the email before validating it',
  not_checked: [],
  rows: [],
  issue: 'new',
  ...over,
});

function model(): Session & { seen: string[][] } {
  const seen: string[][] = [];
  const session = (req: Parameters<Session>[0]) =>
    fakeSession(async function* (sim) {
      if (sim.req.tools.some((t) => t.name === 'submit_challenge')) {
        await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
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
      const r = await sim.mcp('submit_report', report({ evidence: [{ id, quote, claim: 'the route returns 400' }], rows, issue: issues[0] ?? 'new' }));
      assert.equal(r.isError, false, r.text);
      yield ok(0.1, 3);
    })(req);
  return Object.assign(session, { seen });
}

// Slack: the bot, recording posts.
type Sent = { text: string; thread_ts?: string | undefined; reply_broadcast?: boolean | undefined };
function bot(): Transport & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    threads: true,
    sent,
    async post(m) {
      sent.push({ text: m.text, ...(m.thread_ts ? { thread_ts: m.thread_ts, reply_broadcast: m.reply_broadcast } : {}) });
      return `1700000000.${String(sent.length).padStart(6, '0')}`;
    },
    async update() {},
  };
}
const ROOT = '1700000000.000001';
const IDS: ButtonIds = { app: 'A0TESTAPP', team: 'T0TESTTEAM', channel: 'C0TEST123' };
let clicks = 0;
function payload(action: string, issue: string, user: string) {
  return {
    type: 'block_actions',
    api_app_id: IDS.app,
    team: { id: IDS.team, domain: 'stark' },
    user: { id: user, team_id: IDS.team },
    channel: { id: IDS.channel, name: 'prod-monitor' },
    container: { type: 'message', message_ts: ROOT, channel_id: IDS.channel, is_ephemeral: false },
    response_url: 'https://hooks.slack.com/actions/T0TESTTEAM/1700000100/AbCdEf',
    trigger_id: '1.2.3',
    actions: [{ action_id: action, block_id: 'issue_buttons', value: issue, type: 'button', action_ts: `1700000100.${String(++clicks).padStart(6, '0')}` }],
  };
}

const BACKEND = { primary: '<@U0PRIMARY1>', backup: '<@U0BACKUP1>' };
const ESCALATION = { after_minutes: 30, severities: ['critical', 'major'] };

// A patrol world with one engine.db and the buttons on (unless `buttons: false`).
function setup(owners: Owners, o: { buttons?: boolean } = {}) {
  const c: Config = testConfig();
  const db = join(c.runsDir, 'engine.db');
  const clock = { now: new Date(T0) };
  const issues = new Issues(db);
  const t = bot();
  const box = new SlackOutbox(db, t, { now: () => clock.now, sleep: async () => {}, gapMs: 0, ...(o.buttons === false ? {} : { controls: controlsFor(issues, () => clock.now) }) });
  const sink = new CardSink(c.outDir, box);
  const session = model();
  const monitor: MonitorAgent = {
    engine: { store: new Store(db), runsDir: c.runsDir, stopFile: join(c.runsDir, 'STOP'), session, dailyCapUsd: 1000, llmAvailable: true },
    agent: loadAgent(join(c.agentsDir, 'monitor')),
  };
  const state = State.memory();
  const logs: string[] = [];
  const patrol = async (tel: FakeTelemetry, hours: number): Promise<PatrolResult> => {
    clock.now = at(hours);
    return patrolOnce(tel, c, new Noise({}), state, sink, at(hours), { llm: true, post: true, log: (s) => logs.push(s), owners, issues, buttons: o.buttons !== false }, monitor);
  };
  const click = async (what: Click, issue: string, user: string, hours: number) => {
    clock.now = at(hours);
    onClick(payload(ACTION[what], issue, user), { issues, outbox: box, ids: IDS, now: () => clock.now });
    await box.flush();
  };
  const asked = () => t.sent.filter((s) => s.text.startsWith('⏰'));
  return { t, issues, session, patrol, click, logs, asked };
}
const opened = (r: PatrolResult) => (r.filed[0]?.action === 'opened' ? r.filed[0].issue.id : assert.fail(`not opened: ${r.filed[0]?.action}`));

test('a major nobody clicks On it on: 30 min later exactly one reply in its thread asks the backup, and never again', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const w = setup(new Owners({ owners: { 'backend-*': BACKEND }, escalation: ESCALATION }));
  const id = opened(await w.patrol(tel, 0));
  assert.equal(w.t.sent.length, 1);
  assert.equal(w.t.sent[0]!.thread_ts, undefined, 'the issue is posted to the channel');
  assert.match(w.t.sent[0]!.text, /· cc <@U0PRIMARY1>$/, 'the card mentions the primary');
  assert.ok(!w.t.sent[0]!.text.includes('U0BACKUP1'), 'not the backup');

  await w.patrol(tel, 0.25);
  assert.deepEqual(w.asked(), [], 'not before 30 minutes');

  await w.patrol(tel, 0.5);
  assert.deepEqual(w.asked(), [{ text: `⏰ Nobody is on ${id} after 30 min: <@U0BACKUP1>, can you take a look?`, thread_ts: ROOT, reply_broadcast: false }]);
  assert.ok(w.logs.includes(`${id}: nobody on it after 30 min: its backup is asked in its thread`));

  for (const h of [0.75, 1, 3, 26]) await w.patrol(tel, h);
  assert.equal(w.asked().length, 1, 'asked once');
  assert.equal(w.issues.events(id).filter((e) => e.type === 'escalated').length, 1);
  assert.deepEqual(w.issues.events(id).find((e) => e.type === 'escalated')!.data, { to: ['<@U0BACKUP1>'], after_minutes: 30 });
  assert.equal(w.session.seen.length, 1, 'code asks the backup: no AI run');
});

test('with On it inside the window, the backup is never asked', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const w = setup(new Owners({ owners: { 'backend-*': BACKEND }, escalation: ESCALATION }));
  const id = opened(await w.patrol(tel, 0));
  await w.click('acknowledged', id, 'U0ALICE', 0.2);
  for (const h of [0.25, 0.5, 0.75, 1, 3]) await w.patrol(tel, h);
  assert.deepEqual(w.asked(), []);
  assert.equal(w.t.sent.length, 1, 'nothing else posted');

  // Not an issue says someone looked too.
  const w2 = setup(new Owners({ owners: { 'backend-*': BACKEND }, escalation: ESCALATION }));
  const id2 = opened(await w2.patrol(tel, 0));
  await w2.click('dismissed', id2, 'U0BOB', 0.2);
  for (const h of [0.25, 0.5, 1]) await w2.patrol(tel, h);
  assert.deepEqual(w2.asked(), []);
});

test('off by default: no escalation settings, no backup, a severity not listed, or no buttons, and nobody is asked', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const worlds = [
    setup(new Owners({ owners: { 'backend-*': BACKEND } })), // no escalation: block
    setup(Owners.load(new URL('../config/owners.yaml', import.meta.url).pathname)), // the shipped file
    setup(new Owners({ owners: { 'backend-*': '<@U0PRIMARY1>' }, escalation: ESCALATION })), // no backup
    setup(new Owners({ owners: { 'backend-*': BACKEND }, escalation: { after_minutes: 30, severities: ['critical'] } })), // a major
    setup(new Owners({ owners: { 'backend-*': BACKEND }, escalation: ESCALATION }), { buttons: false }), // nobody can say On it
    setup(new Owners({ mentions: false, owners: { 'backend-*': BACKEND }, escalation: ESCALATION })), // mentions off
  ];
  for (const [i, w] of worlds.entries()) {
    opened(await w.patrol(tel, 0));
    for (const h of [0.25, 0.5, 1, 3]) await w.patrol(tel, h);
    assert.deepEqual(w.asked(), [], `world ${i}`);
    assert.equal(w.t.sent.length, 1, `world ${i}: only the issue's own post`);
  }
});

test('once per episode: an issue that resolves and comes back unclaimed is escalated again', async () => {
  const tel = schedule({ '/v1/auth/login': (t) => between(0, 1)(t) || between(8, 40)(t) });
  const w = setup(new Owners({ owners: { 'backend-*': BACKEND }, escalation: ESCALATION }));
  const id = opened(await w.patrol(tel, 0));
  for (const h of [0.25, 0.5, 0.75, 1, 1.25]) await w.patrol(tel, h);
  assert.equal(w.issues.get(id)!.status, 'resolved');
  assert.equal(w.asked().length, 1);
  assert.equal((await w.patrol(tel, 8)).filed[0]?.action, 'reopened');
  await w.patrol(tel, 8.25);
  assert.equal(w.asked().length, 1, 'the new episode has its own 30 minutes');
  await w.patrol(tel, 8.5);
  assert.equal(w.asked().length, 2);
  assert.deepEqual(w.asked()[1], { text: `⏰ Nobody is on ${id} after 30 min: <@U0BACKUP1>, can you take a look?`, thread_ts: ROOT, reply_broadcast: false });
  await w.patrol(tel, 9);
  assert.equal(w.asked().length, 2);
});
