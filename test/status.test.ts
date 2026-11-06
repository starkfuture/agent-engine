import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Config } from '../src/config.js';
import type { Engine } from '../src/engine/run.js';
import type { Session } from '../src/engine/session.js';
import { Store } from '../src/engine/store.js';
import { buildServer, type McpContext } from '../src/mcp/server.js';
import { sourceState, statusText } from '../src/mcp/status.js';
import { Users, type User } from '../src/mcp/users.js';
import { Issues } from '../src/patrol/issues.js';
import type { StateData } from '../src/patrol/state.js';
import { fakeSession } from './fake-session.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const NOW = new Date('2026-11-06T14:32:00Z');
const MIN = 60_000;
const ago = (min: number) => new Date(NOW.getTime() - min * MIN);
const ECR = '952414816681.dkr.ecr.eu-west-1.amazonaws.com';

function agentsDir(): string {
  const root = tmp('agents-');
  const add = (name: string, yaml: string) => {
    mkdirSync(join(root, name, 'memory'), { recursive: true });
    writeFileSync(join(root, name, 'agent.yaml'), `name: ${name}\ndescription: ${name} agent\n${yaml}`);
    writeFileSync(join(root, name, 'CLAUDE.md'), `# ${name}\nYou answer questions.`);
  };
  add('codebase', 'concurrency: 3\nbuiltin_tools: [Read]\nlimits: { usd_per_run: 1, usd_per_day: 10 }');
  add('monitor', 'code: monitor\nsensitive_tools: true\nvisibility: everyone\nlimits: { usd_per_run: 2.5, usd_per_day: 25 }');
  add('prod', 'sensitive_tools: true\ntool_pack: telemetry\nlimits: { usd_per_run: 1, usd_per_day: 10 }');
  return root;
}

function gitRepo(): string {
  const root = tmp('repo-');
  writeFileSync(join(root, 'a.ts'), 'export const mode = "WAL";');
  execFileSync('git', ['init', '-q', '--template=', root]);
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t.test', 'commit', '-q', '--no-verify', '-m', 'c']);
  return root;
}

// mcp.test.ts's context(), with what the status tool reads: the patrol's
// state file and out dir, its window, the issue record and a fixed engine clock.
function context(session: Session, over: { agents?: string[] } = {}) {
  const runsDir = tmp('runs-');
  const engine: Engine = { store: new Store(join(runsDir, 'engine.db')), runsDir, stopFile: join(runsDir, 'STOP'), session, dailyCapUsd: 40, monthlyCapUsd: 500, agentMonthlyCapUsd: { monitor: 400 }, llmAvailable: true, now: () => NOW };
  const users = Users.load(join(tmp('users-'), 'users.json'));
  users.add('ana', { slackId: 'U0ANA12345' });
  users.add('root', { admin: true });
  const cfg = {
    agentsDir: agentsDir(),
    runsDir,
    memoryDir: undefined,
    windowMinutes: 15,
    stateFile: join(tmp('state-'), 'state.json'),
    outDir: tmp('out-'),
    mcp: { usersFile: users.file, reposFile: '', userDailyCapUsd: 10, userMaxRunning: 2, notifySlack: false, agents: over.agents },
  } as unknown as Config;
  const issuesFile = join(tmp('issues-'), 'engine.db');
  const ctx: McpContext = { cfg, engine, users, repos: new Map([['app', { path: gitRepo() }]]), issues: new Issues(issuesFile) };
  const who = (name: string) => users.list().find((u) => u.name === name)!;
  return { ctx, who, issuesFile };
}

async function connect(ctx: McpContext, user: User) {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await buildServer(ctx, user).connect(s);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(c);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content.map((x) => x.text).join(''), isError: Boolean(r.isError) };
  };
  return { client, call };
}

// Spend in the ledger: the monitor's patrol runs today, one person's run.
// `at` places each run, minutes before now.
function spendToday(st: Store, at: (minAgo: number) => Date = ago) {
  const run = (id: string, agent: string, cost: number, when: Date, user?: string) => {
    st.admit({ id, agent, version: 'v', trigger: user ? 'mcp' : 'patrol', now: when, deadlineMs: 60_000, reserve: 1, agentCap: 1000, globalCap: 1000, ...(user ? { user } : {}) });
    st.settle(id, { status: 'ok', cost, turns: 14, outputs: 1, now: when });
  };
  run('20261106T063200Z-monitor-aaaaaa', 'monitor', 22.5, at(480));
  run('20261106T104700Z-monitor-bbbbbb', 'monitor', 1.62, at(225));
  run('20261106T120200Z-prod-cccccc', 'prod', 0.35, at(150), 'ana');
}

const patrolName = (at: Date) => `${at.toISOString().replace(/[:.]/g, '').slice(0, 15)}Z.json`;
function writePatrol(ctx: McpContext, at: Date, body: unknown) {
  const dir = join(ctx.cfg.outDir, 'patrols');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, patrolName(at)), typeof body === 'string' ? body : JSON.stringify(body));
}
const writeState = (ctx: McpContext, s: StateData) => writeFileSync(ctx.cfg.stateFile, JSON.stringify(s));

const row = (key: string) => ({ key });
const deploy = (workload: string, minAgo: number, from: string, to: string, minutes: number) => ({
  namespace: 'microservices',
  workload,
  replicaset: `${workload}-7566f689c8`,
  at: ago(minAgo).toISOString(),
  image: `${ECR}/${to}`,
  previous: `${ECR}/${from}`,
  state: 'complete',
  minutes,
});

// The last patrol (2 min ago), as runner.ts writes it.
function patrol(at = ago(2)) {
  return {
    at: at.toISOString(),
    windowMinutes: 15,
    send: [row('http|backend-production|/v1/auth/password/reset|400')],
    known: [row('http|backend-production|/v1/auth/signup|400'), row('workload|microservices|ecom-service-production|restarts')],
    waiting: [],
    suppressed: [row('logs|keycloak|<tpl>|'), row('http|backend-production|/v1/products|404'), row('traces|backend|GET /health|')],
    recovered: ['http|backend-production|/v1/cart|500'],
    deploys: {
      at: at.toISOString(),
      hours: 6,
      deploys: [deploy('keycloak-production', 120, 'keycloak:40306405609', 'keycloak:40306405610', 7), deploy('ecom-service-production', 47, 'ecom-service:1.2645.5', 'ecom-service:1.2645.6', 4)],
      statefulsets: [],
      notes: [],
    },
    sources: [
      { source: 'http:legacy-v1', ok: true },
      { source: 'counter:outbox', ok: true },
      { source: 'workloads', ok: true },
      { source: 'rollouts', ok: true },
      { source: 'logs', ok: false, error: 'Loki 502 Bad Gateway (on call: ops.lead@example.com)' },
      { source: 'traces', ok: false, error: 'not configured (TEMPO_DATASOURCE_UID)' },
    ],
  };
}

// Everything the status tool reads, as a real afternoon leaves it: two open
// issues (one with On it), one resolved, a daily-cap hold, a blind source and
// one that is off, two deploys, spend, and the monitor's last runs.
function afternoon(ctx: McpContext, issuesFile: string) {
  const issues = ctx.issues!;
  const reset = issues.open(
    { title: 'Password reset returns 400 for most requests', severity: 'major', rows: ['http|backend-production|/v1/auth/password/reset|400', 'http|backend-production|/v1/auth/signup|400'], hypothesis: 'auth-service 2.14 rejects the new reset token format since the 12:05Z deploy', run: '20261106T121500Z-monitor-111111' },
    ago(140),
  );
  issues.click(reset.id, 'acknowledged', 'U0ANA12345', ago(100));
  const restarts = issues.open({ title: 'ecom-service restarts after OOMKilled', severity: 'minor', rows: ['workload|microservices|ecom-service-production|restarts'], hypothesis: 'memory limit 512Mi is below the new cache size', run: '20261106T134500Z-monitor-222222' }, ago(47));
  // Stored redacted already; written raw here to prove status redacts on its own.
  new DatabaseSync(issuesFile).prepare('UPDATE issues SET title = ? WHERE id = ?').run('ecom-service restarts after OOMKilled (reported by jane.doe@example.com)', restarts.id);
  const cart = issues.open({ title: 'Cart returns 500 after the Redis failover', severity: 'minor', rows: ['http|backend-production|/v1/cart|500'], hypothesis: 'Redis failover', run: '20261106T080000Z-monitor-333333' }, ago(400));
  issues.resolve(cart.id, ago(300));

  writeState(ctx, {
    rows: {
      'errors|outbox|quarantined|': { firstSeen: ago(200).toISOString(), lastSeen: ago(2).toISOString(), investigation: { status: 'gave_up', attempts: 2, outcome: 'ok' } },
      'http|old|/v0|500': { firstSeen: ago(5000).toISOString(), lastSeen: ago(4000).toISOString(), investigation: { status: 'gave_up', attempts: 2 } },
    },
    held: { reason: 'agent daily cap $25 reached', since: ago(90).toISOString(), runId: '20261106T130200Z-monitor-dddddd' },
    notices: { channel: { blind: { logs: ago(152).toISOString() } } },
  });
  writePatrol(ctx, ago(17), { ...patrol(ago(17)), send: [] });
  writePatrol(ctx, ago(2), patrol());

  spendToday(ctx.engine.store);
  ctx.engine.store.skipped({ id: '20261106T130200Z-monitor-dddddd', agent: 'monitor', version: 'v', trigger: 'patrol', now: ago(90), note: 'agent daily cap $25 reached' });
  return { reset, restarts, cart };
}

test('status: members and admins see the patrol, the pause, the last run, open issues, sources, deploys and spend; noise counts are for admins', async () => {
  const session = fakeSession();
  const { ctx, who, issuesFile } = context(session);
  const { reset, restarts, cart } = afternoon(ctx, issuesFile);
  const runsBefore = ctx.engine.store.recent(100).length;

  const ana = await connect(ctx, who('ana'));
  const tool = (await ana.client.listTools()).tools.find((t) => t.name === 'status');
  assert.equal(tool?.annotations?.readOnlyHint, true);
  const member = await ana.call('status');
  assert.equal(member.isError, false, member.text);
  const m = member.text;
  assert.match(m, /^Patrol running: last pass 14:30Z, 2 min ago \(every 15 min\)\.$/m);
  assert.match(m, /^AI: paused since 13:02Z: the monitor's daily AI budget \(\$25\) is used up until 00:00 UTC\.$/m);
  assert.match(m, /^Last monitor run: 13:02Z skipped · \$0\.00 · agent daily cap \$25 reached · 20261106T130200Z-monitor-dddddd$/m);
  assert.match(m, /^Last one that ran: 10:47Z ok · \$1\.62 · 14 turns · 20261106T104700Z-monitor-bbbbbb$/m);
  assert.match(m, new RegExp(`^Open issues \\(2\\):\\n- ${restarts.id} · minor · .*\\n  likely cause: memory limit 512Mi.*\\n- ${reset.id} · major · Password reset returns 400 for most requests · 2 rows · last report 12:12Z · On it\\n  likely cause: auth-service 2\\.14`, 'm'));
  assert.match(m, new RegExp(`^Resolved in the last 24 h \\(1\\):\\n- ${cart.id} · minor · Cart returns 500 after the Redis failover · resolved 09:32Z$`, 'm'));
  assert.match(m, /^Last patrol found: 1 new or worse · 2 still firing, already reported · 0 waiting for a second patrol · 1 recovered$/m);
  assert.doesNotMatch(m, /noise/, 'members see no noise counts');
  assert.match(m, /^The AI gave up on 1 row seen in the last 24 h \(no report after 2 runs\):\n- errors\|outbox\|quarantined\|$/m);
  assert.match(m, /^Sources \(last patrol\):\n- blind: logs since 12:00Z: Loki 502 Bad Gateway \(on call: <email>\)\n- off: traces: not configured \(TEMPO_DATASOURCE_UID\)\n- ok: http:legacy-v1, counter:outbox, workloads, rollouts$/m);
  assert.match(m, /^Deploys in the last 6 h \(new ReplicaSets; scaling is not a deploy\), up to the last patrol:\n- 12:32Z microservices\/keycloak-production: 40306405609 → 40306405610 · complete in 7 min\n- 13:45Z microservices\/ecom-service-production: 1\.2645\.5 → 1\.2645\.6 · complete in 4 min$/m);
  assert.match(m, /^Spend:\ntoday: \$24\.47 of \$40 · this month: \$24\.47 of \$500\nmonitor \$24\.12 of \$400 this month \(the other \$100 of \$500 is kept for people\)\nyou today: \$0\.35 of \$10\nby agent today:\n/m);

  // Redacted on the way out: an email in an issue title and in a source error.
  assert.doesNotMatch(m, /@example\.com/);
  assert.match(m, /restarts after OOMKilled \(reported by <email>\)/);

  const admin = (await (await connect(ctx, who('root'))).call('status')).text;
  assert.match(admin, /^Last patrol found: .* · 1 recovered · 3 dropped as noise$/m);
  assert.equal(admin.replace(/ · 3 dropped as noise/, '').replace(/you today: \$0\.00/, 'you today: $0.35'), m, 'admins see the same, plus the noise count');

  assert.equal(session.requests.length, 0, 'no model call');
  assert.equal(ctx.engine.store.recent(100).length, runsBefore, 'no run recorded');
  assert.ok(m.length < 9000);
});

test('status costs nothing: no model call, no run in the ledger', async () => {
  const session = fakeSession();
  const { ctx, who } = context(session);
  writePatrol(ctx, ago(2), patrol());
  const { call } = await connect(ctx, who('ana'));
  const r = await call('status');
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Last monitor run: none yet$/m);
  assert.match(r.text, /^AI: on \(no cap or kill switch holds it\)\.$/m);
  assert.match(r.text, /^Open issues \(0\):\n- none$/m);
  assert.equal(session.requests.length, 0);
  assert.match((await call('list_runs')).text, /^no runs$/);
});

test('STALE when the newest patrol is older than two windows, or when there is none', async () => {
  const { ctx, who } = context(fakeSession());
  const status = async () => (await (await connect(ctx, who('ana'))).call('status')).text;

  const none = await status();
  assert.match(none, /^STALE: no patrol file here \(out\/patrols is empty\): the patrol may not be running\./);
  assert.match(none, /^Open issues \(0\):/m, 'the engine records still show');

  writePatrol(ctx, ago(31), patrol(ago(31)));
  const old = await status();
  assert.match(old, /^STALE: the last patrol ran at 14:01Z, 31 min ago \(it runs every 15 min\): the patrol may not be running\./);
  assert.match(old, /^Sources \(last patrol\):/m, 'what it last saw, said to be old');

  writePatrol(ctx, ago(29), patrol(ago(29)));
  assert.match(await status(), /^Patrol running: last pass 14:03Z, 29 min ago/);

  writeFileSync(ctx.engine.stopFile, '2026-11-06T14:00:00Z root: freeze\n');
  assert.match(await status(), /^AI: paused: the kill switch is on \(STOP\); an admin clears it with resume\.$/m);
});

test('a newest patrol file caught half written: the one before, and it says so', async () => {
  const { ctx, who } = context(fakeSession());
  writePatrol(ctx, ago(17), { ...patrol(ago(17)), send: [] });
  writePatrol(ctx, ago(2), '{"at":"2026-11-06T14:30:00.000Z","send":[{"key":');
  const r = (await (await connect(ctx, who('ana'))).call('status')).text;
  assert.match(r, /^Patrol running: last pass 14:30Z, 2 min ago/, 'the newest file still shows the patrol runs');
  assert.match(r, /^The newest patrol file \(2026-11-06T1430Z\.json\) could not be read, maybe still being written: what the patrol found, its sources and deploys come from 2026-11-06T1415Z\.json\.$/m);
  assert.match(r, /^Last patrol found: 0 new or worse/m);

  // Only the newest few files are read: with those three broken, an older good one is not.
  writePatrol(ctx, ago(1), '');
  writePatrol(ctx, ago(0), '{"at":');
  const s = (await (await connect(ctx, who('ana'))).call('status')).text;
  assert.match(s, /^No patrol file could be read: what the patrol found, its sources and deploys are missing\.$/m);
  assert.doesNotMatch(s, /^Last patrol found:/m);
});

test('missing or odd fields: every part says what it lacks, nothing throws', async () => {
  const { ctx, who } = context(fakeSession());
  writePatrol(ctx, ago(2), { at: ago(2).toISOString(), sources: [{ source: 'logs' }, { ok: true, note: 'capped at 20 traces' }], deploys: { deploys: [{ workload: 'x' }] } });
  writeState(ctx, { rows: { a: null }, held: { reason: 'agent daily cap $25 reached' } } as unknown as StateData);
  const r = (await (await connect(ctx, who('root'))).call('status')).text;
  assert.match(r, /^Last patrol found: \? new or worse · \? still firing, already reported · \? waiting for a second patrol · \? recovered · \? dropped as noise$/m);
  assert.match(r, /^- blind: logs\n- degraded: \?: capped at 20 traces$/m);
  assert.match(r, /^AI: could not be read \(/m);
  assert.match(r, /^Deploys: could not be read \(/m);
  assert.match(r, /^Spend:\ntoday: \$0\.00/m);

  writeFileSync(ctx.cfg.stateFile, '{ not json');
  writePatrol(ctx, ago(2), { at: ago(2).toISOString() });
  const s = (await (await connect(ctx, who('ana'))).call('status')).text;
  assert.match(s, /^Patrol state: could not be read \(/m);
  assert.match(s, /^AI: not known \(the patrol state could not be read\)\.$/m, 'an unread hold is not "on"');
  assert.match(s, /^Sources: not in the patrol file\.$/m);
  assert.match(s, /^Deploys: not in the patrol file\.$/m);
  writePatrol(ctx, ago(2), { at: ago(2).toISOString(), deploys: { hours: 6 } });
  assert.match((await (await connect(ctx, who('ana'))).call('status')).text, /^Deploys: not in the patrol file\.$/m, 'no list is not "none"');

  const odd = context(fakeSession());
  writeFileSync(join(odd.ctx.cfg.outDir, 'patrols'), 'a file where the folder should be');
  const u = (await (await connect(odd.ctx, odd.who('ana'))).call('status')).text;
  assert.match(u, /^STALE: whether the patrol runs is unknown\. Patrol files: could not be read \(/);
  assert.match(u, /^Open issues \(0\):/m);
});

test('source states, in the patrol order: off, blind, unknown, degraded, ok; its own state field wins', () => {
  assert.equal(sourceState({ source: 'traces', ok: false, error: 'not configured (TEMPO_DATASOURCE_UID)' }), 'off');
  assert.equal(sourceState({ source: 'logs', ok: false, error: 'loki: not configured' }), 'off');
  assert.equal(sourceState({ source: 'logs', ok: false, error: 'the job is not configured right' }), 'blind');
  assert.equal(sourceState({ source: 'logs', ok: false }), 'blind');
  // #35 marks a source switched off in config as disabled: off, never blind.
  assert.equal(sourceState({ source: 'argocd', ok: false, disabled: true } as Parameters<typeof sourceState>[0]), 'off');
  assert.equal(sourceState({ source: 'logs', ok: true, note: 'nothing read, presence check failed', unknown: true }), 'unknown');
  assert.equal(sourceState({ source: 'traces', ok: true, note: 'capped at 20 traces' }), 'degraded');
  assert.equal(sourceState({ source: 'workloads', ok: true }), 'ok');
  assert.equal(sourceState({ source: 'argocd', ok: true, state: 'off' }), 'off');
});

test('every open issue counts: issues resolved since never push an older open one out', () => {
  const { ctx, who } = context(fakeSession());
  const issues = ctx.issues!;
  const old = issues.open({ title: 'Checkout latency high since Monday', severity: 'major', rows: ['http|checkout|/v1/pay|p95'], hypothesis: 'h', run: 'r' }, ago(30 * 60));
  for (let k = 0; k < 11; k++) issues.resolve(issues.open({ title: `blip ${k}`, severity: 'minor', rows: [`http|x|/v1/${k}|500`], hypothesis: 'h', run: 'r' }, ago(600 - k)).id, ago(500 - k));
  // Resolved 30 h ago and kept by its Not an issue: not resolved in the last 24 h.
  const muted = issues.open({ title: 'Muted and resolved long ago', severity: 'minor', rows: ['http|y|/v1/y|500'], hypothesis: 'h', run: 'r' }, ago(40 * 60));
  issues.click(muted.id, 'dismissed', 'U0ANA12345', ago(35 * 60));
  issues.resolve(muted.id, ago(30 * 60));
  const t = statusText(ctx, who('ana'), NOW, []);
  assert.match(t, new RegExp(`^Open issues \\(1\\):\\n- ${old.id} · major · Checkout latency high since Monday · 1 row · last report 11-05 08:32Z$`, 'm'));
  assert.match(t, /^Resolved in the last 24 h \(11\):$/m);
  assert.match(t, /^- … 1 more$/m);
  assert.doesNotMatch(t, new RegExp(muted.id));
});

test('a long note is redacted before it is cut', () => {
  const { ctx, who } = context(fakeSession());
  ctx.engine.store.skipped({ id: '20261106T143000Z-monitor-eeeeee', agent: 'monitor', version: 'v', trigger: 'patrol', now: ago(2), note: `${'x'.repeat(140)} ask jane.doe@example.com` });
  const t = statusText(ctx, who('ana'), NOW, []);
  assert.match(t, /^Last monitor run: .* x+ ask <email> · 20261106T143000Z-monitor-eeeeee$/m);
  assert.doesNotMatch(t, /jane/);
});

test('long output is capped near a tool result', () => {
  const { ctx, who } = context(fakeSession());
  writePatrol(ctx, ago(2), { ...patrol(), sources: Array.from({ length: 300 }, (_, i) => ({ source: `http:family-${i}`, ok: false, error: 'x'.repeat(300) })) });
  const t = statusText(ctx, who('root'), NOW, []);
  assert.ok(t.length <= 9100, String(t.length));
  assert.match(t, /\[truncated \d+ chars\]$/);
});

test('no status tool where the monitor is not served (ENGINE_AGENTS)', async () => {
  const { ctx, who } = context(fakeSession(), { agents: ['codebase'] });
  const { client } = await connect(ctx, who('ana'));
  assert.ok(!(await client.listTools()).tools.some((t) => t.name === 'status'));
});

test('spend: the same lines as before the status tool shared them', async () => {
  const { ctx, who } = context(fakeSession());
  spendToday(ctx.engine.store, () => new Date()); // the spend tool reads the real day
  writeFileSync(ctx.engine.stopFile, 'x');
  const out = (await (await connect(ctx, who('ana'))).call('spend')).text;
  assert.equal(
    out,
    [
      'today: $24.47 of $40 · this month: $24.47 of $500',
      'monitor $24.12 of $400 this month (the other $100 of $500 is kept for people)',
      'you today: $0.35 of $10',
      'by agent today:',
      '  codebase  $0.00 of $10',
      '  monitor   $24.12 of $25',
      '  prod      $0.35 of $10',
      'STOP is set: new runs are skipped.',
    ].join('\n'),
  );
});
