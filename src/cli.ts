#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, loadDotEnv, type Config } from './config.js';
import { DirectTelemetry, GrafanaTelemetry, readToken, RecordingTelemetry, ReplayTelemetry, type Telemetry } from './clients/telemetry.js';
import { httpQuery } from './patrol/collectors.js';
import { Noise } from './patrol/noise.js';
import { Owners } from './patrol/owners.js';
import { State } from './patrol/state.js';
import { rowLine } from './patrol/summary.js';
import { CardSink } from './output/sink.js';
import { listAgents, loadAgent } from './engine/agent.js';
import { Store } from './engine/store.js';
import { redact } from './engine/text.js';
import { findingsOutput } from './engine/output.js';
import { writeAnswer } from './engine/answer.js';
import { runAgent, stopAllRuns, type Engine } from './engine/run.js';
import { sdkSession } from './engine/session.js';
import { patrolLoop, patrolOnce, type MonitorAgent } from './runner.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer, shutdown, slackNotifier, startHttp, type McpContext } from './mcp/server.js';
import { loadRepos } from './mcp/repos.js';
import { expiresAt, MAX_TOKEN_DAYS, Users } from './mcp/users.js';
import { Login } from './mcp/login.js';
import { InstallationTokens } from './mcp/github-app.js';
import { RepoSync } from './mcp/reposync.js';
import { Metrics, startHealth, startMetrics } from './metrics.js';
import { sweep } from './engine/retention.js';

const USAGE = `engine <command> [options]

Agents (folders in agents/):
  agents                      list agents with version, model, tools and limits
  run <agent> --task "<text>" one run of a task agent (research, codebase)
      --path <dir>            folder the codebase agent may read (required for it)
      --ref <ref>             commit it reads (default origin/HEAD, else HEAD; never uncommitted edits)
      --challenge             have a challenger check the answer
  run monitor                 one patrol with the investigator (same as: patrol --llm)
  runs [--agent <name>]       recent runs with status, cost and challenge verdict
  stop | resume               create or remove the STOP file: running agents stop at the next step

MCP server (several developers, one engine):
  serve [--host 127.0.0.1] [--port 8787]
                              Streamable HTTP MCP at /mcp; each person signs in (Keycloak) or uses their own token
      --patrol [--llm] [--post]  also run the monitor's patrol loop in this process
      --metrics-port <n>      Prometheus metrics at /metrics on their own port (heartbeat)
  mcp-stdio --as <user>       the same tools over stdio, for one local user
  user add <name> [--admin] [--email <email>] [--slack <U…>] [--usd <per day>] [--days <n ≤ 90>]
                              issue a token (printed once; only its hash is stored; expires, default 90 days).
                              Local only: with the Keycloak sign-in on (KEYCLOAK_ISSUER), \`user add\` is off
  user list | user remove <name>
  user invite <email> [--admin]  let someone sign in with their company account (Keycloak)
  user promote | demote <name>  make a user admin or member (no token is issued)

Monitor:
  doctor                      check access, list datasources, show real metric labels
  patrol                      one patrol pass
      --at <ISO>              evaluate at a past time (replay against live data)
      --llm                   run the investigator (needs ANTHROPIC_API_KEY or Bedrock)
      --post                  post cards to SLACK_WEBHOOK_URL
      --replay <dir>          read telemetry from an export instead of Grafana
      --fresh                 in-memory state (don't read or write .state/)
  loop                        patrol every window (default 15 min) until stopped; same flags, plus --metrics-port,
                              and --port <n> for a /healthz-only listener (the pod's probes, monitor-only hosting)
  export --from <ISO> --to <ISO> [--out <dir>] [--step <min>]
                              record every patrol query in the range (no LLM), for offline replay
  replay --from <ISO> --to <ISO> [--step <min>] [--replay <dir>] [--llm]
                              run the patrol across a past range with one shared state; prints
                              what would have been reported, step by step
`;

const { positionals, values: a } = parseArgs({
  allowPositionals: true,
  options: {
    at: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    step: { type: 'string' },
    out: { type: 'string' },
    replay: { type: 'string' },
    task: { type: 'string' },
    path: { type: 'string' },
    ref: { type: 'string' },
    agent: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'string' },
    as: { type: 'string' },
    admin: { type: 'boolean', default: false },
    slack: { type: 'string' },
    usd: { type: 'string' },
    days: { type: 'string' },
    email: { type: 'string' },
    challenge: { type: 'boolean', default: false },
    llm: { type: 'boolean', default: false },
    post: { type: 'boolean', default: false },
    fresh: { type: 'boolean', default: false },
    patrol: { type: 'boolean', default: false },
    'metrics-port': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

// SIGTERM (a redeploy) or Ctrl-C: stop running runs and wait until they are
// settled before exiting, so no "running" row is left holding slots and
// reservations. A second signal exits at once.
let draining = false;
let beforeExit: (() => Promise<unknown>) | undefined;
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, () => {
    const code = sig === 'SIGINT' ? 130 : 143;
    if (draining) process.exit(code);
    draining = true;
    log(`${sig}: stopping running runs`);
    void Promise.all([beforeExit?.(), stopAllRuns(`${sig}: engine shutting down`, 20_000)])
      .catch((e: Error) => log(`shutdown: ${e.message}`))
      .finally(() => process.exit(code));
  });

function liveTelemetry(cfg: Config): Telemetry {
  if (cfg.direct) return new DirectTelemetry(cfg.direct);
  return grafanaTelemetry(cfg);
}
function grafanaTelemetry(cfg: Config): GrafanaTelemetry {
  return new GrafanaTelemetry({ url: cfg.grafanaUrl, token: readToken(cfg.grafanaTokenFile), promUid: cfg.promUid, lokiUid: cfg.lokiUid, tempoUid: cfg.tempoUid });
}
function telemetry(cfg: Config): Telemetry {
  return a.replay ? new ReplayTelemetry(resolve(a.replay)) : liveTelemetry(cfg);
}
function date(s: string | undefined, name: string): Date {
  const d = new Date(s ?? '');
  if (Number.isNaN(d.getTime())) throw new Error(`--${name} must be an ISO time, e.g. 2026-09-29T12:00:00Z`);
  return d;
}
// The engine code a run used: ENGINE_BUILD (the image tag when hosted), else
// this checkout's commit, marked -dirty when it has local edits.
function engineBuild(cfg: Config): string | undefined {
  if (cfg.build) return cfg.build;
  try {
    return execFileSync('git', ['-C', import.meta.dirname, 'describe', '--always', '--dirty'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

// One store and one STOP file for every entry point (patrol, loop, run, replay),
// so caps, single flight and the kill switch can't be sidestepped.
function makeEngine(cfg: Config, runsDir = cfg.runsDir): Engine {
  const build = engineBuild(cfg);
  return {
    ...(build ? { build } : {}),
    minFreeBytes: 200e6, // keep room for logins, settlement and the ledger
    store: new Store(join(cfg.runsDir, 'engine.db')),
    runsDir,
    stopFile: join(cfg.runsDir, 'STOP'),
    session: sdkSession,
    dailyCapUsd: cfg.llm.dailyCapUsd,
    monthlyCapUsd: cfg.llm.monthlyCapUsd,
    llmAvailable: cfg.llm.available,
  };
}
function monitorAgent(cfg: Config): MonitorAgent {
  return { engine: makeEngine(cfg), agent: loadAgent(join(cfg.agentsDir, 'monitor'), cfg.memoryDir) };
}

// Patrol times sit on window boundaries so recordings and replays line up.
const align = (d: Date, min: number) => new Date(Math.floor(d.getTime() / (min * 60_000)) * min * 60_000);

// The patrol every window until the process ends; each pass lands in metrics.
async function patrolEvery(cfg: Config, noise: Noise, owners: Owners, sink: CardSink, w: number, metrics?: Metrics): Promise<void> {
  await patrolLoop({
    tel: telemetry(cfg),
    cfg,
    noise,
    state: State.load(cfg.stateFile),
    sink,
    windowMin: w,
    opts: { llm: a.llm, post: a.post, log, owners },
    monitor: a.llm ? monitorAgent(cfg) : undefined,
    onPass: metrics ? (at, r) => metrics.patrol(at, r) : undefined,
  });
}

function metricsServer(cfg: Config): Metrics | undefined {
  if (!a['metrics-port']) return undefined;
  const metrics = new Metrics();
  const port = Number(a['metrics-port']);
  startMetrics(metrics, makeEngine(cfg), { host: a.host ?? '127.0.0.1', port });
  log(`metrics on :${port}/metrics`);
  return metrics;
}

async function doctor(cfg: Config) {
  const tel = liveTelemetry(cfg);
  if (cfg.direct) console.log(`In-cluster: Prometheus ${cfg.direct.prometheusUrl}, Loki ${cfg.direct.lokiUrl ?? '-'}, Tempo ${cfg.direct.tempoUrl ?? '-'}`);
  else {
    console.log(`Grafana ${cfg.grafanaUrl}, token file ${cfg.grafanaTokenFile}: present`);
    try {
      const ds = await grafanaTelemetry(cfg).datasources();
      console.log('\nDatasources (set LOKI_DATASOURCE_UID / TEMPO_DATASOURCE_UID from these):');
      for (const d of ds) console.log(`  ${d.type.padEnd(12)} uid=${d.uid}  ${d.name}`);
    } catch (e) {
      console.log(`  could not list datasources: ${(e as Error).message}`);
    }
  }
  const now = new Date();
  console.log('\nHTTP families (labels on a real series; check route/status/service labels match sources.yaml):');
  for (const f of cfg.sources.http_families) {
    try {
      const res = await tel.promInstant(`topk(2, ${f.selector})`, now);
      const want = [f.service_label, f.route_label, f.status_label].filter(Boolean) as string[];
      const have = new Set(res.flatMap((s) => Object.keys(s.labels)));
      const missing = want.filter((l) => !have.has(l));
      console.log(`  ${f.id}: ${res.length ? 'OK' : 'NO SERIES'}${missing.length ? `  MISSING LABELS: ${missing.join(', ')}` : ''}`);
      if (res[0]) console.log(`    labels: ${[...have].sort().join(', ')}`);
      const sample = await tel.promInstant(httpQuery(f, cfg.windowMinutes), now);
      console.log(`    patrol query returns ${sample.length} cells`);
    } catch (e) {
      console.log(`  ${f.id}: ERROR ${(e as Error).message}`);
    }
  }
  for (const c of cfg.sources.error_counters) {
    try {
      const res = await tel.promInstant(`topk(2, ${c.selector})`, now);
      const have = new Set(res.flatMap((s) => Object.keys(s.labels)));
      const missing = c.group_by.filter((l) => !have.has(l));
      console.log(`  counter ${c.id}: ${res.length ? 'OK' : 'NO SERIES'}${missing.length ? `  MISSING LABELS: ${missing.join(', ')}` : ''}${res[0] ? `  labels: ${[...have].sort().join(', ')}` : ''}`);
    } catch (e) {
      console.log(`  counter ${c.id}: ERROR ${(e as Error).message}`);
    }
  }
  try {
    const res = await tel.promInstant(`count by (namespace) (kube_pod_info{namespace=~"${cfg.sources.workloads.namespaces}"})`, now);
    console.log(`\nWorkloads: pods per namespace: ${res.map((s) => `${s.labels.namespace}=${s.value}`).join(', ') || 'NONE (check workloads.namespaces)'}`);
  } catch (e) {
    console.log(`\nWorkloads: ERROR ${(e as Error).message}`);
  }
  if (tel.has.loki) {
    try {
      const lines = await tel.lokiRange(`${cfg.sources.logs.selector} ${cfg.sources.logs.error_filter}`, new Date(now.getTime() - 15 * 60_000), now, 5);
      const keys = new Set(lines.flatMap((l) => Object.keys(l.labels)));
      console.log(`\nLoki: ${lines.length} error line(s) in 15 min sample; stream labels: ${[...keys].sort().join(', ') || '-'}`);
      if (lines.length && !keys.has(cfg.sources.logs.service_label)) console.log(`  MISSING service label "${cfg.sources.logs.service_label}"`);
    } catch (e) {
      console.log(`\nLoki: ERROR ${(e as Error).message}`);
    }
  } else console.log('\nLoki: not configured');
  if (tel.has.tempo) {
    try {
      const hits = await tel.tempoSearch(cfg.sources.traces.traceql, new Date(now.getTime() - 15 * 60_000), now, 5);
      console.log(`Tempo: ${hits.length} hit(s); e.g. ${hits[0] ? `${hits[0].rootService} ${hits[0].rootName}` : '-'}`);
    } catch (e) {
      console.log(`Tempo: ERROR ${(e as Error).message}`);
    }
  } else console.log('Tempo: not configured');
  console.log(`\nLLM: ${cfg.llm.available ? 'credentials present' : 'no credentials (patrol runs without the investigator)'}`);
}

async function main() {
  const cmd = positionals[0];
  if (!cmd || a.help) {
    console.log(USAGE);
    return;
  }
  loadDotEnv();
  const cfg = loadConfig();
  const noise = Noise.load(cfg.noiseFile);
  const owners = Owners.load(cfg.ownersFile);
  const sink = new CardSink(cfg.outDir, cfg.slackWebhookUrl);
  const w = cfg.windowMinutes;

  switch (cmd) {
    case 'agents': {
      for (const ag of listAgents(cfg.agentsDir, cfg.memoryDir)) {
        const l = ag.spec.limits;
        console.log(`${ag.spec.name.padEnd(10)} @${ag.version}  ${ag.spec.model}  ${ag.spec.every ? `every ${ag.spec.every}m` : 'manual'}  tools: ${[...ag.spec.builtin_tools, ...(ag.spec.code ? [`${ag.spec.code} pack`] : []), ...(ag.spec.tool_pack ? [`${ag.spec.tool_pack} pack`] : [])].join(', ') || 'none'}  $${l.usd_per_run}/run $${l.usd_per_day}/day ${l.deadline_min}min  challenge: ${ag.spec.challenge.when}`);
        if (ag.spec.description) console.log(`           ${ag.spec.description}`);
      }
      return;
    }

    case 'run': {
      const name = positionals[1];
      if (!name) throw new Error('usage: run <agent> --task "<text>"');
      if (name === 'monitor') {
        const state = a.fresh ? State.memory() : State.load(cfg.stateFile);
        const r = await patrolOnce(telemetry(cfg), cfg, noise, state, sink, align(new Date(), w), { llm: true, post: a.post, log, owners }, monitorAgent(cfg));
        for (const c of r.cards) console.log(`card: ${c}`);
        return;
      }
      const agent = loadAgent(join(cfg.agentsDir, name), cfg.memoryDir);
      if (agent.spec.code) throw new Error(`${name} is driven by its own code; use its command`);
      if (!a.task) throw new Error('--task is required');
      const needsPath = agent.spec.builtin_tools.some((t) => t === 'Read' || t === 'Grep' || t === 'Glob');
      if (needsPath && !a.path) throw new Error(`${name} reads local files: --path <dir> is required`);
      const roots = needsPath ? [{ path: resolve(a.path!), ...(a.ref ? { ref: a.ref } : {}) }] : undefined;
      const r = await runAgent(makeEngine(cfg), {
        agent,
        trigger: 'manual',
        task: a.task,
        output: findingsOutput,
        ...(a.challenge ? { challenge: true } : {}),
        ...(roots ? { roots } : {}),
      });
      log(`${r.runId}: ${r.status}, ${r.evidence.items.size} tool call(s), ${r.turns} turn(s), $${r.cost.toFixed(3)}${r.challenge ? `, challenge ${r.challenge.verdict}` : ''}${r.note ? ` (${r.note})` : ''}`);
      const md = writeAnswer(agent, r);
      if (md) console.log(md);
      if (r.dir) log(`run folder: ${r.dir}`);
      if (r.status !== 'ok') process.exitCode = 1;
      return;
    }

    case 'runs': {
      const store = new Store(join(cfg.runsDir, 'engine.db'));
      for (const r of store.recent(30, a.agent).reverse())
        console.log(
          `${r.started_at.slice(0, 19)}  ${r.agent.padEnd(10)} ${r.status.padEnd(9)} $${(r.cost ?? r.reserve).toFixed(3).padStart(6)}  ${String(r.turns ?? 0).padStart(3)} turns  ${r.outputs ?? 0} out  ${r.trigger}${r.challenge ? `  challenge ${r.challenge}` : ''}${r.note ? `  (${r.note})` : ''}  ${r.id}`,
        );
      const day = new Date().toISOString().slice(0, 10);
      console.log(`today: $${store.spent(day).toFixed(2)} of $${cfg.llm.dailyCapUsd} daily cap · this month: $${store.spent(day.slice(0, 7)).toFixed(2)} of $${cfg.llm.monthlyCapUsd} (running runs count their reservation)`);
      return;
    }

    case 'stop': {
      mkdirSync(cfg.runsDir, { recursive: true });
      writeFileSync(join(cfg.runsDir, 'STOP'), new Date().toISOString() + '\n');
      console.log('STOP file written: running agents stop at their next step; new runs are skipped until `resume`.');
      return;
    }

    case 'user': {
      const users = Users.load(cfg.mcp.usersFile);
      const sub = positionals[1];
      if (sub === 'list') {
        for (const u of users.list()) {
          const exp = expiresAt(u);
          const state = !u.token_sha256 ? 'keycloak' : exp > Date.now() ? `expires ${new Date(exp).toISOString().slice(0, 10)}` : 'EXPIRED';
          console.log(`${u.name.padEnd(16)} ${u.role.padEnd(6)} ${u.slack_id ?? '-'}  $${u.usd_per_day ?? cfg.mcp.userDailyCapUsd}/day  ${state}  ${u.email ?? ''}`);
        }
        return;
      }
      const name = positionals[2];
      if (!name) throw new Error('usage: user add|remove|promote|demote <name>, user invite <email>');
      if (sub === 'remove') {
        console.log(users.remove(name) ? `${name} removed; they lose access on their next request` : `no user ${name}`);
        return;
      }
      if (sub === 'invite') {
        const u = users.invite(name, { admin: a.admin });
        console.log(`${u.email} invited as ${u.role} (user ${u.name}); they sign in with their company account`);
        return;
      }
      if (sub === 'promote' || sub === 'demote') {
        const role = sub === 'promote' ? 'admin' : 'member';
        console.log(users.setRole(name, role) ? `${name} is now ${role}` : `no user ${name} (invite them first)`);
        return;
      }
      if (sub !== 'add') throw new Error('usage: user add|list|remove|invite|promote|demote');
      // Hosted, people sign in through Keycloak; the CLI can't mint a token there.
      if (cfg.mcp.login) throw new Error('the Keycloak sign-in is on: `user invite <email>` instead; then `user promote <name>` for admins');
      const usd = a.usd ? Number(a.usd) : undefined;
      if (usd !== undefined && !(usd > 0)) throw new Error('--usd must be a positive number');
      const days = a.days ? Number(a.days) : undefined;
      const token = users.add(name, { admin: a.admin, ...(a.slack ? { slackId: a.slack } : {}), ...(usd ? { usdPerDay: usd } : {}), ...(days ? { days } : {}), ...(a.email ? { email: a.email.toLowerCase() } : {}) });
      console.error(`${name} added (${a.admin ? 'admin' : 'member'}, expires in ${days ?? MAX_TOKEN_DAYS} days). Give them this token; it is not stored and won't be shown again:`);
      console.log(token);
      return;
    }

    case 'serve':
    case 'mcp-stdio': {
      const users = Users.load(cfg.mcp.usersFile);
      const ctx: McpContext = {
        cfg,
        engine: makeEngine(cfg),
        users,
        repos: loadRepos(cfg.mcp.reposFile, cfg.mcp.reposDir, cfg.mcp.reposGithub),
        ...(cfg.mcp.login ? { login: new Login(cfg.mcp.login) } : {}),
        ...(cfg.mcp.notifySlack && cfg.slackWebhookUrl ? { notify: slackNotifier(cfg.slackWebhookUrl) } : {}),
        ...((): { telemetry?: Telemetry } => {
          // For agents with tool_pack: telemetry (questions about production).
          try {
            return { telemetry: liveTelemetry(cfg) };
          } catch (e) {
            log(`no production telemetry for MCP agents: ${(e as Error).message}`);
            return {};
          }
        })(),
        log,
      };
      if (cmd === 'mcp-stdio') {
        const user = ctx.users.list().find((u) => u.name === a.as);
        if (!user) throw new Error('--as <user>: a user from `user list`');
        beforeExit = () => shutdown(ctx, 'engine shutting down', 20_000);
        await buildServer(ctx, user).connect(new StdioServerTransport());
        return;
      }
      const host = a.host ?? '127.0.0.1';
      const port = Number(a.port ?? 8787);
      // CLI tokens are for a developer's own machine. Anywhere reachable, only the Keycloak sign-in.
      if (!ctx.login && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error(`serving on ${host} needs the Keycloak sign-in (KEYCLOAK_ISSUER); CLI tokens are for loopback only`);
      if (!ctx.users.list().length && !ctx.login) throw new Error('no users yet: add one with `user add <name> --admin`, or configure the Keycloak sign-in');
      if (ctx.login) {
        // ENGINE_ADMINS seeds the first admins (as invites) only while the file has none.
        const seeded = ctx.users.seedAdmins(cfg.mcp.login!.admins);
        if (seeded.length) log(`seeded admins from ENGINE_ADMINS: ${seeded.join(', ')}`);
        if (!ctx.users.list().some((u) => u.role === 'admin')) throw new Error('the Keycloak sign-in is on but there is no admin to invite anyone: set ENGINE_ADMINS or `user invite <email> --admin`');
      }
      const server = startHttp(ctx, { host, port });
      beforeExit = () => (server.close(), shutdown(ctx, 'engine shutting down', 20_000));
      log(`MCP on http://${host}:${port}/mcp · sign-in ${ctx.login ? `Keycloak ${cfg.mcp.login!.issuer} (client ${cfg.mcp.login!.clientId})` : 'off (tokens from the CLI)'} · ${ctx.users.list().length} user(s) · ${ctx.repos.size} repo(s) · Slack notify ${ctx.notify ? 'on' : 'off'}`);
      if (!['127.0.0.1', '::1', 'localhost'].includes(host)) log('not loopback: put TLS in front of this; tokens travel in a header');
      const metrics = metricsServer(cfg);
      // Retention: hourly, and once at start.
      const clean = () => {
        try {
          const r = sweep({ runsDir: cfg.runsDir, outDir: cfg.outDir, days: cfg.retentionDays });
          if (r.runs || r.cards) log(`retention: deleted ${r.runs} run folder(s) and ${r.cards} card(s) older than ${cfg.retentionDays} days`);
        } catch (e) {
          log(`retention failed: ${(e as Error).message}`);
        }
      };
      clean();
      setInterval(clean, 3600_000).unref();
      if (cfg.mcp.githubApp) {
        // Clone/fetch the `github:` repos as the GitHub App, now and every 10 min.
        const app = cfg.mcp.githubApp;
        const tokens = new InstallationTokens({ appId: app.appId, installationId: app.installationId, privateKey: readFileSync(app.privateKeyFile, 'utf8') });
        const sync = new RepoSync(ctx.repos, { token: () => tokens.token(), log });
        sync.start();
        metrics?.repoSync(sync.state);
        log(`repo sync every 10 min: ${[...sync.state.keys()].join(', ') || 'no github repos'}`);
      }
      if (a.patrol) {
        log(`patrol every ${w} min in this process${a.llm ? ' with the investigator' : ''}`);
        void patrolEvery(cfg, noise, owners, sink, w, metrics);
      }
      await new Promise(() => {}); // until killed
      return;
    }

    case 'resume': {
      const f = join(cfg.runsDir, 'STOP');
      if (existsSync(f)) unlinkSync(f);
      console.log('STOP file removed.');
      return;
    }

    case 'doctor':
      return doctor(cfg);

    case 'patrol': {
      const state = a.fresh ? State.memory() : State.load(cfg.stateFile);
      const at = align(a.at ? date(a.at, 'at') : new Date(), w);
      const r = await patrolOnce(telemetry(cfg), cfg, noise, state, sink, at, { llm: a.llm, post: a.post, log, owners }, a.llm ? monitorAgent(cfg) : undefined);
      for (const row of r.summary.send) console.log(rowLine(row));
      for (const c of r.cards) console.log(`card: ${c}`);
      return;
    }

    case 'loop': {
      const metrics = metricsServer(cfg);
      if (a.port) startHealth({ host: a.host ?? '127.0.0.1', port: Number(a.port) });
      return void (await patrolEvery(cfg, noise, owners, sink, w, metrics));
    }

    case 'export': {
      const from = align(date(a.from, 'from'), w);
      const to = date(a.to, 'to');
      const step = Number(a.step ?? w);
      const dir = resolve(a.out ?? join('data', `export-${from.toISOString().slice(0, 13)}`));
      const tel = new RecordingTelemetry(liveTelemetry(cfg), dir);
      const state = State.memory();
      const quietSink = new CardSink(join(dir, 'out'));
      const exportCfg = { ...cfg, outDir: join(dir, 'out') };
      writeFileSync(join(dir, 'export.json'), JSON.stringify({ from, to, stepMinutes: step, windowMinutes: w, sources: cfg.sources, createdAt: new Date() }, null, 1));
      for (let t = from; t <= to; t = new Date(t.getTime() + step * 60_000)) {
        try {
          await patrolOnce(tel, exportCfg, noise, state, quietSink, t, { llm: false, post: false, log });
        } catch (e) {
          log(`${t.toISOString()} failed: ${(e as Error).message}`);
        }
      }
      // Raw context beyond the patrol queries, for later analysis once retention drops it:
      // every family at 5-min resolution, and error log lines per hour (redacted).
      const H = 3600_000;
      for (let s = from.getTime(); s < to.getTime(); s += 6 * H) {
        const e = new Date(Math.min(s + 6 * H, to.getTime()));
        for (const f of cfg.sources.http_families)
          await tel.promRange(httpQuery(f, 5), new Date(s), e, 300).catch((err) => log(`raw ${f.id}: ${(err as Error).message}`));
      }
      if (tel.has.loki)
        for (let s = from.getTime(); s < to.getTime(); s += H)
          await tel
            .lokiRange(`${cfg.sources.logs.selector} ${cfg.sources.logs.error_filter}`, new Date(s), new Date(s + H), 5000)
            .catch((err) => log(`raw logs: ${(err as Error).message}`));
      log(`recorded into ${dir}`);
      return;
    }

    case 'replay': {
      const from = align(date(a.from, 'from'), w);
      const to = date(a.to, 'to');
      const step = Number(a.step ?? w);
      const tel = telemetry(cfg);
      const state = State.memory();
      const outDir = resolve(cfg.outDir, `replay-${from.toISOString().slice(0, 16).replace(/:/g, '')}`);
      mkdirSync(outDir, { recursive: true });
      const replayCfg = { ...cfg, outDir };
      // Replayed investigations write their run folders next to the replay, but
      // share the store and STOP file: real money, same caps, same kill switch.
      const monitor = a.llm ? { engine: makeEngine(cfg, join(outDir, 'runs')), agent: loadAgent(join(cfg.agentsDir, 'monitor'), cfg.memoryDir) } : undefined;
      const timeline: string[] = [`# Replay ${from.toISOString()} → ${to.toISOString()} (step ${step} min, window ${w} min)`, ''];
      for (let t = from; t <= to; t = new Date(t.getTime() + step * 60_000)) {
        const r = await patrolOnce(tel, replayCfg, noise, state, new CardSink(outDir), t, { llm: a.llm, post: false, trigger: 'replay', log, owners }, monitor);
        const down = r.summary.sources.filter((s) => !s.ok).map((s) => s.source);
        timeline.push(`## ${t.toISOString()}  send ${r.summary.send.length} · known ${r.summary.known.length} · recovered ${r.summary.recovered.length}${down.length ? ` · blind: ${down.join(', ')}` : ''}`);
        for (const row of r.summary.send) timeline.push(`- ${rowLine(row)}`);
        if (r.investigation) timeline.push(`- investigator: ${r.investigation.status}, ${r.investigation.outputs.length} report(s), $${r.investigation.cost.toFixed(2)}${r.investigation.challenge ? `, challenge ${r.investigation.challenge.verdict}` : ''}`);
      }
      writeFileSync(join(outDir, 'timeline.md'), timeline.join('\n') + '\n');
      console.log(timeline.join('\n'));
      log(`timeline: ${join(outDir, 'timeline.md')}`);
      if (tel instanceof ReplayTelemetry && tel.misses) log(`${tel.misses} query(ies) were not in the recording`);
      return;
    }

    default:
      console.log(USAGE);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
