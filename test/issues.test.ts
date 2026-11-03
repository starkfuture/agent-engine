import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Sample } from '../src/clients/telemetry.js';
import type { Config } from '../src/config.js';
import { loadAgent } from '../src/engine/agent.js';
import type { Session } from '../src/engine/session.js';
import { Store } from '../src/engine/store.js';
import { monitorTask } from '../src/investigate/prompt.js';
import { checkReport, type Report } from '../src/investigate/report.js';
import { buildServer, type McpContext } from '../src/mcp/server.js';
import { Users } from '../src/mcp/users.js';
import { CardSink } from '../src/output/sink.js';
import { SlackError, SlackOutbox, webhookTransport, type SlackMessage, type Transport } from '../src/output/slack.js';
import { Issues } from '../src/patrol/issues.js';
import { Noise } from '../src/patrol/noise.js';
import { State } from '../src/patrol/state.js';
import { patrolOnce, type MonitorAgent, type PatrolResult } from '../src/runner.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { fakeSession, ok } from './fake-session.js';
import { FakeTelemetry, H, testConfig } from './fake.js';

// ---- the world: legacy /v1 routes whose 400s fire on a schedule -----------------

type Schedule = Record<string, (t: number) => number>; // route → 400s in the window at time t
const T0 = Date.parse('2026-11-02T08:00:00Z');
const at = (hours: number) => new Date(T0 + hours * H);
const between = (from: number, to: number, n = 30) => (t: number) => (t >= T0 + from * H && t < T0 + to * H ? n : 0);
const key = (route: string) => `http|backend-production|${route}|400`;

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

// ---- the model: links or not, as the test decides ------------------------------

interface Seen {
  prompt: string;
  rows: string[]; // the row keys the task asks it to cover
  issues: Array<{ id: string; resolved: boolean }>; // the issue list it was shown
}
type Decide = (s: Seen) => Partial<Report> & { expectRejected?: RegExp };

const report = (over: Partial<Report> = {}): Report => ({
  title: 'Sign-in rejects emails with a trailing space',
  severity: 'major',
  status: 'active',
  started_at: '2026-11-02T08:00:00Z',
  what_broke: 'POST /v1/auth/login returns 400 for valid accounts',
  impact: '30 failed sign-ins in 15 min',
  cause: { hypothesis: 'email validation rejects a trailing space', confidence: 'medium' },
  evidence: [{ id: 'E-abcd-1', quote: 'x', claim: 'the route returns 400' }],
  suggested_fix: 'trim the email before validating it',
  not_checked: [],
  rows: [],
  issue: 'new',
  ...over,
});

function parse(prompt: string): Seen {
  const rows: string[] = [];
  let inRows = false;
  for (const l of prompt.split('\n')) {
    if (l.startsWith('Row keys to cover')) inRows = true;
    else if (inRows && l.startsWith('- ')) rows.push(l.slice(2));
    else if (inRows) inRows = false;
  }
  const issues = [...prompt.matchAll(/^- (I-[0-9a-f]{4,6}) · (open|RESOLVED)/gm)].map((m) => ({ id: m[1]!, resolved: m[2] === 'RESOLVED' }));
  return { prompt, rows, issues };
}

// One fake investigation per patrol: read one tool result, cite it, submit
// one report covering every row, as decided. A challenger (big spikes) agrees.
function model(decide: Decide): Session & { seen: Seen[] } {
  const seen: Seen[] = [];
  const session = (req: Parameters<Session>[0]) =>
    fakeSession(async function* (sim) {
      if (sim.req.tools.some((t) => t.name === 'submit_challenge')) {
        await sim.mcp('submit_challenge', { objections: [], overall: 'Holds up: the counts match the evidence.' });
        yield ok(0.05, 1);
        return;
      }
      const s = parse(sim.req.prompt);
      seen.push(s);
      const out = await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
      const id = /evidence_id: (E-[0-9a-f]{4}-\d+)/.exec(out.text)![1]!;
      const quote = /^\S+ 400 \| [1-9]\d*/m.exec(out.text)![0];
      const { expectRejected, ...over } = decide(s);
      const r = await sim.mcp('submit_report', report({ evidence: [{ id, quote, claim: 'the route returns 400' }], rows: s.rows, ...over }));
      if (expectRejected) {
        assert.equal(r.isError, true);
        assert.match(r.text, expectRejected);
        const again = await sim.mcp('submit_report', report({ evidence: [{ id, quote, claim: 'the route returns 400' }], rows: s.rows, ...over, issue: 'new' }));
        assert.equal(again.isError, false, again.text);
      } else assert.equal(r.isError, false, r.text);
      yield ok(0.1, 3);
    })(req);
  return Object.assign(session, { seen });
}

// The same cause, linked whenever an issue is listed (open or resolved).
const linker = (over: Partial<Report> = {}): Decide => (s) => ({ ...over, issue: s.issues[0]?.id ?? 'new' });

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
  };
}
function webhook(): Transport & { sent: Sent[] } {
  const sent: Sent[] = [];
  return { threads: false, sent, post: async (m) => void sent.push({ text: m.text }) };
}

// A patrol world with one engine.db for the issues and the outbox, as in production.
function setup(transport: Transport, decide: Decide, o: { issues?: boolean; oncall?: string | undefined } = {}) {
  const c: Config = { ...testConfig(), slackOncall: o.oncall };
  const db = join(c.runsDir, 'engine.db');
  const clock = { now: new Date(T0) };
  const box = new SlackOutbox(db, transport, { now: () => clock.now, sleep: async () => {}, gapMs: 0 });
  const sink = new CardSink(c.outDir, box);
  const issues = o.issues === false ? undefined : new Issues(db);
  const session = model(decide);
  const monitor: MonitorAgent = {
    engine: { store: new Store(db), runsDir: c.runsDir, stopFile: join(c.runsDir, 'STOP'), session, dailyCapUsd: 1000, llmAvailable: true },
    agent: loadAgent(join(c.agentsDir, 'monitor')),
  };
  const state = State.memory();
  const rules = { noise: new Noise({}) }; // a test may add a noise rule part way
  const logs: string[] = [];
  const patrol = async (tel: FakeTelemetry, hours: number): Promise<PatrolResult> => {
    clock.now = at(hours);
    return patrolOnce(tel, c, rules.noise, state, sink, at(hours), { llm: true, post: true, log: (s) => logs.push(s), issues }, monitor);
  };
  return { c, db, box, issues, session, patrol, logs, state, rules };
}

// ---- the posting rule ---------------------------------------------------------------

test('a linked report replies in the issue thread without broadcast; after 24 h with no news it is shown once', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40), '/v1/ownership/transfer': between(2, 40), '/v1/auth/signup': between(26, 40), '/v1/auth/reset': between(28, 40) });
  const t = bot();
  const w = setup(t, linker());
  const first = await w.patrol(tel, 0);
  assert.equal(first.filed[0]?.action, 'opened');
  const id = first.filed[0]!.action === 'opened' ? first.filed[0]!.issue.id : '';
  assert.match(id, /^I-[0-9a-f]{4}$/);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0]!.thread_ts, undefined, 'a new issue is a new message');
  assert.match(JSON.stringify(t.sent[0]), /Major: Sign-in rejects emails/);

  const sibling = await w.patrol(tel, 2); // another flow, same cause
  assert.equal(sibling.filed[0]?.action, 'linked');
  assert.deepEqual(w.session.seen[1]!.issues, [{ id, resolved: false }], 'the investigator was shown the open issue');
  assert.deepEqual(t.sent[1], { text: `🟠 Update on ${id}: Sign-in rejects emails with a trailing space`, thread_ts: '1700000000.000001', reply_broadcast: false });

  // The rows' 24 h Slack window is over and the issue is still open. The
  // channel last heard of it 26 h ago, so this one is shown there once.
  const nextDay = await w.patrol(tel, 26);
  assert.equal(nextDay.filed[0]?.action, 'reminded');
  assert.deepEqual(t.sent.slice(2), [{ text: `🟠 Update on ${id}: Sign-in rejects emails with a trailing space`, thread_ts: '1700000000.000001', reply_broadcast: true }]);
  assert.ok(w.logs.includes(`report 1 linked to ${id}: open with no news in the channel for 24 h (broadcast)`));
  assert.deepEqual(w.issues!.events(id).map((e) => e.type), ['opened', 'report_linked', 'report_linked', 'reminded']);
  const card = readFileSync(nextDay.cards.at(-1)!, 'utf8');
  assert.match(card, new RegExp(`^## 🟠 Update on ${id}: Sign-in rejects emails with a trailing space\\n\\*\\*Issue:\\*\\* ${id} \\(same cause\\)`));

  const after = await w.patrol(tel, 28); // quiet again for the next 24 h
  assert.equal(after.filed[0]?.action, 'linked');
  assert.deepEqual(t.sent.slice(3), [{ text: `🟠 Update on ${id}: Sign-in rejects emails with a trailing space`, thread_ts: '1700000000.000001', reply_broadcast: false }]);
  assert.deepEqual(w.issues!.get(id)!.rows, [key('/v1/auth/login'), key('/v1/auth/reset'), key('/v1/auth/signup'), key('/v1/ownership/transfer')], "the linked reports' rows joined the issue");
  assert.ok(w.logs.includes(`report 1 linked to ${id} (no broadcast)`));
});

test('an issue id that was not in the list is rejected; the investigator fixes it', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40), '/v1/ownership/transfer': between(1, 40) });
  const t = bot();
  const w = setup(t, (s) => (s.issues.length ? { issue: 'I-dead', expectRejected: /issue I-dead is not in the issue list/ } : { issue: 'new' }));
  await w.patrol(tel, 0);
  const r = await w.patrol(tel, 1);
  assert.equal(r.filed[0]?.action, 'opened', 'resubmitted as "new"');
  assert.match(checkReport(report({ issue: 'I-0000', rows: ['k'] }), new Set(['k']), new Set(['I-1234'])).join(), /not in the issue list/);
  assert.deepEqual(checkReport(report({ issue: 'I-1234', rows: ['k'] }), new Set(['k']), new Set(['I-1234'])), []);
});

test('a severity rise on an open issue is broadcast', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40), '/v1/ownership/transfer': between(1, 40) });
  const t = bot();
  const w = setup(t, (s) => (s.issues.length ? { issue: s.issues[0]!.id, severity: 'critical' } : { issue: 'new' }));
  await w.patrol(tel, 0);
  const r = await w.patrol(tel, 1);
  assert.equal(r.filed[0]?.action, 'raised');
  const id = r.filed[0]!.action === 'raised' ? r.filed[0]!.issue.id : '';
  assert.deepEqual(t.sent[1], { text: `🔴 Update on ${id}: Sign-in rejects emails with a trailing space`, thread_ts: '1700000000.000001', reply_broadcast: true });
  assert.equal(w.issues!.get(id)!.severity, 'critical');
  assert.deepEqual(w.issues!.events(id).map((e) => e.type), ['opened', 'report_linked', 'severity_raised']);
  assert.ok(w.logs.includes(`report 1 linked to ${id}: severity major → critical (broadcast)`));
  assert.match(readFileSync(r.cards.at(-1)!, 'utf8'), /\*\*Issue:\*\* I-[0-9a-f]{4} \(severity raised from major\)/);
});

test('linking to a resolved issue reopens it and is broadcast', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 0.25), '/v1/ownership/transfer': between(3, 40) });
  const t = bot();
  const w = setup(t, linker());
  const first = await w.patrol(tel, 0);
  const id = first.filed[0]!.action === 'opened' ? first.filed[0]!.issue.id : '';
  const back = await w.patrol(tel, 0.25);
  assert.deepEqual(back.resolved, [id]);
  assert.equal(w.issues!.get(id)!.status, 'resolved');
  const again = await w.patrol(tel, 3);
  assert.deepEqual(w.session.seen[1]!.issues, [{ id, resolved: true }], 'shown as resolved');
  assert.match(w.session.seen[1]!.prompt, new RegExp(`<<<issues \\(untrusted data[^\\n]*\\n- ${id} · RESOLVED at 2026-11-02T08:15Z · major · Sign-in rejects emails with a trailing space\\n  first seen 2026-11-02T08:00Z · last report 2026-11-02T08:00Z\\n  rows: ${key('/v1/auth/login').replaceAll('|', '\\|')}\\n  latest cause: email validation rejects a trailing space\\n>>>`));
  assert.equal(again.filed[0]?.action, 'reopened');
  assert.equal(w.issues!.get(id)!.status, 'open');
  assert.deepEqual(w.issues!.events(id).map((e) => e.type), ['opened', 'resolved', 'reopened', 'report_linked']);
  assert.deepEqual(t.sent, [
    { text: '🟠 Major: Sign-in rejects emails with a trailing space' },
    { text: `✅ Back to normal at 08:15Z · ${id} resolved: backend-production · /v1/auth/login 400`, thread_ts: '1700000000.000001', reply_broadcast: false },
    { text: `🟠 Update on ${id}: Sign-in rejects emails with a trailing space`, thread_ts: '1700000000.000001', reply_broadcast: true },
  ]);
  assert.ok(w.logs.includes(`report 1 reopened ${id}: it came back (broadcast)`));
});

test('an issue resolves when every row is back, with one recovery note in its thread', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 0.25), '/v1/ownership/transfer': between(0, 0.5) });
  const t = bot();
  const w = setup(t, linker());
  const first = await w.patrol(tel, 0);
  const id = first.filed[0]!.action === 'opened' ? first.filed[0]!.issue.id : '';
  assert.deepEqual(first.filed[0]!.action === 'opened' && first.filed[0]!.issue.rows, [key('/v1/auth/login'), key('/v1/ownership/transfer')]);
  const partly = await w.patrol(tel, 0.25);
  assert.deepEqual(partly.summary.recovered, [key('/v1/auth/login')]);
  assert.deepEqual(partly.resolved, []);
  assert.equal(t.sent.length, 1, 'no recovery note while a row of the issue still fires');
  assert.ok(w.logs.includes(`${id}: 1 of 2 row(s) back to normal, still open`));
  const all = await w.patrol(tel, 0.5);
  assert.deepEqual(all.resolved, [id]);
  assert.equal(t.sent.filter((s) => s.text.includes('Back to normal')).length, 1);
  assert.deepEqual(t.sent[1], { text: `✅ Back to normal at 08:30Z · ${id} resolved: 2 signals`, thread_ts: '1700000000.000001', reply_broadcast: false });
  assert.equal(w.issues!.get(id)!.resolved_at, '2026-11-02T08:30:00.000Z');
  await w.patrol(tel, 0.75);
  assert.equal(t.sent.length, 2, 'resolved once');
});

test('a row hidden by a noise rule still fires: its issue stays open until it stops', async () => {
  const login = (t: number) => (between(0, 0.25)(t) || between(0.5, 2)(t));
  const tel = schedule({ '/v1/auth/login': login, '/v1/ownership/transfer': between(0, 1) });
  const t = bot();
  const w = setup(t, linker());
  const first = await w.patrol(tel, 0);
  const id = first.filed[0]!.action === 'opened' ? first.filed[0]!.issue.id : '';
  await w.patrol(tel, 0.25); // login back to normal, transfer still fires
  w.rules.noise = new Noise({ noise: [{ id: 'login-flake', reason: 'known flake', route: '/v1/auth/login', expires: '2026-12-01' }] });
  const hidden = await w.patrol(tel, 0.5); // login fires again, hidden by the rule
  assert.deepEqual(hidden.summary.suppressed.map((s) => s.row.key), [key('/v1/auth/login')]);
  const transferBack = await w.patrol(tel, 1);
  assert.deepEqual(transferBack.summary.recovered, [key('/v1/ownership/transfer')]);
  assert.deepEqual(transferBack.resolved, [], 'login still fires under the rule');
  assert.ok(w.logs.includes(`${id}: 1 of 2 row(s) back to normal, still open`));
  assert.equal(t.sent.filter((s) => s.text.includes('Back to normal')).length, 0);
  const loginBack = await w.patrol(tel, 2);
  assert.deepEqual(loginBack.resolved, [id]);
  assert.equal(t.sent.filter((s) => s.text.includes('Back to normal')).length, 1);
});

test('an urgent rows card in the issue thread is news: no reminder broadcast 3 h later', async () => {
  const login = (t: number) => (t >= T0 && t < T0 + 40 * H ? (t >= T0 + 23 * H ? 300 : 30) : 0);
  const tel = schedule({ '/v1/auth/login': login, '/v1/auth/signup': between(26, 40) });
  const t = bot();
  const w = setup(t, linker());
  const first = await w.patrol(tel, 0);
  const id = first.filed[0]!.action === 'opened' ? first.filed[0]!.issue.id : '';
  await w.patrol(tel, 23); // ten times worse: urgent, the rows card goes to the channel in the issue's thread
  assert.ok(t.sent.some((s) => s.thread_ts === '1700000000.000001' && s.reply_broadcast === true), 'the rows card was broadcast in the thread');
  assert.ok(w.issues!.events(id).some((e) => e.type === 'rows_posted' && e.at === at(23).toISOString()));
  const sent = t.sent.length;
  const sibling = await w.patrol(tel, 26); // 26 h after it opened, 3 h after the rows card
  assert.equal(sibling.filed[0]?.action, 'linked');
  assert.deepEqual(t.sent.slice(sent).map((s) => s.reply_broadcast), [false]);
});

test("a new cause on an open issue's rows gets its own message, not that issue's thread", async () => {
  const login = (t: number) => (t >= T0 && t < T0 + 40 * H ? (t >= T0 + 0.25 * H ? 45 : 20) : 0);
  const tel = schedule({ '/v1/auth/login': login });
  const t = bot();
  let n = 0;
  const w = setup(t, () => (++n === 1 ? { issue: 'new' } : { issue: 'new', title: 'Login rate limit rejects a shared office IP' }));
  const first = await w.patrol(tel, 0);
  const x = first.filed[0]!.action === 'opened' ? first.filed[0]!.issue.id : '';
  const second = await w.patrol(tel, 0.25); // twice as bad 15 min later, and the AI says it is another cause
  const y = second.filed[0]!.action === 'opened' ? second.filed[0]!.issue.id : '';
  assert.ok(x && y && x !== y);
  assert.deepEqual(t.sent.map((s) => s.thread_ts ?? 'root'), ['root', 'root'], 'its own message, shown in the channel');
  const roots = new DatabaseSync(w.db).prepare(`SELECT issue, ts FROM slack_issue_threads ORDER BY issue`).all() as Array<{ issue: string; ts: string }>;
  assert.equal(new Set(roots.map((r) => r.ts)).size, 2, 'each issue has its own thread');
});

test('webhook: a repeat is not posted (the card and the run keep it); news still is', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40), '/v1/ownership/transfer': between(1, 40), '/v1/auth/signup': between(2, 40) });
  const t = webhook();
  let n = 0;
  const w = setup(t, (s) => ({ issue: s.issues[0]?.id ?? 'new', severity: ++n === 3 ? 'critical' : 'major' }));
  await w.patrol(tel, 0);
  const repeat = await w.patrol(tel, 1);
  assert.equal(repeat.filed[0]?.action, 'linked');
  const id = repeat.filed[0]!.action === 'linked' ? repeat.filed[0]!.issue.id : '';
  await w.patrol(tel, 2); // major → critical: news
  assert.deepEqual(t.sent.map((s) => s.text), ['🟠 Major: Sign-in rejects emails with a trailing space', `🔴 Update on ${id}: Sign-in rejects emails with a trailing space`]);
  assert.ok(w.logs.some((l) => /slack: report post \d+ about I-[0-9a-f]{4} not sent: a repeat, and there is no thread to reply in/.test(l)));
  assert.ok(existsSync(repeat.cards.at(-1)!), 'the card stays on disk');
  const answer = readFileSync(join(repeat.investigation!.dir!, 'answer.md'), 'utf8');
  assert.match(answer, new RegExp(`### Report 1 · linked to ${id} \\(no broadcast\\)`));
});

test('"new" behaves as before: a new message (in its rows card thread when there is one), and minor is not posted', async () => {
  // A big spike: the rows card goes first, the AI report lands in its thread unbroadcast, as before.
  const tel = schedule({ '/v1/auth/login': between(0, 40, 300), '/v1/ownership/transfer': between(1, 40, 20) });
  const t = bot();
  let n = 0;
  const w = setup(t, () => ({ issue: 'new', severity: ++n === 1 ? 'major' : 'minor' }));
  const first = await w.patrol(tel, 0);
  assert.deepEqual(t.sent.map((s) => [s.thread_ts ?? 'root', s.reply_broadcast]), [['root', undefined], ['1700000000.000001', false]]);
  const blocks = JSON.stringify(t.sent);
  assert.match(blocks, /🟠 Major: Sign-in rejects emails/, 'the header is unchanged');
  assert.match(readFileSync(first.cards[1]!, 'utf8'), /\*\*Issue:\*\* I-[0-9a-f]{4} \(new issue\)/);
  const minor = await w.patrol(tel, 1);
  assert.deepEqual(minor.filed, [{ action: 'none' }], 'a minor "new" report opens no issue');
  assert.equal(t.sent.length, 2, 'and is not posted');
  assert.equal(w.issues!.openIssues().length, 1);
});

test('the new-issue card shows its id in Slack', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const t = bot();
  const posted: unknown[] = [];
  const w = setup({ threads: true, post: async (m) => (posted.push(m.blocks), t.post(m)) }, linker());
  const r = await w.patrol(tel, 0);
  const id = r.filed[0]!.action === 'opened' ? r.filed[0]!.issue.id : '';
  assert.match(JSON.stringify(posted[0]), new RegExp(`"text":"New issue ${id} · \\*active\\* since 08:00Z`));
});

test('get_run shows the issue a monitor report went to', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const w = setup(bot(), linker());
  const r = await w.patrol(tel, 0);
  const id = r.filed[0]!.action === 'opened' ? r.filed[0]!.issue.id : '';
  const users = Users.load(join(mkdtempSync(join(tmpdir(), 'users-')), 'users.json'));
  users.add('root', { admin: true });
  const engine = { store: new Store(w.db), runsDir: w.c.runsDir, stopFile: join(w.c.runsDir, 'STOP'), session: w.session, dailyCapUsd: 1000, llmAvailable: true };
  const ctx: McpContext = { cfg: { ...w.c, mcp: { ...w.c.mcp, usersFile: users.file } }, engine, users, repos: new Map() };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(ctx, users.list().find((u) => u.name === 'root')!).connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  const got = (await client.callTool({ name: 'get_run', arguments: { run_id: r.investigation!.runId } })) as { content: Array<{ text: string }> };
  assert.match(got.content[0]!.text, new RegExp(`### Report 1 · opened ${id} \\(major\\)`));
});

// ---- the on-call mention ---------------------------------------------------------

const ONCALL = '<@U0ONCALL1>';
type Posted = SlackMessage & { thread_ts?: string | undefined; reply_broadcast?: boolean | undefined };
function recorder(threads: boolean): Transport & { sent: Posted[] } {
  const sent: Posted[] = [];
  return { threads, sent, post: async (m) => (sent.push(m), threads ? `1700000000.${String(sent.length).padStart(6, '0')}` : undefined) };
}
// What Slack parses for controls: the notification text and mrkdwn (not the plain_text header).
const parsed = (m: SlackMessage) => [m.text, ...(JSON.stringify(m.blocks).match(/"type":"mrkdwn","text":"(?:[^"\\]|\\.)*"/g) ?? [])].join('\n');
const pinged = (m: SlackMessage) => parsed(m).includes(ONCALL);

test('a new critical issue mentions the on-call, in the text and on the card; its quiet repeats and reminders do not', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40), '/v1/ownership/transfer': between(2, 40), '/v1/auth/signup': between(26, 40) });
  const t = recorder(true);
  const w = setup(t, linker({ severity: 'critical' }), { oncall: ONCALL });
  assert.equal((await w.patrol(tel, 0)).filed[0]?.action, 'opened');
  assert.equal((await w.patrol(tel, 2)).filed[0]?.action, 'linked');
  assert.equal((await w.patrol(tel, 26)).filed[0]?.action, 'reminded');
  assert.deepEqual(t.sent.map((m) => [pinged(m), m.reply_broadcast]), [[true, undefined], [false, false], [false, true]]);
  assert.equal(t.sent[0]!.text, `🔴 Critical: Sign-in rejects emails with a trailing space · cc ${ONCALL}`);
  assert.match(JSON.stringify(t.sent[0]!.blocks), /"text":"New issue I-[0-9a-f]{4} · \*active\* since 08:00Z · confidence medium · cc <@U0ONCALL1>"/);
});

test('a rise to critical and a return as critical mention the on-call; majors and recoveries do not', async () => {
  const rise = recorder(true);
  const w = setup(rise, (s) => (s.issues.length ? { issue: s.issues[0]!.id, severity: 'critical' } : { issue: 'new' }), { oncall: ONCALL });
  const tel = schedule({ '/v1/auth/login': between(0, 40), '/v1/ownership/transfer': between(1, 40) });
  await w.patrol(tel, 0);
  assert.equal((await w.patrol(tel, 1)).filed[0]?.action, 'raised');
  assert.deepEqual(rise.sent.map((m) => [[...m.text][0], pinged(m)]), [['🟠', false], ['🔴', true]]);

  const back = recorder(true);
  const v = setup(back, (s) => ({ issue: s.issues[0]?.id ?? 'new', severity: s.issues.length ? 'critical' : 'major' }), { oncall: ONCALL });
  const again = schedule({ '/v1/auth/login': between(0, 0.25), '/v1/ownership/transfer': between(3, 40) });
  await v.patrol(again, 0);
  await v.patrol(again, 0.25); // resolved
  assert.equal((await v.patrol(again, 3)).filed[0]?.action, 'reopened');
  assert.deepEqual(back.sent.map((m) => [[...m.text][0], pinged(m)]), [['🟠', false], ['✅', false], ['🔴', true]]);
});

test("one patrol mentions the on-call once: a report on the rows card's rows does not again; one on other rows does", async () => {
  const LOGIN = key('/v1/auth/login');
  const TRANSFER = key('/v1/ownership/transfer');
  for (const [rows, again] of [[[LOGIN, TRANSFER], false], [[TRANSFER], true]] as const) {
    const t = recorder(true);
    const w = setup(t, () => ({ issue: 'new', severity: 'critical', rows: [...rows] }), { oncall: ONCALL });
    w.rules.noise = new Noise({ never_suppress: [{ section: 'http', route: '/v1/auth/login', status: '4..' }] });
    const r = await w.patrol(schedule({ '/v1/auth/login': between(0, 40), '/v1/ownership/transfer': between(0, 40) }), 0);
    assert.equal(r.filed[0]?.action, 'opened');
    assert.deepEqual(t.sent.map((m) => [m.text.startsWith('Patrol') ? 'rows' : 'report', pinged(m)]), [['rows', true], ['report', again]], rows.join(' + '));
  }
});

test("the rows card's mention holds back the report's only when Slack took the card or still has it queued", async () => {
  const LOGIN = key('/v1/auth/login');
  const TRANSFER = key('/v1/ownership/transfer');
  for (const [rejection, again] of [[new SlackError('Slack: invalid_blocks', undefined, true), true], [new SlackError('Slack: HTTP 503'), false]] as const) {
    const sent: Posted[] = [];
    let down = true;
    const t: Transport = {
      threads: true,
      post: async (m) => {
        if (down && m.text.startsWith('Patrol')) throw rejection;
        sent.push(m);
        return `1700000000.${String(sent.length).padStart(6, '0')}`;
      },
    };
    const w = setup(t, () => ({ issue: 'new', severity: 'critical', rows: [LOGIN, TRANSFER] }), { oncall: ONCALL });
    w.rules.noise = new Noise({ never_suppress: [{ section: 'http', route: '/v1/auth/login', status: '4..' }] });
    await w.patrol(schedule({ '/v1/auth/login': between(0, 40), '/v1/ownership/transfer': between(0, 40) }), 0);
    down = false;
    await w.box.flush(); // the next patrol's send
    const posted = sent.map((m) => [m.text.startsWith('Patrol') ? 'rows' : 'report', pinged(m)]);
    if (rejection.permanent) {
      assert.deepEqual(w.box.status(), [{ status: 'failed', n: 1 }, { status: 'sent', n: 1 }]);
      assert.deepEqual(posted, [['report', true]], 'the rows card never reached Slack: the report pages');
    } else assert.deepEqual(posted, [['rows', true], ['report', false]], 'the queued rows card pages when it goes out');
  }
});

test('without an issue record a new critical report still mentions the on-call; a major does not', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40), '/v1/ownership/transfer': between(1, 40) });
  const t = recorder(true);
  let n = 0;
  const w = setup(t, () => ({ issue: 'new', severity: ++n === 1 ? 'critical' : 'major' }), { issues: false, oncall: ONCALL });
  await w.patrol(tel, 0);
  await w.patrol(tel, 1);
  assert.deepEqual(t.sent.map((m) => [[...m.text][0], pinged(m)]), [['🔴', true], ['🟠', false]]);
});

test('webhook: the mention goes out in the webhook body; a repeat still posts nothing', async (ctx) => {
  const real = globalThis.fetch;
  ctx.after(() => (globalThis.fetch = real));
  const bodies: Array<{ text: string; blocks: unknown[] }> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), new Response('ok'))) as typeof fetch;
  const tel = schedule({ '/v1/auth/login': between(0, 40), '/v1/ownership/transfer': between(1, 40) });
  const w = setup(webhookTransport('https://hooks.slack.test/x'), linker({ severity: 'critical' }), { oncall: '<!subteam^S0ONCALL1>' });
  await w.patrol(tel, 0);
  assert.equal((await w.patrol(tel, 1)).filed[0]?.action, 'linked');
  assert.equal(bodies.length, 1, 'the repeat is not posted');
  assert.equal(bodies[0]!.text, '🔴 Critical: Sign-in rejects emails with a trailing space · cc <!subteam^S0ONCALL1>');
  assert.match(JSON.stringify(bodies[0]!.blocks), /"type":"mrkdwn","text":"New issue I-[0-9a-f]{4} · \*active\* since 08:00Z · confidence medium · cc <!subteam\^S0ONCALL1>"/);
});

test("model text can't mention anyone: the on-call mention is code's, and without SLACK_ONCALL nothing pings", async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40) });
  const evil = { issue: 'new', severity: 'critical', title: 'Sign-in down <!channel> <@U0EVIL1> <!subteam^S0EVIL1>', what_broke: `ping ${ONCALL} and <!here>, see <https://evil.test|grafana>`, suggested_fix: 'call <!everyone>' } as const;
  for (const oncall of [ONCALL, undefined]) {
    const t = recorder(true);
    const w = setup(t, () => evil, { oncall });
    await w.patrol(tel, 0);
    assert.equal(t.sent.length, 1);
    const slack = parsed(t.sent[0]!);
    assert.equal(slack.split(ONCALL).length - 1, oncall ? 2 : 0, 'once in the text and once on the card, never from the model');
    // Remove what code added; nothing Slack would parse may be left.
    const rest = oncall ? slack.replaceAll(` · cc ${oncall}`, '') : slack;
    assert.ok(!rest.includes('<'), rest);
    assert.match(rest, /&lt;!channel&gt; &lt;@U0EVIL1&gt; &lt;!subteam\^S0EVIL1&gt;/);
    assert.match(rest, /ping &lt;@U0ONCALL1&gt;/);
  }
});

// ---- the record and its migration ------------------------------------------------

test('issues: short stable ids, append-only events, the listing is capped and drops old resolved ones', () => {
  const issues = Issues.memory();
  const filed = (title: string) => ({ title, severity: 'major' as const, rows: [`k-${title}`], hypothesis: 'h' });
  for (let i = 0; i < 25; i++) issues.open(filed(`problem ${i}`), new Date(T0 + i * 60_000));
  const listed = issues.listed(new Date(T0 + H));
  assert.equal(listed.issues.length, 20);
  assert.equal(listed.more, 5);
  assert.equal(listed.issues[0]!.title, 'problem 24', 'most recently reported first');
  const ids = new Set(issues.openIssues().map((i) => i.id));
  assert.equal(ids.size, 25);
  for (const id of ids) assert.match(id, /^I-[0-9a-f]{4,6}$/);
  const old = listed.issues[0]!.id;
  issues.resolve(old, new Date(T0 + H));
  assert.equal(issues.listed(new Date(T0 + 24.5 * H)).issues.some((i) => i.id === old), true, 'resolved less than 24 h ago: still listed');
  assert.equal(issues.listed(new Date(T0 + 25.5 * H)).issues.some((i) => i.id === old), false, 'resolved a day ago: gone');
  assert.equal(issues.holding(['k-problem 3'])?.title, 'problem 3');
  assert.equal(issues.holding(['k-problem 3', 'k-problem 4']), undefined, 'rows of two issues: none holds them all');
  const db = (issues as unknown as { db: DatabaseSync }).db;
  assert.throws(() => db.exec(`UPDATE issue_events SET type = 'x'`), /append-only/);
  assert.throws(() => db.exec(`DELETE FROM issue_events`), /append-only/);
  assert.match(monitorTask(['k'], { issues: [], more: 0 }), /none open or resolved in the last 24 h, so every report is "issue": "new"/);
});

test('a fresh engine.db and one from before issues both migrate, and a queued post still goes out', async () => {
  const fresh = join(mkdtempSync(join(tmpdir(), 'engine-fresh-')), 'engine.db');
  new Store(fresh);
  new SlackOutbox(fresh, bot());
  new Issues(fresh);
  const tables = (f: string) => (new DatabaseSync(f).prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);
  const want = ['issue_events', 'issue_rows', 'issues', 'runs', 'slack_issue_threads', 'slack_outbox', 'slack_sender', 'slack_threads'];
  assert.deepEqual(tables(fresh).filter((n) => n !== 'sqlite_sequence'), want);

  // The schema as shipped before this change, with a post still queued.
  const old = join(mkdtempSync(join(tmpdir(), 'engine-old-')), 'engine.db');
  new Store(old);
  const db = new DatabaseSync(old);
  db.exec(`
    CREATE TABLE slack_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, kind TEXT NOT NULL,
      keys TEXT NOT NULL, broadcast INTEGER NOT NULL, message TEXT NOT NULL, file TEXT,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      sent_at TEXT, ts TEXT, thread_ts TEXT
    );
    CREATE INDEX slack_outbox_pending ON slack_outbox (status) WHERE status = 'pending';
    CREATE TABLE slack_threads (key TEXT PRIMARY KEY, ts TEXT NOT NULL, opened_at TEXT NOT NULL, last_at TEXT NOT NULL);
    CREATE TABLE slack_sender (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, expires_at TEXT NOT NULL, last_attempt_at INTEGER);
  `);
  db.prepare(`INSERT INTO slack_outbox (created_at, kind, keys, broadcast, message, status) VALUES (?, 'rows', '["k"]', 1, ?, 'pending')`).run(new Date().toISOString(), JSON.stringify({ text: 'queued before the upgrade', blocks: [] }));
  db.close();
  const t = bot();
  for (let i = 0; i < 2; i++) new SlackOutbox(old, t, { sleep: async () => {}, gapMs: 0 }); // twice: idempotent
  new Issues(old);
  new Issues(old);
  assert.deepEqual(tables(old).filter((n) => n !== 'sqlite_sequence'), want);
  const box = new SlackOutbox(old, t, { sleep: async () => {}, gapMs: 0 });
  assert.equal((await box.flush()).sent, 1);
  assert.deepEqual(t.sent.map((s) => s.text), ['queued before the upgrade']);
  box.enqueue({ kind: 'report', keys: ['k'], broadcast: false, issue: 'I-abcd', repeat: true, message: { text: 'repeat of an issue never posted: its first post', blocks: [] } });
  assert.equal((await box.flush()).sent, 1);
});

// ---- 11-02/03, simulated --------------------------------------------------------

// 21 h of one cause (an email with a trailing space fails validation) reaching
// different flows at different times, plus rows coming back "worse". The real
// shadow channel got 6 separate "Major" posts for it. Each patrol here hands
// the fake investigator only its own rows, like production.
const NOV2: Schedule = {
  '/v1/auth/login': (t) => (t >= T0 && t < T0 + 21 * H ? (t >= T0 + 9 * H ? 45 : 20) : 0), // worse at +9 h
  '/v1/ownership/transfer': (t) => (t >= T0 + 1.5 * H && t < T0 + 21 * H ? (t >= T0 + 17 * H ? 45 : 20) : 0), // worse at +17 h
  '/v1/auth/signup': between(4, 21, 20),
  '/v1/auth/password/reset': between(12, 21, 20),
  '/v1/account/email': between(14.5, 21, 20),
};
const SIM_HOURS = Array.from({ length: 21 * 4 }, (_, i) => i / 4);

test('11-02/03 simulated: seven reports on one cause give one message and six quiet replies', async () => {
  const run = async (issues: boolean) => {
    const t = bot();
    const w = setup(t, linker(), { issues });
    for (const h of SIM_HOURS) await w.patrol(schedule(NOV2), h);
    return { t, w };
  };
  const before = await run(false);
  const after = await run(true);
  assert.equal(before.w.session.seen.length, 7, 'seven AI runs either way: this does not change what triggers a run');
  assert.equal(after.w.session.seen.length, 7);
  const visible = (s: Sent[]) => s.filter((x) => !x.thread_ts || x.reply_broadcast).length;
  assert.equal(visible(before.t.sent), 7, 'before: every report showed in the channel');
  assert.deepEqual(after.t.sent.map((s) => [s.thread_ts ?? 'root', s.reply_broadcast]), [['root', undefined], ...Array(6).fill(['1700000000.000001', false])]);
  assert.equal(after.w.issues!.openIssues().length, 1);
  assert.equal(after.w.issues!.openIssues()[0]!.rows.length, 5);
});
