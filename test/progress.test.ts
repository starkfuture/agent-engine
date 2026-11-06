import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Progress, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../src/config.js';
import type { Engine } from '../src/engine/run.js';
import type { Session } from '../src/engine/session.js';
import { Store } from '../src/engine/store.js';
import { progressBlock, progressLine, progressNotifier, runProgress } from '../src/mcp/progress.js';
import { buildServer, startHttp, type McpContext } from '../src/mcp/server.js';
import { Users, type User } from '../src/mcp/users.js';
import { fakeSession, ok, say, type Script, type Sim } from './fake-session.js';
import { FakeTelemetry, testConfig, world } from './fake.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Pauses the fake model until the test says go; an abort (cancel) ends it.
const until = async (sim: Sim, go: () => boolean) => {
  while (!go()) await sim.sleep(20);
};
const EMAIL = 'ana.customer@example.com';

function context(session: Session, stream?: boolean) {
  const runsDir = tmp('runs-');
  const engine: Engine = { store: new Store(join(runsDir, 'engine.db')), runsDir, stopFile: join(runsDir, 'STOP'), session, dailyCapUsd: 20, monthlyCapUsd: 100, llmAvailable: true };
  const users = Users.load(join(tmp('users-'), 'users.json'));
  const tokens = { ana: users.add('ana'), bo: users.add('bo') };
  const agents = tmp('agents-');
  mkdirSync(join(agents, 'prod', 'memory'), { recursive: true });
  writeFileSync(join(agents, 'prod', 'agent.yaml'), 'name: prod\nsensitive_tools: true\ntool_pack: telemetry\nlimits: { usd_per_run: 1, usd_per_day: 10 }\n');
  writeFileSync(join(agents, 'prod', 'CLAUDE.md'), '# prod\nYou answer questions.');
  const base = testConfig();
  const cfg: Config = { ...base, agentsDir: agents, runsDir, mcp: { ...base.mcp, usersFile: users.file, ...(stream ? { stream } : {}) } };
  const ctx: McpContext = { cfg, engine, users, repos: new Map(), telemetry: new FakeTelemetry(world) };
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

async function poll(read: () => Promise<string>, re: RegExp, ms = 5000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const t = await read();
    if (re.test(t) || Date.now() - t0 > ms) return t;
    await wait(25);
  }
}

test('progress from a transcript: tool calls redacted and capped, a partial last line skipped, the challenger marked', () => {
  const dir = tmp('run-');
  const now = new Date('2026-11-06T12:02:05Z');
  assert.deepEqual(runProgress(dir), { steps: [], challenger: false }, 'no transcript yet');
  assert.equal(progressBlock(runProgress(dir), '2026-11-06T12:02:00Z', now), '(still running) 5s so far · no tool calls yet');

  const file = join(dir, 'transcript.jsonl');
  const line = (e: unknown) => appendFileSync(file, `${JSON.stringify(e)}\n`);
  line({ by: 'author', kind: 'text', text: 'Looking at the errors first.' });
  line({ by: 'author', kind: 'tool_use', name: 'mcp__engine__service_overview', input: { service: 'orders', minutes: 60 } });
  // As if written unredacted: an email, a secret-named key and a bearer token.
  line({ by: 'author', kind: 'tool_use', name: 'mcp__engine__log_search', input: { contains: EMAIL, token: 'abc123secretvalue', note: 'Authorization: Bearer abcdefghijklmnop' } });
  line({ by: 'author', kind: 'tool_use', name: 'mcp__engine__promql', input: { query: `sum(rate(http_requests_total{service="orders",route=~"/v3/orders/.*",status_code=~"5.."}[5m])) by (route)` } });
  line({ by: 'author', kind: 'tool_use', name: 'mcp__engine__submit_findings', input: { title: 'Orders fail', summary: 'A long answer' } });
  line({ by: 'author', kind: 'result', ok: true, subtype: 'success', cost: 0.2, turns: 4, text: 'done' });
  line({ by: 'challenger', kind: 'tool_use', name: 'mcp__engine__promql', input: { query: 'up' } });
  appendFileSync(file, '{"by":"challenger","kind":"tool_use","name":"mcp__engine__pro'); // being written
  utimesSync(file, now, new Date(now.getTime() - 12_000));

  const p = runProgress(dir);
  assert.deepEqual(
    p.steps.map((s) => `${s.by} ${s.tool}`),
    ['author service_overview', 'author log_search', 'author promql', 'author submit_findings', 'challenger promql'],
  );
  assert.equal(p.challenger, true);
  const shown = JSON.stringify(p);
  for (const raw of [EMAIL, 'abc123secretvalue', 'abcdefghijklmnop']) assert.ok(!shown.includes(raw), `${raw} redacted`);
  assert.match(p.steps[1]!.args, /<email>/);
  assert.ok(p.steps[2]!.args.length <= 80 && p.steps[2]!.args.endsWith('…'), 'long arguments are cut');
  assert.equal(p.steps[3]!.args, '', 'the submitted answer is not repeated');

  const block = progressBlock(p, '2026-11-06T12:00:00Z', now);
  assert.equal(block.split('\n')[0], '(still running) 2m 05s so far · 5 tool calls · last activity 12s ago · the challenger is checking the answer');
  assert.match(block, /^ {2}1\. service_overview \{"service":"orders","minutes":60\}$/m);
  assert.match(block, /^ {2}4\. submit_findings$/m);
  assert.match(block, /^ {2}5\. challenger: promql \{"query":"up"\}$/m);
  assert.equal(progressLine('prod', 'RUN', p, '2026-11-06T12:00:00Z', now), 'prod run RUN: 2m 05s so far · 5 tool calls · last challenger: promql {"query":"up"} · challenger checking');

  // The line is finished, and the run goes on: the latest calls, the earlier ones as a count.
  appendFileSync(file, 'mql","input":{"query":"rate(x[5m])"}}\n');
  for (let i = 0; i < 8; i++) line({ by: 'challenger', kind: 'tool_use', name: 'mcp__engine__workload_state', input: { workload: `svc-${i}` } });
  const long = progressBlock(runProgress(dir), '2026-11-06T12:00:00Z', now);
  assert.match(long, /^ {2}… 4 earlier calls$/m);
  assert.match(long, /^ {2}6\. challenger: promql \{"query":"rate\(x\[5m\]\)"\}$/m);
  assert.match(long, /^ {2}14\. challenger: workload_state \{"workload":"svc-7"\}$/m);
  assert.ok(!/^ {2}4\. /m.test(long));
});

test('progress from a long transcript reads only its end and says so; an unreadable one is not "no tool calls"', () => {
  const now = new Date('2026-11-06T12:02:05Z');
  const dir = tmp('run-');
  const file = join(dir, 'transcript.jsonl');
  const line = (e: unknown) => appendFileSync(file, `${JSON.stringify(e)}\n`);
  line({ by: 'author', kind: 'tool_use', name: 'mcp__engine__service_overview', input: { service: 'orders', minutes: 60 } });
  line({ by: 'author', kind: 'text', text: 'x'.repeat(1_100_000) }); // past the 1 MB read from the end
  line({ by: 'author', kind: 'tool_use', name: 'mcp__engine__promql', input: { query: 'up' } });
  const p = runProgress(dir);
  assert.equal(p.earlier, true);
  assert.deepEqual(
    p.steps.map((s) => s.tool),
    ['promql'],
    'the call before the last megabyte is not read',
  );
  const block = progressBlock(p, '2026-11-06T12:00:00Z', now);
  assert.match(block, /^\(still running\) 2m 05s so far · 1 recent tool call \(earlier ones not read\) · /);
  assert.match(block, /^ {2}… earlier calls not read \(a long transcript\)\n {2}- promql \{"query":"up"\}$/m);
  assert.match(progressLine('prod', 'RUN', p, '2026-11-06T12:00:00Z', now), /^prod run RUN: 2m 05s so far · 1 recent tool call \(earlier ones not read\) · last promql/);

  const broken = tmp('run-');
  mkdirSync(join(broken, 'transcript.jsonl')); // exists, can't be read as a file
  const q = runProgress(broken);
  assert.equal(q.unreadable, true);
  assert.equal(progressBlock(q, '2026-11-06T12:00:00Z', now), '(still running) 2m 05s so far · transcript unreadable');
  assert.equal(progressLine('prod', 'RUN', q, '2026-11-06T12:00:00Z', now), 'prod run RUN: 2m 05s so far · transcript unreadable');
});

test('progress notifications: only with a token, at once and then on every tick, stopped cleanly, never throwing', async () => {
  const sent: ServerNotification[] = [];
  const extra = (token: string | undefined, send: (n: ServerNotification) => Promise<void>, signal = new AbortController().signal) => ({ ...(token ? { _meta: { progressToken: token } } : {}), sendNotification: send, signal });
  const record = async (n: ServerNotification) => void sent.push(n);

  const none = progressNotifier(extra(undefined, record), () => 'x', 10);
  await wait(50);
  none();
  assert.equal(sent.length, 0, 'no token: the client asked for no progress');

  let i = 0;
  const stop = progressNotifier(extra('tok', record), () => `step ${++i}`, 20);
  assert.equal(sent.length, 1, 'the first one goes at once');
  await wait(130);
  stop();
  const n = sent.length;
  assert.ok(n >= 3, `${n} sent`);
  await wait(80);
  assert.equal(sent.length, n, 'nothing after stop');
  for (const [k, x] of sent.entries()) {
    assert.equal(x.method, 'notifications/progress');
    const params = x.params as Progress & { progressToken: string };
    assert.equal(params.progressToken, 'tok');
    assert.equal(params.progress, k + 1, 'progress increases with every notification');
    assert.equal(params.message, `step ${k + 1}`);
  }

  // A client that went away, or a message that can't be built: the wait goes on.
  let tries = 0;
  const failing = progressNotifier(
    extra('tok', async () => {
      tries++;
      throw new Error('stream closed');
    }),
    () => 'x',
    10,
  );
  const throwing = progressNotifier(
    extra('tok', record),
    () => {
      throw new Error('unreadable');
    },
    10,
  );
  await wait(60);
  failing();
  throwing();
  assert.ok(tries >= 3, 'keeps trying after a failed send');

  // The caller cancels the request: progress stops by itself.
  const ac = new AbortController();
  const before = sent.length;
  progressNotifier(extra('tok', record, ac.signal), () => 'y', 10);
  ac.abort();
  await wait(60);
  assert.equal(sent.length, before + 1, 'only the first, sent before the cancel');
});

test('get_run on a running run lists the tool calls so far, redacted, at no cost; others still cannot read it', async () => {
  let go = false;
  let finish = false;
  const pausing: Script = async function* (sim) {
    await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
    yield say('Checking the error logs next.');
    await until(sim, () => go);
    await sim.mcp('log_search', { service: 'backend-production', contains: EMAIL, minutes: 30 });
    yield say();
    await until(sim, () => finish);
    yield ok();
  };
  const session = fakeSession(pausing);
  const { ctx, who } = context(session);
  const { call } = await connect(ctx, who('ana'));
  const started = await call('run_agent', { agent: 'prod', task: 'Why do orders fail right now?' });
  const runId = /run (\S+): running/.exec(started.text)![1]!;
  const read = async () => (await call('get_run', { run_id: runId })).text;

  const one = await poll(read, /1 tool call /);
  assert.match(one, /^\(still running\) \d+s so far · 1 tool call · last activity \d+s ago$/m, one);
  assert.match(one, /^ {2}1\. service_overview \{"service":"backend-production","minutes":60\}$/m);
  assert.match(one, /cost \$1\.000 reserved/);

  go = true;
  const two = await poll(read, /2 tool calls/);
  assert.match(two, /^ {2}2\. log_search \{"service":"backend-production","contains":"<email>","minutes":30\}$/m, two);
  assert.ok(!two.includes(EMAIL), 'the email never leaves');
  assert.match((await (await connect(ctx, who('bo'))).call('get_run', { run_id: runId })).text, /no run/, "someone else's private run stays hidden");

  assert.equal(session.requests.length, 1, 'reading progress starts no model session');
  assert.equal(ctx.engine.store.recent(10).length, 1, 'and books nothing');
  finish = true;
  const ended = await poll(read, /· no_output$/m);
  assert.match(ended, /· no_output$/m);
  assert.doesNotMatch(ended, /still running/, 'an ended run shows no progress');
});

test('run_agent with wait_seconds sends progress to a client that asked for it', async () => {
  const slow: Script = async function* (sim) {
    await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
    yield say();
    await sim.sleep(6_000); // past the first 5-second tick
    yield ok(0.1);
  };
  const { ctx, who } = context(fakeSession(slow));
  const { client } = await connect(ctx, who('ana'));
  const got: Progress[] = [];
  const r = (await client.callTool({ name: 'run_agent', arguments: { agent: 'prod', task: 'Is checkout failing right now?', wait_seconds: 7 } }, undefined, { onprogress: (p) => got.push(p) })) as {
    content: Array<{ text: string }>;
  };
  const text = r.content.map((x) => x.text).join('');
  const runId = /^run (\S+): /.exec(text)![1]!;
  assert.ok(got.length >= 2, `${got.length} progress messages`);
  assert.deepEqual(
    got.map((p) => p.progress),
    got.map((_, k) => k + 1),
  );
  for (const p of got) assert.ok(p.message?.startsWith(`prod run ${runId}: `), p.message);
  assert.ok(
    got.some((p) => /· 1 tool call · last service_overview \{"service":"backend-production","minutes":60\}$/.test(p.message ?? '')),
    got.map((p) => p.message).join('\n'),
  );
});

// Binds a local port: skipped where that is not allowed (run it outside the sandbox).
test('HTTP: JSON responses by default (progress dropped); ENGINE_MCP_STREAM=1 streams the progress over SSE', async (t) => {
  const quick: Script = async function* (sim) {
    await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
    yield say();
    await sim.sleep(300);
    yield ok(0.1);
  };
  for (const stream of [false, true]) {
    const { ctx, tokens } = context(fakeSession(quick, quick), stream);
    const server = startHttp(ctx, { host: '127.0.0.1', port: 0 });
    const listening = await new Promise<boolean>((r, j) => (server.listening ? r(true) : server.once('listening', () => r(true)).once('error', j))).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'EPERM') return false;
      throw e;
    });
    if (!listening) return t.skip('local port binding not allowed here');
    t.after(() => void server.close());
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const callRun = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_agent', arguments: { agent: 'prod', task: 'Is checkout failing right now?', wait_seconds: 3 }, _meta: { progressToken: 'p1' } } };
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tokens.ana}` }, body: JSON.stringify(callRun) });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    if (!stream) {
      assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
      const msg = JSON.parse(body) as { id: number; result: { content: Array<{ text: string }> } };
      assert.equal(msg.id, 2);
      assert.match(msg.result.content[0]!.text, /^run \S+: /);
      assert.ok(!body.includes('notifications/progress'), 'JSON mode carries the result only');
      continue;
    }
    assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
    const events = body
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)) as { method?: string; id?: number; params?: { progressToken?: string; message?: string } });
    const progress = events.filter((e) => e.method === 'notifications/progress');
    assert.ok(progress.length >= 1, body);
    assert.equal(progress[0]!.params?.progressToken, 'p1');
    assert.match(progress[0]!.params?.message ?? '', /^prod run \S+: /);
    assert.equal(events.at(-1)?.id, 2, 'the result comes last');

    // The SDK client over the same transport hands the progress to onprogress.
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${tokens.ana}` } } }));
    const got: Progress[] = [];
    await client.callTool({ name: 'run_agent', arguments: { agent: 'prod', task: 'Is checkout failing right now?', wait_seconds: 3 } }, undefined, { onprogress: (p) => got.push(p) });
    assert.ok(got.length >= 1, 'progress reached the client');
    await client.close();
  }
});
