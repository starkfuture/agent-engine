import { appendFileSync, existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { FILE_TOOLS, listAgents, loadAgent, type LoadedAgent } from '../engine/agent.js';
import { writeAnswer } from '../engine/answer.js';
import { findingsOutput, type Findings } from '../engine/output.js';
import { runAgent, type Engine, type RunResult } from '../engine/run.js';
import { cleanModelText, redact, safeJson, truncate } from '../engine/text.js';
import type { User, Users } from './users.js';

// The engine over MCP, for several developers. One process holds the engine:
// budgets, run history and the kill switch stay in one place; people connect
// with their own token. Runs start in the background; the caller gets a run id
// right away and a Slack mention when it ends.

export interface McpContext {
  cfg: Config;
  engine: Engine;
  users: Users;
  repos: Map<string, string>;
  notify?: (text: string) => Promise<void>; // Slack; absent = no notifications
  log?: (s: string) => void;
}

interface Active {
  agent: string;
  user: string;
  controller: AbortController;
  done: Promise<Finished>;
}
interface Finished {
  result?: RunResult<Findings>;
  answer?: string;
  error?: string;
}

// Runs in flight, for wait and cancel. Kept per context (one per process).
const ACTIVE = new WeakMap<McpContext, Map<string, Active>>();
const active = (ctx: McpContext) => ACTIVE.get(ctx) ?? (ACTIVE.set(ctx, new Map()), ACTIVE.get(ctx)!);

const RUN_ID = /^\d{8}T\d{6}Z-[a-z][a-z0-9-]*-[0-9a-f]{6}$/;
const EV_ID = /^E-[0-9a-f]{4}-\d+$/;
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const err = (t: string) => ({ content: [{ type: 'text' as const, text: `error: ${t}` }], isError: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

function agentByName(ctx: McpContext, name: string): LoadedAgent | undefined {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return undefined;
  const dir = join(ctx.cfg.agentsDir, name);
  return existsSync(join(dir, 'agent.yaml')) ? loadAgent(dir) : undefined;
}

function summary(r: RunResult<Findings>): string {
  return [
    `run ${r.runId}: ${r.status}`,
    `cost $${r.cost.toFixed(3)} · ${r.turns} turns · ${r.evidence.items.size} tool results`,
    ...(r.challenge ? [`challenge: ${r.challenge.verdict}${r.challenge.note ? ` (${r.challenge.note})` : ''}`] : []),
    ...(r.note ? [`note: ${redact(r.note)}`] : []),
  ].join('\n');
}

function runFolder(ctx: McpContext, agent: string, id: string): string {
  return join(ctx.engine.runsDir, agent, id);
}

export function buildServer(ctx: McpContext, user: User): McpServer {
  const s = new McpServer({ name: 'agent-engine', version: '0.3.0' });
  const admin = user.role === 'admin';
  const runs = active(ctx);

  s.registerTool(
    'list_agents',
    { description: 'Agents you can give tasks to, with their tools, limits and whether they need a repo.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () =>
      text(
        listAgents(ctx.cfg.agentsDir)
          .map((a) => {
            const l = a.spec.limits;
            const needsRepo = a.spec.builtin_tools.some((t) => (FILE_TOOLS as readonly string[]).includes(t));
            return [
              `${a.spec.name} @${a.version}${a.spec.code ? ' (scheduled; not runnable here)' : ''}`,
              `  ${a.spec.description}`,
              `  model ${a.spec.model} · tools ${[...a.spec.builtin_tools, ...(a.spec.code ? [`${a.spec.code} pack`] : [])].join(', ') || 'none'} · $${l.usd_per_run}/run · ${l.deadline_min} min · up to ${a.spec.concurrency} at once${needsRepo ? ' · needs repo' : ''} · challenge ${a.spec.challenge.when}`,
            ].join('\n');
          })
          .join('\n\n'),
      ),
  );

  s.registerTool(
    'list_repos',
    { description: 'Repos the codebase agent can read on the engine host (pass one as `repo` to run_agent).', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => text([...ctx.repos.keys()].join('\n') || 'no repos configured on this host'),
  );

  s.registerTool(
    'run_agent',
    {
      description:
        'Give an agent a task. Starts in the background and returns a run id; use get_run to read the answer (you also get a Slack mention when it ends, if configured). Pass wait_seconds (max 55) to wait for short runs.',
      inputSchema: {
        agent: z.string().describe('Agent name from list_agents'),
        task: z.string().min(10).max(4000).describe('What to find out. Be specific; the agent answers with cited evidence.'),
        repo: z.string().optional().describe('For agents that read code: a name from list_repos'),
        challenge: z.boolean().optional().describe('Have an independent challenger check the answer (costs more, takes longer)'),
        wait_seconds: z.number().int().min(0).max(55).optional(),
      },
    },
    async ({ agent: name, task, repo, challenge, wait_seconds }) => {
      const agent = agentByName(ctx, name);
      if (!agent) return err(`no agent "${name}"; see list_agents`);
      if (agent.spec.code) return err(`${name} runs on its schedule and can't be started here; read its runs with list_runs`);
      const needsRepo = agent.spec.builtin_tools.some((t) => (FILE_TOOLS as readonly string[]).includes(t));
      let roots: string[] | undefined;
      if (needsRepo) {
        const path = repo ? ctx.repos.get(repo) : undefined;
        if (!path) return err(`${name} needs repo: one of ${[...ctx.repos.keys()].join(', ') || '(none configured)'}`);
        roots = [path];
      } else if (repo) return err(`${name} doesn't read code; drop repo`);

      const controller = new AbortController();
      let admittedId: string | undefined;
      let onAdmitted!: (id: string) => void;
      const admitted = new Promise<string>((res) => (onAdmitted = res));
      const done: Promise<Finished> = runAgent(ctx.engine, {
        agent,
        trigger: `mcp:${user.name}`,
        task,
        output: findingsOutput,
        ...(challenge ? { challenge: true } : {}),
        ...(roots ? { roots } : {}),
        user: { name: user.name, usdPerDay: user.usd_per_day ?? ctx.cfg.mcp.userDailyCapUsd, maxRunning: ctx.cfg.mcp.userMaxRunning },
        signal: controller.signal,
        onAdmitted: (id) => {
          admittedId = id;
          onAdmitted(id);
        },
      })
        .then((result): Finished => ({ result, answer: writeAnswer(agent, result) }))
        .catch((e: Error): Finished => ({ error: e.message.slice(0, 300) }))
        .then(async (f: Finished) => {
          if (admittedId) {
            runs.delete(admittedId);
            ctx.log?.(`${admittedId} ${f.result?.status ?? 'error'} for ${user.name}`);
            if (ctx.notify && f.result)
              await ctx
                .notify(
                  `${user.slack_id ? `<@${user.slack_id}> ` : ''}${name} run ${f.result.status}${f.result.challenge ? ` · challenge ${f.result.challenge.verdict}` : ''} · $${f.result.cost.toFixed(2)}${f.result.outputs[0] ? ` · ${truncate(cleanModelText(redact(f.result.outputs[0].title)), 150)}` : ''}\nget_run ${admittedId}`,
                )
                .catch((e: Error) => ctx.log?.(`notify failed: ${e.message}`));
          }
          return f;
        });

      const first = await Promise.race([admitted.then((id) => ({ id })), done.then((f) => ({ f }))]);
      if ('f' in first) {
        // Never admitted: skipped (caps, busy, STOP) or a configuration error.
        if (first.f.error) return err(first.f.error);
        return text(`${summary(first.f.result!)}\nnot started.`);
      }
      runs.set(first.id, { agent: name, user: user.name, controller, done });
      if (wait_seconds) {
        const f = await Promise.race([done, sleep(wait_seconds * 1000).then(() => undefined)]);
        if (f?.result) return text(`${summary(f.result)}\n\n${f.answer ?? '(no answer submitted)'}`);
        if (f?.error) return err(f.error);
      }
      return text(`run ${first.id}: running. Read it with get_run; cancel with cancel_run.`);
    },
  );

  s.registerTool(
    'get_run',
    { description: 'Status, cost, challenge verdict and the answer of one run.', inputSchema: { run_id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ run_id }) => {
      if (!RUN_ID.test(run_id)) return err('not a run id');
      const row = ctx.engine.store.get(run_id);
      if (!row) return err(`no run ${run_id}`);
      const dir = runFolder(ctx, row.agent, row.id);
      const answer = existsSync(join(dir, 'answer.md')) ? readFileSync(join(dir, 'answer.md'), 'utf8') : '';
      let challenge = '';
      if (existsSync(join(dir, 'challenge.json'))) {
        const c = JSON.parse(readFileSync(join(dir, 'challenge.json'), 'utf8')) as { verdict: string; overall: string; notes: Array<{ claim: string }> };
        challenge = `\n## Challenge: ${c.verdict}\n${c.overall}${c.notes.length ? `\nNotes:\n${c.notes.map((n) => `- ${n.claim}`).join('\n')}` : ''}`;
      }
      const head = [
        `run ${row.id} · ${row.agent}@${row.version} · ${row.status}${row.status === 'running' ? ` (deadline ${row.deadline_at})` : ''}`,
        `asked by ${row.requested_by ?? row.trigger} at ${row.started_at} · cost $${(row.cost ?? row.reserve).toFixed(3)}${row.status === 'running' ? ' reserved' : ''} · ${row.turns ?? 0} turns`,
        ...(row.note ? [`note: ${redact(row.note)}`] : []),
      ].join('\n');
      return text(`${head}\n\n${answer || (row.status === 'running' ? '(still running)' : '(no answer)')}${challenge}`);
    },
  );

  s.registerTool(
    'get_evidence',
    { description: 'The full tool result behind an evidence id cited in a run (redacted).', inputSchema: { run_id: z.string(), evidence_id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ run_id, evidence_id }) => {
      if (!RUN_ID.test(run_id) || !EV_ID.test(evidence_id)) return err('bad id');
      const row = ctx.engine.store.get(run_id);
      if (!row) return err(`no run ${run_id}`);
      const file = join(runFolder(ctx, row.agent, row.id), 'evidence.jsonl');
      if (!existsSync(file)) return err('no evidence recorded for this run');
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as { id: string; by: string; tool: string; args: unknown; text: string };
        if (e.id === evidence_id) return text(`${e.id} · ${e.tool} by ${e.by}\nargs: ${safeJson(e.args)}\n\n${e.text}`);
      }
      return err(`no ${evidence_id} in ${run_id}`);
    },
  );

  s.registerTool(
    'list_runs',
    {
      description: 'Recent runs, newest first.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional(), agent: z.string().optional(), mine: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, agent, mine }) => {
      const rows = ctx.engine.store.recent(limit ?? 20, { ...(agent ? { agent } : {}), ...(mine ? { user: user.name } : {}) });
      return text(
        rows
          .map(
            (r) =>
              `${r.started_at.slice(0, 16)}Z  ${r.agent.padEnd(9)} ${r.status.padEnd(9)} $${(r.cost ?? r.reserve).toFixed(2).padStart(5)}  ${(r.requested_by ?? r.trigger).padEnd(10)} ${r.challenge ? `challenge ${r.challenge} ` : ''}${r.note ? `(${truncate(redact(r.note), 80)}) ` : ''}${r.id}`,
          )
          .join('\n') || 'no runs',
      );
    },
  );

  s.registerTool(
    'cancel_run',
    { description: 'Stop one of your running runs (admins: any run).', inputSchema: { run_id: z.string() } },
    async ({ run_id }) => {
      const a = runs.get(run_id);
      if (!a) return err(`${run_id} is not running in this server`);
      if (a.user !== user.name && !admin) return err('you can only cancel your own runs');
      a.controller.abort(`cancelled by ${user.name}`);
      const f = await Promise.race([a.done, sleep(15_000).then(() => undefined)]);
      return text(f?.result ? summary(f.result) : `cancel sent to ${run_id}`);
    },
  );

  s.registerTool(
    'spend',
    { description: 'Spend today and this month against the caps, by agent, and yours.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const st = ctx.engine.store;
      const d = today();
      const agents = listAgents(ctx.cfg.agentsDir).map((a) => `  ${a.spec.name.padEnd(9)} $${st.spent(d, a.spec.name).toFixed(2)} of $${a.spec.limits.usd_per_day}`);
      return text(
        [
          `today: $${st.spent(d).toFixed(2)} of $${ctx.engine.dailyCapUsd} · this month: $${st.spent(d.slice(0, 7)).toFixed(2)} of $${ctx.engine.monthlyCapUsd ?? '∞'}`,
          `you today: $${st.spent(d, undefined, user.name).toFixed(2)} of $${user.usd_per_day ?? ctx.cfg.mcp.userDailyCapUsd}`,
          'by agent today:',
          ...agents,
          existsSync(ctx.engine.stopFile) ? 'STOP is set: new runs are skipped.' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  );

  s.registerTool(
    'proposed_lessons',
    { description: 'Lessons runs proposed for an agent, waiting for an admin to approve.', inputSchema: { agent: z.string() }, annotations: { readOnlyHint: true } },
    async ({ agent }) => {
      const a = agentByName(ctx, agent);
      if (!a) return err(`no agent "${agent}"`);
      const f = join(a.dir, 'memory', 'proposed.md');
      return text(existsSync(f) ? readFileSync(f, 'utf8') : 'none');
    },
  );

  if (admin) {
    s.registerTool(
      'approve_lesson',
      { description: 'Admin: add one lesson to an agent’s lessons.md (its system prompt). Changes the agent version.', inputSchema: { agent: z.string(), lesson: z.string().min(10).max(500) } },
      async ({ agent, lesson }) => {
        const a = agentByName(ctx, agent);
        if (!a) return err(`no agent "${agent}"`);
        const line = redact(lesson.replace(/\s+/g, ' ').trim());
        mkdirSync(join(a.dir, 'memory'), { recursive: true });
        appendFileSync(join(a.dir, 'memory', 'lessons.md'), `- ${line} (approved by ${user.name}, ${today()})\n`);
        return text(`added to ${agent}/memory/lessons.md; the next run uses it`);
      },
    );
    s.registerTool(
      'stop_all',
      { description: 'Admin: kill switch. Running agents stop at their next step; new runs are skipped until resume.', inputSchema: { reason: z.string().min(3).max(200) } },
      async ({ reason }) => {
        mkdirSync(ctx.cfg.runsDir, { recursive: true });
        writeFileSync(ctx.engine.stopFile, `${new Date().toISOString()} ${user.name}: ${reason.replace(/\s+/g, ' ')}\n`);
        for (const r of runs.values()) r.controller.abort(`stop_all by ${user.name}`);
        return text(`STOP set; ${runs.size} run(s) in this server told to stop now`);
      },
    );
    s.registerTool('resume', { description: 'Admin: clear the kill switch.', inputSchema: {} }, async () => {
      if (existsSync(ctx.engine.stopFile)) unlinkSync(ctx.engine.stopFile);
      return text('STOP cleared');
    });
  }
  return s;
}

// Slack incoming webhook. Text only, no link unfurls.
export function slackNotifier(webhook: string): (t: string) => Promise<void> {
  return async (t) => {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: t, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Slack webhook: HTTP ${res.status}`);
  };
}

const MAX_BODY = 1_000_000;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

// Streamable HTTP, stateless: each POST gets a fresh server bound to the
// caller's identity. Bearer token per person. On a loopback bind the Host
// header must be local too (DNS rebinding); anywhere else put TLS in front.
export function startHttp(ctx: McpContext, opts: { host: string; port: number }): Server {
  const local = LOOPBACK.has(opts.host);
  const server = createServer(async (req, res) => {
    const send = (code: number, msg: string, headers: Record<string, string> = {}) => {
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: msg }, id: null }));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/healthz') return void res.writeHead(200).end('ok');
      if (url.pathname !== '/mcp') return send(404, 'not found');
      if (local && !LOOPBACK.has((req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, ''))) return send(403, 'bad host');
      const auth = req.headers.authorization ?? '';
      const user = ctx.users.authenticate(auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined);
      if (!user) return send(401, 'missing or unknown token', { 'www-authenticate': 'Bearer' });
      if (req.method !== 'POST') return send(405, 'stateless server: POST only', { allow: 'POST' });
      const parsed = await body(req);
      const mcp = buildServer(ctx, user);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (e) {
      const status = (e as { status?: number }).status ?? (e instanceof SyntaxError ? 400 : 500);
      ctx.log?.(`http ${status}: ${(e as Error).message}`);
      send(status, status === 500 ? 'internal error' : (e as Error).message);
    }
  });
  server.listen(opts.port, opts.host);
  return server;
}
