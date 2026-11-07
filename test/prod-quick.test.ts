import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Config } from '../src/config.js';
import { loadAgent } from '../src/engine/agent.js';
import type { Findings } from '../src/engine/output.js';
import type { Engine } from '../src/engine/run.js';
import type { Session } from '../src/engine/session.js';
import { Store } from '../src/engine/store.js';
import { buildServer, type McpContext } from '../src/mcp/server.js';
import { Users, type User } from '../src/mcp/users.js';
import { fakeSession, ok, say, type Script } from './fake-session.js';
import { FakeTelemetry, testConfig, world } from './fake.js';

// prod-quick is an agent folder only: prod's tools and rules with small limits.
// These tests load the shipped folder, not a copy.
const AGENTS = join(import.meta.dirname, '..', 'agents');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastId = (t: string) => [...t.matchAll(/evidence_id: (E-[0-9a-f]{4}-\d+)/g)].at(-1)?.[1] ?? 'none';

// The prod caps as deployed: $25 a day and $500 a month across agents, $400 of it the monitor's.
function context(session: Session, over: { agents?: string[]; now?: Date } = {}) {
  const runsDir = tmp('runs-');
  const engine: Engine = {
    store: new Store(join(runsDir, 'engine.db')),
    runsDir,
    stopFile: join(runsDir, 'STOP'),
    session,
    dailyCapUsd: 25,
    monthlyCapUsd: 500,
    agentMonthlyCapUsd: { monitor: 400 },
    llmAvailable: true,
    ...(over.now ? { now: () => over.now! } : {}),
  };
  const users = Users.load(join(tmp('users-'), 'users.json'));
  users.add('ana');
  const base = testConfig();
  const cfg: Config = { ...base, agentsDir: AGENTS, runsDir, mcp: { ...base.mcp, usersFile: users.file, agents: over.agents } };
  const ctx: McpContext = { cfg, engine, users, repos: new Map() };
  return { ctx, ana: users.list().find((u) => u.name === 'ana')! };
}

async function connect(ctx: McpContext, user: User) {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await buildServer(ctx, user).connect(s);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(c);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content.map((x) => x.text).join(''), isError: Boolean(r.isError) };
  };
}

// A finished run in the ledger: spend some agent (and person) already made.
function book(store: Store, agent: string, at: string, usd: number, user?: string) {
  const id = `seed-${agent}-${at}-${usd}`;
  const now = new Date(at);
  assert.deepEqual(store.admit({ id, agent, version: 'v', trigger: 'test', now, deadlineMs: 60_000, reserve: usd, agentCap: 1e6, globalCap: 1e6, ...(user ? { user } : {}) }), { ok: true });
  store.settle(id, { status: 'ok', cost: usd, turns: 1, outputs: 1, now });
}

test('prod-quick is prod with smaller limits: the same tools, rules and visibility, never challenged', () => {
  const quick = loadAgent(join(AGENTS, 'prod-quick'));
  const prod = loadAgent(join(AGENTS, 'prod'));
  assert.equal(quick.spec.name, 'prod-quick');
  assert.deepEqual(quick.spec.limits, { max_turns: 8, usd_per_run: 0.4, usd_per_day: 5, deadline_min: 3 });
  assert.equal(quick.spec.tool_pack, 'telemetry');
  assert.equal(quick.spec.sensitive_tools, true);
  assert.deepEqual(quick.spec.builtin_tools, []);
  assert.equal(quick.spec.visibility, 'requester');
  assert.equal(quick.spec.challenge.when, 'never');
  assert.equal(quick.spec.code, undefined, 'runnable over MCP');
  assert.equal(quick.spec.model, prod.spec.model);
  for (const k of ['max_turns', 'usd_per_run', 'usd_per_day', 'deadline_min'] as const) assert.ok(quick.spec.limits[k] < prod.spec.limits[k], `${k} is below prod's`);

  // The prompt names the turn budget agent.yaml sets, and carries prod's rules word for word.
  assert.match(quick.prompt, new RegExp(`You have ${quick.spec.limits.max_turns} turns in all`));
  const rules = prod.prompt.split('\nRules\n')[1]!.split('\n\n')[0]!.split('\n');
  assert.ok(rules.length >= 5, 'prod has a Rules section');
  for (const r of rules) assert.ok(quick.prompt.includes(r), `prod-quick keeps prod's rule: ${r}`);
});

test('list_agents offers prod-quick only where ENGINE_AGENTS serves it; listing costs nothing', async () => {
  const session = fakeSession();
  for (const agents of [['monitor', 'prod', 'prod-quick'], undefined]) {
    const served = context(session, { agents });
    const list = (await (await connect(served.ctx, served.ana))('list_agents')).text;
    assert.match(list, /^prod-quick @[0-9a-f]{12}$/m, `served with ENGINE_AGENTS=${agents?.join(',') ?? '(unset)'}`);
    assert.match(list, /^ {2}model claude-sonnet-5-5 · tools telemetry pack · \$0\.4\/run · 3 min · up to 2 at once · challenge never$/m);
    assert.match(list, /^prod @[0-9a-f]{12}$/m);
  }

  // Production today: ENGINE_AGENTS=monitor,prod.
  const { ctx, ana } = context(session, { agents: ['monitor', 'prod'] });
  const call = await connect(ctx, ana);
  const list = (await call('list_agents')).text;
  assert.doesNotMatch(list, /prod-quick/);
  assert.match(list, /^prod @/m);
  assert.match((await call('run_agent', { agent: 'prod-quick', task: 'Is checkout erroring right now?' })).text, /error: no agent "prod-quick"; see list_agents/);
  assert.equal(session.requests.length, 0, 'no model call');
  assert.match((await call('list_runs')).text, /^no runs$/, 'nothing recorded, nothing spent');
});

test('a prod-quick run gets the telemetry pack and its own limits, holds $0.40 while it runs, then books what it spent', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const quickOk: Script = async function* (sim) {
    const r = await sim.mcp('service_overview', { service: 'backend-production', minutes: 15 });
    yield say();
    await gate;
    const answer: Findings = {
      title: 'Products load normally right now',
      summary: 'No: /v1/products answers 200 as it did a day and a week ago.',
      findings: [{ claim: 'Products return 200 at the usual volume', status: 'confirmed', evidence: [{ id: lastId(r.text), quote: '/v1/products 200' }] }],
      next_steps: ['Ask the prod agent for a full investigation.'],
      not_checked: ['logs', 'traces', 'other services'],
      lessons: [],
    };
    await sim.mcp('submit_findings', answer);
    yield ok(0.06, 3);
  };
  const session = fakeSession(quickOk);
  const { ctx, ana } = context(session, { agents: ['monitor', 'prod', 'prod-quick'] });
  ctx.telemetry = new FakeTelemetry(world);
  const call = await connect(ctx, ana);
  try {
    const started = await call('run_agent', { agent: 'prod-quick', task: 'Are products loading right now?' });
    const runId = /^run (\S+): running/.exec(started.text)?.[1];
    assert.ok(runId, started.text);

    // Admission holds the whole per-run cap against every cap until the run settles.
    assert.match((await call('get_run', { run_id: runId })).text, /· prod-quick@[0-9a-f]{12} · running .*\n.* · cost \$0\.400 reserved ·/);
    const held = (await call('spend')).text;
    assert.match(held, /^you today: \$0\.40 of \$10$/m);
    assert.match(held, /^ {2}prod-quick \$0\.40 of \$5$/m);

    const req = session.requests[0]!;
    assert.equal(req.maxTurns, 8);
    assert.equal(req.maxBudgetUsd, 0.4);
    assert.deepEqual(req.builtin, []);
    assert.match(req.system, /^# Prod \(quick\)/);
    const tools = req.tools.map((t) => t.name);
    for (const t of ['service_overview', 'route_timeline', 'log_search', 'workload_state', 'recent_changes', 'promql', 'trace_search', 'submit_findings']) assert.ok(tools.includes(t), t);

    release();
    let got = '';
    for (let i = 0; i < 200 && !/ · ok\n/.test(got); i++) {
      await sleep(10);
      got = (await call('get_run', { run_id: runId })).text;
    }
    assert.match(got, / · ok\n.* · cost \$0\.060 · 3 turns/);
    assert.match(got, /# Products load normally right now/);
    assert.match(got, /## Not checked\n- logs/);
    assert.match((await call('spend')).text, /^ {2}prod-quick \$0\.06 of \$5$/m);
  } finally {
    release();
  }
});

test('prod-quick spends from the shared pool: its own $5 a day, the asker\'s $10 a day, and the global daily and monthly caps; no people share', async () => {
  const at = new Date('2026-11-20T10:00:00Z');
  const quiet: Script = async function* () {
    yield ok(0.05, 1);
  };
  const ask = async (seed: (s: Store) => void) => {
    const { ctx, ana } = context(fakeSession(quiet), { agents: ['monitor', 'prod', 'prod-quick'], now: at });
    ctx.telemetry = new FakeTelemetry(world);
    seed(ctx.engine.store);
    return (await (await connect(ctx, ana))('run_agent', { agent: 'prod-quick', task: 'Is checkout erroring right now?', wait_seconds: 5 })).text;
  };
  const refused = (t: string, why: RegExp) => {
    assert.match(t, why);
    assert.match(t, /not started\.$/);
  };

  // Its own daily cap, counting the $0.40 it would hold: 4.70 + 0.40 > 5.
  refused(await ask((s) => book(s, 'prod-quick', '2026-11-20T09:00:00Z', 4.7)), /agent daily cap \$5 reached/);
  // The asker's daily cap spans agents: prod spend counts.
  refused(await ask((s) => book(s, 'prod', '2026-11-20T09:00:00Z', 9.7, 'ana')), /your daily cap \$10 reached/);
  // The global daily cap is shared with the monitor's patrol.
  refused(await ask((s) => book(s, 'monitor', '2026-11-20T09:00:00Z', 24.7)), /global daily cap \$25 reached/);

  // No $100 people share in code: people past $100 this month still run while the month has room...
  const month = (s: Store) => {
    book(s, 'monitor', '2026-11-02T10:00:00Z', 300);
    book(s, 'prod', '2026-11-03T10:00:00Z', 150, 'ana');
  };
  assert.match(await ask(month), /^run \S+: no_output\n/);
  // ...and only the global monthly cap stops them.
  refused(
    await ask((s) => {
      month(s);
      book(s, 'monitor', '2026-11-04T10:00:00Z', 49.7);
    }),
    /monthly cap \$500 reached/,
  );
});
