import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
import { buildServer, startHttp, type McpContext } from '../src/mcp/server.js';
import { Users, type User } from '../src/mcp/users.js';
import { fakeSession, fetchResponse, ok, readResponse, say, type Script } from './fake-session.js';

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
  return root;
}

function gitRepo(): string {
  const root = tmp('repo-');
  writeFileSync(join(root, 'a.ts'), 'export const mode = "WAL";');
  execFileSync('git', ['init', '-q', '--template=', root]);
  execFileSync('git', ['-C', root, 'add', '-A']);
  return root;
}

function context(session: Session, over: { userCap?: number; notify?: (t: string) => Promise<void> } = {}) {
  const runsDir = tmp('runs-');
  const engine: Engine = { store: new Store(join(runsDir, 'engine.db')), runsDir, stopFile: join(runsDir, 'STOP'), session, dailyCapUsd: 20, monthlyCapUsd: 100, llmAvailable: true };
  const users = Users.load(join(tmp('users-'), 'users.json'));
  const tokens = { ana: users.add('ana', { slackId: 'U0ANA12345' }), bo: users.add('bo'), root: users.add('root', { admin: true }) };
  const cfg = { agentsDir: agentsDir(), runsDir, mcp: { usersFile: users.file, reposFile: '', userDailyCapUsd: over.userCap ?? 10, userMaxRunning: 2, notifySlack: false } } as unknown as Config;
  const ctx: McpContext = { cfg, engine, users, repos: new Map([['app', gitRepo()]]), ...(over.notify ? { notify: over.notify } : {}) };
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

test('only admins get the kill switch and lesson approval', async () => {
  const { ctx, who } = context(fakeSession());
  const names = async (u: string) => (await (await connect(ctx, who(u))).client.listTools()).tools.map((t) => t.name);
  const member = await names('ana');
  for (const t of ['stop_all', 'resume', 'approve_lesson']) assert.ok(!member.includes(t), t);
  const admin = await names('root');
  for (const t of ['stop_all', 'resume', 'approve_lesson']) assert.ok(admin.includes(t), t);
  const { call } = await connect(ctx, who('root'));
  await call('stop_all', { reason: 'testing' });
  const skipped = await (await connect(ctx, who('ana'))).call('run_agent', { agent: 'research', task: 'Anything at all, please.' });
  assert.match(skipped.text, /skipped[\s\S]*stop file/);
  await call('approve_lesson', { agent: 'research', lesson: 'Prefer the official docs over blog posts.' });
  assert.match(readFileSync(join(ctx.cfg.agentsDir, 'research', 'memory', 'lessons.md'), 'utf8'), /official docs.*approved by root/);
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

test('the requester is mentioned in Slack when the run ends, with a cleaned title', async () => {
  const sent: string[] = [];
  const s = fakeSession(async function* (sim) {
    const page = await sim.builtin('WebFetch', { url: 'https://x.test' }, fetchResponse('https://x.test', 'Feature X is configured in eu-west-1.'));
    await sim.mcp('submit_findings', answer(lastId(page), 'configured in eu-west-1', 'Done ![x](https://evil.test/?q=1) token=hunter2'));
    yield ok();
  });
  const { ctx, who } = context(s, { notify: async (t) => void sent.push(t) });
  await (await connect(ctx, who('ana'))).call('run_agent', { agent: 'research', task: 'Where is feature X configured?', wait_seconds: 10 });
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^<@U0ANA12345> research run ok/);
  assert.match(sent[0]!, /get_run \d{8}T/);
  assert.ok(!sent[0]!.includes('hunter2') && !sent[0]!.includes('evil.test/?q'), sent[0]);
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
  users.remove('cy');
  assert.equal(Users.load(file).authenticate(token), undefined);
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
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${tokens.ana}` } })).status, 405);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.bo}` } } }));
  const names = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes('run_agent') && !names.includes('stop_all'));
  await client.close();
});
