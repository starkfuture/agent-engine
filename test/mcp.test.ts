import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Config } from '../src/config.js';
import type { Findings } from '../src/engine/output.js';
import type { Engine } from '../src/engine/run.js';
import type { Session } from '../src/engine/session.js';
import { Store } from '../src/engine/store.js';
import { Login } from '../src/mcp/login.js';
import { buildServer, EXPORT_PART, startHttp, type McpContext } from '../src/mcp/server.js';
import { Users, type User } from '../src/mcp/users.js';
import { fakeSession, fetchResponse, ok, readResponse, say, type Script } from './fake-session.js';
import { cluster, ECR, FakeTelemetry, MIN, testConfig, world } from './fake.js';
import { fakeKeycloak } from './fake-keycloak.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const lastId = (t: string) => [...t.matchAll(/evidence_id: (E-[0-9a-f]{4}-\d+)/g)].at(-1)?.[1] ?? 'none';
const answer = (id: string, quote: string, title = 'The answer to the question'): Findings => ({
  title,
  summary: 'Bottom line: it works as described.',
  findings: [{ claim: 'The thing is configured', status: 'confirmed', evidence: [{ id, quote }] }],
  next_steps: [],
  not_checked: [],
  lessons: [],
});

function agentsDir(): string {
  const root = tmp('agents-');
  const add = (name: string, yaml: string) => {
    mkdirSync(join(root, name, 'memory'), { recursive: true });
    writeFileSync(join(root, name, 'agent.yaml'), `name: ${name}\ndescription: ${name} agent\n${yaml}`);
    writeFileSync(join(root, name, 'CLAUDE.md'), `# ${name}\nYou answer questions.`);
  };
  add('research', 'concurrency: 3\nbuiltin_tools: [WebFetch]\nlimits: { usd_per_run: 1, usd_per_day: 10 }');
  add('codebase', 'concurrency: 3\nbuiltin_tools: [Read]\nlimits: { usd_per_run: 1, usd_per_day: 10 }');
  add('monitor', 'code: monitor\nsensitive_tools: true');
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

function context(session: Session, over: { userCap?: number; notify?: (t: string) => Promise<void>; memoryDir?: string; agents?: string[] } = {}) {
  const runsDir = tmp('runs-');
  const engine: Engine = { store: new Store(join(runsDir, 'engine.db')), runsDir, stopFile: join(runsDir, 'STOP'), session, dailyCapUsd: 20, monthlyCapUsd: 100, llmAvailable: true };
  const users = Users.load(join(tmp('users-'), 'users.json'));
  const tokens = { ana: users.add('ana', { slackId: 'U0ANA12345' }), bo: users.add('bo'), root: users.add('root', { admin: true }) };
  const cfg = { agentsDir: agentsDir(), runsDir, memoryDir: over.memoryDir, mcp: { usersFile: users.file, reposFile: '', userDailyCapUsd: over.userCap ?? 10, userMaxRunning: 2, notifySlack: false, agents: over.agents } } as unknown as Config;
  const ctx: McpContext = { cfg, engine, users, repos: new Map([['app', { path: gitRepo() }]]), ...(over.notify ? { notify: over.notify } : {}) };
  const who = (name: string) => users.list().find((u) => u.name === name)!;
  return { ctx, tokens, who };
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

const researchOk: Script = async function* (sim) {
  const page = await sim.builtin('WebFetch', { url: 'https://x.test' }, fetchResponse('https://x.test', 'Feature X is configured in eu-west-1.'));
  yield say();
  await sim.mcp('submit_findings', answer(lastId(page), 'configured in eu-west-1'));
  yield ok(0.2);
};

test('a developer gives a task, reads the answer, the evidence behind it, and their spend', async () => {
  const { ctx, who } = context(fakeSession(researchOk));
  const { call } = await connect(ctx, who('ana'));
  const agents = (await call('list_agents')).text;
  assert.match(agents, /^research @[0-9a-f]+$/m);
  assert.match(agents, /^monitor @[0-9a-f]+ \(scheduled; not runnable here\)$/m);
  const r = await call('run_agent', { agent: 'research', task: 'Where is feature X configured?', wait_seconds: 10 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /: ok/);
  assert.match(r.text, /The answer to the question/);
  const runId = /run (\S+): ok/.exec(r.text)![1]!;
  const got = await call('get_run', { run_id: runId });
  assert.match(got.text, /asked by ana/);
  const evid = /(E-[0-9a-f]{4}-\d+)/.exec(got.text)![1]!;
  assert.match((await call('get_evidence', { run_id: runId, evidence_id: evid })).text, /Feature X is configured/);
  assert.match((await call('list_runs', { mine: true })).text, new RegExp(runId));
  assert.match((await call('spend')).text, /you today: \$0\.20 of \$10/);
  assert.equal(ctx.engine.store.get(runId)!.requested_by, 'ana');
});

test('only admins manage users; invites never mint a token and stay on the company domain', async () => {
  const { ctx, who } = context(fakeSession());
  (ctx.cfg.mcp as { login?: unknown }).login = { domain: 'starkfuture.com', publicUrl: 'https://agent-engine.test', admins: [] };
  const names = async (u: string) => (await (await connect(ctx, who(u))).client.listTools()).tools.map((t) => t.name);
  for (const t of ['invite_user', 'remove_user', 'list_users']) {
    assert.ok(!(await names('ana')).includes(t), `member must not see ${t}`);
    assert.ok((await names('root')).includes(t), `admin sees ${t}`);
  }
  const { call } = await connect(ctx, who('root'));
  assert.match((await call('invite_user', { email: 'Cy@starkfuture.com' })).text, /cy@starkfuture\.com can sign in as member \(user cy\)/);
  assert.equal(ctx.users.list().find((u) => u.name === 'cy')?.token_sha256, undefined);
  assert.match((await call('invite_user', { email: 'eve@gmail.com' })).text, /error: only @starkfuture\.com/);
  assert.match((await call('list_users')).text, /^cy +member keycloak +cy@starkfuture\.com$/m);
  assert.match((await call('remove_user', { name: 'root' })).text, /cannot remove yourself/);
  assert.match((await call('remove_user', { name: 'Cy@StarkFuture.com' })).text, /cy removed/, 'by email too');
  assert.match((await call('remove_user', { name: 'cy' })).text, /error: no user cy/);

  // Removed (or demoted) after its request was authenticated: no admin action completes.
  ctx.users.setRole('root', 'member');
  assert.match((await call('invite_user', { email: 'root2@starkfuture.com', admin: true })).text, /no longer an admin/);
  assert.match((await call('stop_all', { reason: 'testing' })).text, /no longer an admin/);
  assert.equal(ctx.users.list().some((u) => u.email === 'root2@starkfuture.com'), false);
});

test('only admins get the kill switch and lesson approval', async () => {
  const { ctx, who } = context(fakeSession());
  const names = async (u: string) => (await (await connect(ctx, who(u))).client.listTools()).tools.map((t) => t.name);
  const member = await names('ana');
  for (const t of ['stop_all', 'resume', 'approve_lesson']) assert.ok(!member.includes(t), t);
  const admin = await names('root');
  for (const t of ['stop_all', 'resume', 'approve_lesson']) assert.ok(admin.includes(t), t);
  const { call } = await connect(ctx, who('root'));
  await call('stop_all', { reason: 'testing' });
  assert.ok(existsSync(ctx.engine.stopFile));
  const skipped = await (await connect(ctx, who('ana'))).call('run_agent', { agent: 'research', task: 'Anything at all, please.' });
  assert.match(skipped.text, /skipped[\s\S]*kill switch is on \(set \S+ root: testing\); an admin clears it with resume/);
  assert.ok(!skipped.text.includes(ctx.engine.stopFile), 'never the server path');
  await call('approve_lesson', { agent: 'research', lesson: 'Prefer the official docs over blog posts.' });
  assert.match(readFileSync(join(ctx.cfg.agentsDir, 'research', 'memory', 'lessons.md'), 'utf8'), /official docs.*approved by root/);
});

test('a private agent’s runs are readable by the requester and admins only', async () => {
  const s = fakeSession(researchOk);
  const { ctx, who } = context(s);
  const ana = await connect(ctx, who('ana'));
  const r = await ana.call('run_agent', { agent: 'research', task: 'Where is feature X configured?', wait_seconds: 10 });
  const runId = /run (\S+): ok/.exec(r.text)![1]!;
  const evid = /(E-[0-9a-f]{4}-\d+)/.exec((await ana.call('get_run', { run_id: runId })).text)![1]!;

  const bo = await connect(ctx, who('bo'));
  assert.match((await bo.call('get_run', { run_id: runId })).text, /error: no run/, 'looks like a missing run');
  assert.match((await bo.call('get_evidence', { run_id: runId, evidence_id: evid })).text, /error: no run/);
  assert.ok(!(await bo.call('list_runs')).text.includes(runId));
  assert.match((await bo.call('proposed_lessons', { agent: 'research' })).text, /admins only/);
  const root = await connect(ctx, who('root'));
  assert.match((await root.call('get_run', { run_id: runId })).text, /asked by ana/);
  assert.ok((await root.call('list_runs')).text.includes(runId));

  // Shared agents: any user reads them.
  appendFileSync(join(ctx.cfg.agentsDir, 'research', 'agent.yaml'), '\nvisibility: everyone\n');
  assert.match((await bo.call('get_run', { run_id: runId })).text, /asked by ana/);
  assert.ok((await bo.call('list_runs')).text.includes(runId));
});

test('the prod agent answers from production telemetry over MCP; other agents never get those tools', async () => {
  const prodOk: Script = async function* (sim) {
    const r = await sim.mcp('promql', { query: 'sum(rate(backend_be_production_http_requests_total[5m]))' });
    yield say();
    await sim.mcp('submit_findings', answer(lastId(r.text), '/v1/auth/signup', 'Sign-in errors are back to normal'));
    yield ok(0.1);
  };
  const session = fakeSession(prodOk, researchOk);
  const { ctx, who } = context(session);
  const { call } = await connect(ctx, who('ana'));
  assert.match((await call('run_agent', { agent: 'prod', task: 'Is sign-in failing right now?' })).text, /needs production telemetry/, 'no telemetry configured: refused');

  ctx.telemetry = new FakeTelemetry(world);
  assert.match((await call('list_agents')).text, /tools telemetry pack/);
  const r = await call('run_agent', { agent: 'prod', task: 'Is sign-in failing right now?', wait_seconds: 10 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /: ok/);
  assert.match(r.text, /Sign-in errors are back to normal/);
  const prodTools = session.requests[0]!.tools.map((t) => t.name);
  for (const t of ['service_overview', 'route_timeline', 'log_search', 'promql', 'trace_search']) assert.ok(prodTools.includes(t), t);

  await call('run_agent', { agent: 'research', task: 'Where is feature X configured?', wait_seconds: 10 });
  const researchTools = session.requests[1]!.tools.map((t) => t.name);
  assert.ok(!researchTools.includes('promql') && !researchTools.includes('log_search'), 'a web agent never gets production tools');

  // Answers built from prod data stay with the asker.
  const runId = /run (\S+): ok/.exec(r.text)![1]!;
  assert.match((await (await connect(ctx, who('bo'))).call('get_run', { run_id: runId })).text, /no run/);
});

test('deploys over MCP: code only and read-only, one service by the name the patrol uses, no run and no cost', async () => {
  const session = fakeSession();
  const { ctx, who } = context(session);
  const { client, call } = await connect(ctx, who('bo'));
  assert.ok(!(await client.listTools()).tools.some((t) => t.name === 'deploys'), 'no telemetry: no tool');

  ctx.cfg.sources = testConfig().sources; // aliases: keycloak → keycloak-production
  const now = Math.floor(Date.now() / MIN) * MIN; // whole minutes: rollout times are read at a 1-min step
  ctx.telemetry = cluster([
    { workload: 'keycloak-production', rs: 'keycloak-production-6c9f7b8d54', created: now - 40 * MIN, done: now - 33 * MIN, image: `${ECR}/keycloak:40306405610@sha256:d40dc2f1`, prevRs: 'keycloak-production-58f6d9c7b2', prev: `${ECR}/keycloak:40306405609@sha256:c80fc98a` },
    { workload: 'ecom-service-production', rs: 'ecom-service-production-7566f689c8', created: now - 20 * MIN, done: now - 16 * MIN, image: `${ECR}/ecom-service:1.2645.6`, prevRs: 'ecom-service-production-5d4b9c7f88', prev: `${ECR}/ecom-service:1.2645.5` },
  ]);
  const { client: c2, call: call2 } = await connect(ctx, who('bo'));
  const tool = (await c2.listTools()).tools.find((t) => t.name === 'deploys');
  assert.equal(tool?.annotations?.readOnlyHint, true);
  const all = await call2('deploys', {});
  assert.equal(all.isError, false, all.text);
  assert.match(all.text, /^Deploys in the last 6 h \(new ReplicaSets; scaling is not a deploy\):\n- .*keycloak-production: 40306405609 → 40306405610 · complete in 7 min\n- .*ecom-service-production: 1\.2645\.5 → 1\.2645\.6 · complete in 4 min$/);
  const one = await call2('deploys', { service: 'keycloak', hours: 2 });
  assert.match(one.text, /^Deploys in the last 2 h \(new ReplicaSets; scaling is not a deploy\) for keycloak:\n- .*keycloak-production: 40306405609 → 40306405610/);
  assert.doesNotMatch(one.text, /ecom-service/);
  assert.equal(session.requests.length, 0, 'no model call');
  assert.match((await call('list_runs')).text, /^no runs$/, 'nothing recorded, nothing spent');

  ctx.telemetry = new FakeTelemetry(() => []); // kube-state-metrics gone
  const gone = await (await connect(ctx, who('bo'))).call('deploys', {});
  assert.match(gone.text, /\n- unknown: deployment metrics missing \(no kube_replicaset_created series\)$/);
});

test('a deployment offers only its ENGINE_AGENTS (web agents run apart from prod data)', async () => {
  const { ctx, who } = context(fakeSession(), { agents: ['codebase', 'monitor'] });
  const { call } = await connect(ctx, who('ana'));
  const list = (await call('list_agents')).text;
  assert.match(list, /^codebase @/m);
  assert.doesNotMatch(list, /research/);
  assert.match((await call('run_agent', { agent: 'research', task: 'Where is feature X configured?' })).text, /error: no agent "research"/);
});

test('with a memory dir, approved lessons live there (a persistent volume), not in the image', async () => {
  const memoryDir = tmp('memory-');
  const { ctx, who } = context(fakeSession(), { memoryDir });
  const root = await connect(ctx, who('root'));
  const before = (await root.call('list_agents')).text;
  await root.call('approve_lesson', { agent: 'research', lesson: 'Prefer the official docs over blog posts.' });
  assert.match(readFileSync(join(memoryDir, 'research', 'lessons.md'), 'utf8'), /official docs/);
  assert.ok(!existsSync(join(ctx.cfg.agentsDir, 'research', 'memory', 'lessons.md')), 'agent folder untouched');
  assert.notEqual((await root.call('list_agents')).text, before, 'the lesson changes the agent version');
});

test('the codebase agent reads only named repos, never a caller path; scheduled agents are not runnable', async () => {
  const s = fakeSession(async function* (sim) {
    const f = await sim.builtin('Read', { file_path: join(sim.req.cwd, 'a.ts') }, readResponse('a.ts', 'export const mode = "WAL";'));
    await sim.mcp('submit_findings', answer(lastId(f), 'mode = "WAL"'));
    yield ok();
  });
  const { ctx, who } = context(s);
  const { call } = await connect(ctx, who('ana'));
  assert.match((await call('run_agent', { agent: 'codebase', task: 'What journal mode is used?' })).text, /needs repo: one of app/);
  assert.match((await call('run_agent', { agent: 'codebase', task: 'What journal mode is used?', repo: '/etc' })).text, /needs repo/);
  assert.match((await call('run_agent', { agent: 'research', task: 'What journal mode is used?', repo: 'app' })).text, /doesn't read code/);
  assert.match((await call('run_agent', { agent: 'monitor', task: 'Patrol now, please.' })).text, /runs on its schedule/);
  const r = await call('run_agent', { agent: 'codebase', task: 'What journal mode is used?', repo: 'app', wait_seconds: 10 });
  assert.match(r.text, /: ok/, r.text);
});

test('runs start in the background; only the owner or an admin can cancel', async () => {
  const s = fakeSession(async function* (sim) {
    yield say('thinking');
    await sim.sleep(30_000);
    yield ok();
  });
  const { ctx, who } = context(s);
  const ana = await connect(ctx, who('ana'));
  const started = await ana.call('run_agent', { agent: 'research', task: 'A long question that takes a while.' });
  const runId = /run (\S+): running/.exec(started.text)![1]!;
  assert.match((await ana.call('get_run', { run_id: runId })).text, /running/);
  assert.match((await (await connect(ctx, who('bo'))).call('cancel_run', { run_id: runId })).text, /only cancel your own/);
  const c = await ana.call('cancel_run', { run_id: runId });
  assert.match(c.text, /stopped/, c.text);
  assert.equal(ctx.engine.store.get(runId)!.status, 'stopped');
});

test('stop_all stops runs in progress at once', async () => {
  const slow: Script = async function* (sim) {
    yield say();
    await sim.sleep(30_000);
    yield ok();
  };
  const { ctx, who } = context(fakeSession(slow));
  const started = await (await connect(ctx, who('ana'))).call('run_agent', { agent: 'research', task: 'A long question that takes a while.' });
  const runId = /run (\S+): running/.exec(started.text)![1]!;
  const t0 = Date.now();
  assert.match((await (await connect(ctx, who('root'))).call('stop_all', { reason: 'incident' })).text, /1 run\(s\) in this server told to stop/);
  while (ctx.engine.store.get(runId)!.status === 'running' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
  assert.equal(ctx.engine.store.get(runId)!.status, 'stopped');
});

test('per-person caps: daily spend and runs at once', async () => {
  const slow: Script = async function* (sim) {
    await sim.sleep(30_000);
    yield ok();
  };
  const { ctx, who } = context(fakeSession(slow, slow, slow), { userCap: 2.5 });
  const ana = await connect(ctx, who('ana'));
  const t = { agent: 'research', task: 'Question number one, please.' };
  const a = await ana.call('run_agent', t);
  const b = await ana.call('run_agent', t);
  assert.match(a.text + b.text, /running[\s\S]*running/);
  assert.match((await ana.call('run_agent', t)).text, /your daily cap \$2\.5 reached|you already have 2/);
  const bo = await connect(ctx, who('bo'));
  const c = await bo.call('run_agent', t);
  assert.match(c.text, /running/, 'other people are not blocked');
  const root = await connect(ctx, who('root'));
  for (const x of [a, b, c]) await root.call('cancel_run', { run_id: /run (\S+): running/.exec(x.text)![1]! });
  assert.equal(ctx.engine.store.recent(10).filter((r) => r.status === 'running').length, 0);
});

test("spend shows the monitor's monthly share and what it keeps for people, who still get runs once the monitor is at it", async () => {
  const { ctx, who } = context(fakeSession(researchOk));
  ctx.engine.agentMonthlyCapUsd = { monitor: 80 }; // of the $100 monthly cap
  ctx.engine.dailyCapUsd = 1000; // the monitor's spend lands today; only the month matters here
  const st = ctx.engine.store;
  st.admit({ id: 'patrols', agent: 'monitor', version: 'v', trigger: 'patrol', now: new Date(), deadlineMs: 60_000, reserve: 80, agentCap: 100, globalCap: 100 });
  st.settle('patrols', { status: 'ok', cost: 79.5, turns: 1, outputs: 1, now: new Date() });
  const ana = await connect(ctx, who('ana'));
  assert.match((await ana.call('spend')).text, /^monitor \$79\.50 of \$80 this month \(the other \$20 of \$100 is kept for people\)$/m);
  const r = await ana.call('run_agent', { agent: 'research', task: 'Where is feature X configured?', wait_seconds: 10 });
  assert.match(r.text, /: ok/, r.text);
  // A deployment that doesn't run the monitor doesn't show its share.
  const web = context(fakeSession(), { agents: ['research'] });
  web.ctx.engine.agentMonthlyCapUsd = { monitor: 80 };
  assert.doesNotMatch((await (await connect(web.ctx, web.who('ana'))).call('spend')).text, /monitor/);
});

test('the requester is mentioned in Slack when the run ends, with a cleaned, escaped title', async () => {
  const sent: string[] = [];
  const s = fakeSession(async function* (sim) {
    const page = await sim.builtin('WebFetch', { url: 'https://x.test' }, fetchResponse('https://x.test', 'Feature X is configured in eu-west-1.'));
    await sim.mcp('submit_findings', answer(lastId(page), 'configured in eu-west-1', 'Done <!channel> <@U0EVIL1234> ![x](https://evil.test/?q=1) token=hunter2'));
    yield ok();
  });
  const { ctx, who } = context(s, { notify: async (t) => void sent.push(t) });
  await (await connect(ctx, who('ana'))).call('run_agent', { agent: 'research', task: 'Where is feature X configured?', wait_seconds: 10 });
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^<@U0ANA12345> research run ok/);
  assert.match(sent[0]!, /get_run \d{8}T/);
  assert.ok(!sent[0]!.includes('hunter2') && !sent[0]!.includes('evil.test/?q'), sent[0]);
  assert.ok(!sent[0]!.includes('<!channel>') && !sent[0]!.includes('<@U0EVIL1234>'), 'model text cannot ping in Slack');
  assert.match(sent[0]!, /&lt;!channel&gt;/);
});

test('tokens: only hashes are stored, file is private, removal revokes', () => {
  const file = join(tmp('users-'), 'u.json');
  const users = Users.load(file);
  const token = users.add('cy');
  assert.match(token, /^eng_[A-Za-z0-9_-]{43}$/);
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes(token.slice(4)), 'token not stored');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(Users.load(file).authenticate(token)?.name, 'cy');
  assert.equal(Users.load(file).authenticate(token + 'x'), undefined);
  assert.throws(() => users.add('cy'), /exists/);
  const server = Users.load(file); // a running server, loaded before the removal
  assert.equal(server.authenticate(token)?.name, 'cy');
  users.remove('cy'); // the CLI, another process
  assert.equal(server.authenticate(token), undefined, 'revocation reaches a running server');
  const late = Users.load(file).add('dee');
  assert.equal(server.authenticate(late)?.name, 'dee', 'new users too');
});

test('HTTP: bearer token per person, POST only, local Host header on a loopback bind', async (t) => {
  const { ctx, tokens } = context(fakeSession());
  const server = startHttp(ctx, { host: '127.0.0.1', port: 0 });
  await new Promise<void>((r, j) => (server.listening ? r() : server.once('listening', r).once('error', j))).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'EPERM') t.skip('local port binding not allowed here');
    throw e;
  });
  t.after(() => void server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
  const post = (headers: Record<string, string>) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(init) });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: 'Bearer eng_nope' })).status, 401);
  // fetch drops a custom Host header, so send this one raw (a DNS-rebinding page would arrive with its own host).
  const rebound = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/mcp`, { method: 'POST', headers: { host: 'evil.test', authorization: `Bearer ${tokens.ana}`, 'content-type': 'application/json' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(JSON.stringify(init));
  });
  assert.equal(rebound, 403);
  assert.equal((await post({ authorization: `Bearer ${tokens.ana}`, origin: 'https://evil.test' })).status, 403, 'a browser page cannot drive the endpoint');
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${tokens.ana}` } })).status, 405);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.bo}` } } }));
  const names = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes('run_agent') && !names.includes('stop_all'));
  await client.close();
});

test('HTTP with the Keycloak sign-in: discovery, challenge, invited company accounts only, no CLI tokens', async (t) => {
  const { ctx, tokens } = context(fakeSession());
  const kc = fakeKeycloak('https://agent-engine.test');
  ctx.login = new Login(kc.cfg, kc.keys);
  ctx.users.invite('dee@starkfuture.com');
  const server = startHttp(ctx, { host: '127.0.0.1', port: 0 });
  await new Promise<void>((r, j) => (server.listening ? r() : server.once('listening', r).once('error', j))).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'EPERM') t.skip('local port binding not allowed here');
    throw e;
  });
  t.after(() => void server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
  const post = (headers: Record<string, string>) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(init) });

  const doc = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(doc.status, 200);
  assert.deepEqual(((await doc.json()) as { authorization_servers: string[] }).authorization_servers, [kc.cfg.issuer]);
  assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource`)).status, 200);
  assert.equal((await fetch(`${base}/login`)).status, 404, 'no Google login page any more');

  const anon = await post({});
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get('www-authenticate'), 'Bearer resource_metadata="https://agent-engine.test/.well-known/oauth-protected-resource/mcp"');
  assert.equal((await post({ authorization: `Bearer ${tokens.ana}` })).status, 401, 'CLI tokens are not accepted hosted');
  assert.equal((await post({ authorization: `Bearer ${kc.token({ exp: 1 })}` })).status, 401);
  const stranger = await post({ authorization: `Bearer ${kc.token({ email: 'stranger@starkfuture.com' })}` });
  assert.equal(stranger.status, 403, 'a company account alone is not enough');
  assert.equal(stranger.headers.get('www-authenticate'), null, 'signing in again would not help');
  assert.equal((await post({ authorization: `Bearer ${kc.token({ email: 'dee@starkfuture.com', azp: 'stark-admin' })}` })).status, 403);

  // The invite hands out the add command, named after this deployment.
  ctx.cfg.mcp.login = { ...kc.cfg, publicUrl: 'https://agent-engine-web.starkfuture.com/', admins: [], scopes: [] };
  const { call } = await connect(ctx, ctx.users.list().find((u) => u.name === 'root')!);
  assert.match((await call('invite_user', { email: 'eve@starkfuture.com' })).text, /: claude mcp add --transport http agent-engine-web https:\/\/agent-engine-web\.starkfuture\.com\/mcp --client-id agent-engine --callback-port 33419$/);

  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${kc.token({ email: 'dee@starkfuture.com' })}` } } }));
  const names = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes('run_agent') && !names.includes('stop_all'));
  await client.close();

  ctx.users.remove('dee');
  assert.equal((await post({ authorization: `Bearer ${kc.token({ email: 'dee@starkfuture.com' })}` })).status, 403, 'removal applies on the next request');
});

test('get_run on a monitor run: reports from before answer.md, an unreadable challenge, and Slack delivery unknown', async () => {
  const { ctx, who } = context(fakeSession());
  const run = (id: string, agent: string, files: Record<string, string>, user?: string) => {
    ctx.engine.store.skipped({ id, agent, version: 'abc', trigger: user ? `mcp:${user}` : 'patrol', now: new Date(), note: 'fixture', ...(user ? { user } : {}) });
    const dir = join(ctx.engine.runsDir, agent, id);
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  };
  // As filed before the issue record: no `issue`.
  const report = {
    title: 'Authentication errors',
    severity: 'major',
    status: 'unclear',
    started_at: 'unknown',
    what_broke: 'Authentication returns errors',
    impact: 'unknown',
    cause: { hypothesis: 'Pool exhaustion is possible', confidence: 'low' },
    evidence: [{ id: 'E-abcd-1', quote: 'waiting=2', claim: 'Two connections are waiting' }],
    suggested_fix: 'Check the database pool',
    not_checked: ['Customer impact not measured'],
    rows: ['http|auth|/login|500'],
  };
  const objection = { claim: 'Pool exhaustion is unproven', failure_scenario: 'Restarting could interrupt requests', settling_check: 'Read pool time series', evidence: ['E-abcd-1'], blocking: true };
  const challenge = { verdict: 'escalate', overall: 'The cause is disputed', blocking: [objection], notes: [], cost: 0.1, turns: 1, toolCalls: 1 };
  const { call } = await connect(ctx, who('root'));

  run('20261102T100000Z-monitor-abcdef', 'monitor', { 'output.json': JSON.stringify([report]), 'challenge.json': JSON.stringify(challenge) });
  const old = (await call('get_run', { run_id: '20261102T100000Z-monitor-abcdef' })).text;
  for (const part of [
    'Slack delivery: unknown (a run is not linked to its posts yet)',
    '### Report 1\n\n## 🟠 Authentication errors',
    '- Customer impact not measured',
    '• Objection: Pool exhaustion is unproven (if acted on: Restarting could interrupt requests; check: Read pool time series; E-abcd-1)',
    '## Challenge: escalate',
  ])
    assert.ok(old.includes(part), old);
  assert.doesNotMatch(old, /\(no answer\)/);

  run('20261102T101500Z-monitor-abcdef', 'monitor', { 'output.json': JSON.stringify([report]), 'challenge.json': '{"verdict": "upheld", ' });
  const broken = await call('get_run', { run_id: '20261102T101500Z-monitor-abcdef' });
  assert.equal(broken.isError, false);
  assert.match(broken.text, /## Challenge: unreadable\nThe challenge record could not be read: do not treat this run as upheld\./);
  assert.match(broken.text, /## 🟠 Authentication errors/);

  // Since answer.md is written, get_run reads it; delivery is still unknown.
  run('20261103T100000Z-monitor-abcdef', 'monitor', { 'output.json': JSON.stringify([{ ...report, issue: 'new' }]), 'answer.md': '# Monitor reports · patrol 2026-11-03T10:00:00.000Z\n\n### Report 1 · opened I-7f3a (major)\n' });
  const recent = (await call('get_run', { run_id: '20261103T100000Z-monitor-abcdef' })).text;
  assert.match(recent, /Slack delivery: unknown/);
  assert.match(recent, /### Report 1 · opened I-7f3a \(major\)/);

  // Any agent's challenge shows its dissent on single items, with reason and evidence.
  const items = [{ item: 1, holds: 'no', reason: 'The pool was never full', evidence: ['E-abcd-2'] }, { item: 2, holds: 'partly', reason: 'Only one pod', evidence: [] }, { item: 3, holds: 'yes', reason: 'Fine', evidence: [] }];
  run('20261103T103000Z-research-abcdef', 'research', { 'answer.md': '# The answer\n', 'challenge.json': JSON.stringify({ ...challenge, blocking: [], items }) });
  assert.ok((await call('get_run', { run_id: '20261103T103000Z-research-abcdef' })).text.endsWith('## Challenge: escalate\nThe cause is disputed\n- Item 1 does not hold up: The pool was never full (E-abcd-2)\n- Item 2 partly holds: Only one pod'));

  // Other agents' runs are not reports, and a private run stays private.
  run('20261103T100000Z-research-abcdef', 'research', { 'output.json': JSON.stringify([answer('E-abcd-1', 'quote')]) }, 'bo');
  const research = (await call('get_run', { run_id: '20261103T100000Z-research-abcdef' })).text;
  assert.match(research, /\(no answer\)/);
  assert.doesNotMatch(research, /Slack delivery/);
  run('20261103T101500Z-monitor-abcdef', 'monitor', { 'output.json': JSON.stringify([report]) }, 'bo');
  assert.match((await (await connect(ctx, who('ana'))).call('get_run', { run_id: '20261103T101500Z-monitor-abcdef' })).text, /no run 20261103T101500Z-monitor-abcdef/);
});

test('export_run: admins only and read-only; a run’s files redacted again, in parts that join into one JSON object', async () => {
  const { ctx, who } = context(fakeSession());
  const id = '20261104T120000Z-monitor-abcdef';
  ctx.engine.store.skipped({ id, agent: 'monitor', version: 'abc', trigger: 'patrol', now: new Date(), note: 'fixture' });
  const dir = join(ctx.engine.runsDir, 'monitor', id);
  mkdirSync(dir, { recursive: true });
  // An email that got into the files anyway: redacted on the way out.
  const item = { id: 'E-abcd-1', by: 'author', tool: 'log_search', args: { service: 'auth' }, text: 'login failed for someone@example.com' };
  writeFileSync(join(dir, 'input.md'), '# monitor @ abc\n\nask ops@example.com\n');
  writeFileSync(join(dir, 'evidence.jsonl'), `${JSON.stringify(item)}\n${JSON.stringify({ ...item, id: 'E-abcd-2', text: 'y'.repeat(70_000) })}\n`);
  const reports = [{ title: 'Login fails', severity: 'major', rows: ['http|auth|/login|500'] }];
  writeFileSync(join(dir, 'output.json'), JSON.stringify(reports));

  assert.ok(!(await (await connect(ctx, who('ana'))).client.listTools()).tools.some((t) => t.name === 'export_run'), 'members do not see it');
  const { client, call } = await connect(ctx, who('root'));
  assert.equal((await client.listTools()).tools.find((t) => t.name === 'export_run')?.annotations?.readOnlyHint, true);
  const first = await call('export_run', { run_id: id });
  const second = await call('export_run', { run_id: id, part: 2 });
  assert.match(first.text, /^export_run 20261104T120000Z-monitor-abcdef part 1 of 2\n/);
  assert.match(second.text, /^export_run 20261104T120000Z-monitor-abcdef part 2 of 2\n/);
  // A whole response, header included, stays within the cap; a full part comes close to it.
  assert.ok(first.text.length <= EXPORT_PART && first.text.length > EXPORT_PART - 20, String(first.text.length));
  assert.ok(second.text.length <= EXPORT_PART);
  const files = JSON.parse([first, second].map((p) => p.text.slice(p.text.indexOf('\n') + 1)).join('')) as Record<string, string>;
  assert.deepEqual(Object.keys(files), ['input.md', 'evidence.jsonl', 'output.json']); // no challenge.json: none was written
  assert.equal(files['input.md'], '# monitor @ abc\n\nask <email>\n');
  const lines = files['evidence.jsonl']!.split('\n').filter(Boolean).map((l) => JSON.parse(l) as typeof item);
  assert.deepEqual(lines[0], { ...item, text: 'login failed for <email>' });
  assert.equal(lines[1]!.text.length, 70_000);
  assert.deepEqual(JSON.parse(files['output.json']!), reports);
  assert.match((await call('export_run', { run_id: id, part: 3 })).text, /^error: .* has 2 part\(s\)$/);

  // Nothing to export: an unknown run, one still running, one without a folder.
  assert.match((await call('export_run', { run_id: '20261104T120000Z-monitor-000000' })).text, /^error: no run/);
  const running = '20261104T121500Z-monitor-abcdef';
  ctx.engine.store.admit({ id: running, agent: 'monitor', version: 'v', trigger: 'patrol', now: new Date(), deadlineMs: 60_000, reserve: 1, agentCap: 100, globalCap: 100 });
  assert.match((await call('export_run', { run_id: running })).text, /still running/);
  const skipped = '20261104T123000Z-monitor-abcdef';
  ctx.engine.store.skipped({ id: skipped, agent: 'monitor', version: 'v', trigger: 'patrol', now: new Date(), note: 'kill switch' });
  assert.match((await call('export_run', { run_id: skipped })).text, /has no run folder/);
});
