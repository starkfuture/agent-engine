import { appendFileSync, existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { FILE_TOOLS, listAgents, loadAgent, type LoadedAgent } from '../engine/agent.js';
import { monitorReports, storedMonitorAnswer, writeAnswer } from '../engine/answer.js';
import { itemDissent } from '../engine/challenge.js';
import { findingsOutput, type Findings } from '../engine/output.js';
import { runAgent, type Engine, type Root, type RunResult } from '../engine/run.js';
import { cleanModelText, redact, safeJson, slackEscape, stripImages, truncate } from '../engine/text.js';
import type { RunRow } from '../engine/store.js';
import type { Telemetry } from '../clients/telemetry.js';
import { monitorTools } from '../investigate/tools.js';
import { deployLines, deploysHeading, listDeploys, workloadFor } from '../patrol/deploys.js';
import { METADATA_PATH, Refused, serverName, type Login } from './login.js';
import { progressBlock, progressLine, progressNotifier, runProgress } from './progress.js';
import { expiresAt, type User, type Users } from './users.js';
import type { Issues } from '../patrol/issues.js';

// The engine over MCP, for several developers. One process holds the engine:
// budgets, run history and the kill switch stay in one place; people connect
// with their own identity. Runs start in the background; the caller gets a run id
// right away and a Slack mention when it ends.

export interface McpContext {
  cfg: Config;
  engine: Engine;
  users: Users;
  repos: Map<string, Root>;
  notify?: (text: string) => Promise<void>; // Slack; absent = no notifications
  login?: Login; // Keycloak sign-in; absent = tokens only from the CLI
  log?: (s: string) => void;
  telemetry?: Telemetry; // production metrics/logs/traces, for agents with tool_pack: telemetry
  issues?: Issues; // the monitor's issue record, for noise_candidates
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
// Under Claude Code's default limit on one tool result (25k tokens).
export const EXPORT_PART = 60_000;
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const err = (t: string) => ({ content: [{ type: 'text' as const, text: `error: ${t}` }], isError: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

// Agents this server offers: all, or the ENGINE_AGENTS list.
const served = (ctx: McpContext, name: string) => !ctx.cfg.mcp.agents || ctx.cfg.mcp.agents.includes(name);
const agentsHere = (ctx: McpContext) => listAgents(ctx.cfg.agentsDir, ctx.cfg.memoryDir).filter((a) => served(ctx, a.spec.name));

function agentByName(ctx: McpContext, name: string): LoadedAgent | undefined {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || !served(ctx, name)) return undefined;
  const dir = join(ctx.cfg.agentsDir, name);
  return existsSync(join(dir, 'agent.yaml')) ? loadAgent(dir, ctx.cfg.memoryDir) : undefined;
}

// Agents whose runs every user may read (visibility: everyone). The rest are
// readable by the requester and admins only. An agent that can't be loaded
// counts as private.
function sharedAgents(ctx: McpContext): Set<string> {
  return new Set(agentsHere(ctx).filter((a) => a.spec.visibility === 'everyone').map((a) => a.spec.name));
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
  // Someone else's private run answers like a missing one: its id reveals nothing.
  const readable = (row: RunRow | undefined): row is RunRow => !!row && (admin || row.requested_by === user.name || sharedAgents(ctx).has(row.agent));

  s.registerTool(
    'list_agents',
    { description: 'Agents you can give tasks to, with their tools, limits and whether they need a repo.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () =>
      text(
        agentsHere(ctx)
          .map((a) => {
            const l = a.spec.limits;
            const needsRepo = a.spec.builtin_tools.some((t) => (FILE_TOOLS as readonly string[]).includes(t));
            return [
              `${a.spec.name} @${a.version}${a.spec.code ? ' (scheduled; not runnable here)' : ''}`,
              `  ${a.spec.description}`,
              `  model ${a.spec.model} · tools ${[...a.spec.builtin_tools, ...(a.spec.code ? [`${a.spec.code} pack`] : []), ...(a.spec.tool_pack ? [`${a.spec.tool_pack} pack`] : [])].join(', ') || 'none'} · $${l.usd_per_run}/run · ${l.deadline_min} min · up to ${a.spec.concurrency} at once${needsRepo ? ' · needs repo' : ''} · challenge ${a.spec.challenge.when}`,
            ].join('\n');
          })
          .join('\n\n'),
      ),
  );

  s.registerTool(
    'list_repos',
    { description: 'Repos the codebase agent can read on the engine host (pass one as `repo` to run_agent), with the ref each is read at.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => text([...ctx.repos].map(([n, r]) => `${n} (at ${r.ref ?? 'origin/HEAD, else HEAD'})`).join('\n') || 'no repos configured on this host'),
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
    async ({ agent: name, task, repo, challenge, wait_seconds }, extra) => {
      const agent = agentByName(ctx, name);
      if (!agent) return err(`no agent "${name}"; see list_agents`);
      if (agent.spec.code) return err(`${name} runs on its schedule and can't be started here; read its runs with list_runs`);
      if (agent.spec.tool_pack === 'telemetry' && !ctx.telemetry) return err(`${name} needs production telemetry, which this engine is not configured to read`);
      const packTools = agent.spec.tool_pack === 'telemetry' ? monitorTools(ctx.telemetry!, ctx.cfg, new Date()) : undefined;
      const needsRepo = agent.spec.builtin_tools.some((t) => (FILE_TOOLS as readonly string[]).includes(t));
      let roots: Root[] | undefined;
      if (needsRepo) {
        const root = repo ? ctx.repos.get(repo) : undefined;
        if (!root) return err(`${name} needs repo: one of ${[...ctx.repos.keys()].join(', ') || '(none configured)'}`);
        roots = [root];
      } else if (repo) return err(`${name} doesn't read code; drop repo`);

      const controller = new AbortController();
      let admittedId: string | undefined;
      let onAdmitted!: (id: string) => void;
      const admitted = new Promise<string>((res) => (onAdmitted = res));
      const done: Promise<Finished> = runAgent(ctx.engine, {
        agent,
        trigger: `mcp:${user.name}`,
        task,
        ...(packTools ? { tools: packTools } : {}),
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
              // Model text is escaped: <!channel>, <@U…> or <url|label> in a title must not act in Slack.
              await ctx
                .notify(
                  `${user.slack_id ? `<@${user.slack_id}> ` : ''}${name} run ${f.result.status}${f.result.challenge ? ` · challenge ${f.result.challenge.verdict}` : ''} · $${f.result.cost.toFixed(2)}${f.result.outputs[0] ? ` · ${slackEscape(truncate(cleanModelText(redact(f.result.outputs[0].title)), 150))}` : ''}\nget_run ${admittedId}`,
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
        const dir = runFolder(ctx, name, first.id);
        const startedAt = ctx.engine.store.get(first.id)?.started_at ?? new Date().toISOString();
        const stopProgress = progressNotifier(extra, () => progressLine(name, first.id, runProgress(dir), startedAt, new Date()));
        const f = await Promise.race([done, sleep(wait_seconds * 1000).then(() => undefined)]).finally(stopProgress);
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
      if (!readable(row)) return err(`no run ${run_id}`);
      const dir = runFolder(ctx, row.agent, row.id);
      // A monitor run answers with its reports. Runs from before answer.md was
      // written show them from output.json. Nothing links a run to its Slack
      // posts yet, so whether they went out is unknown.
      const reports = monitorReports(dir);
      const answer = existsSync(join(dir, 'answer.md')) ? readFileSync(join(dir, 'answer.md'), 'utf8') : reports ? storedMonitorAnswer(dir, row, reports) : '';
      let challenge = '';
      if (existsSync(join(dir, 'challenge.json'))) {
        try {
          const c = JSON.parse(readFileSync(join(dir, 'challenge.json'), 'utf8')) as { verdict: string; overall: string; notes?: Array<{ claim: string }>; items?: Parameters<typeof itemDissent>[0] };
          const dissent = itemDissent(c.items);
          challenge = stripImages(redact(`\n## Challenge: ${c.verdict}\n${c.overall}${dissent.length ? `\n${dissent.join('\n')}` : ''}${c.notes?.length ? `\nNotes:\n${c.notes.map((n) => `- ${n.claim}`).join('\n')}` : ''}`));
        } catch {
          challenge = '\n## Challenge: unreadable\nThe challenge record could not be read: do not treat this run as upheld.';
        }
      }
      const head = [
        `run ${row.id} · ${row.agent}@${row.version} · ${row.status}${row.status === 'running' ? ` (deadline ${row.deadline_at})` : ''}`,
        `asked by ${row.requested_by ?? row.trigger} at ${row.started_at} · engine ${row.build ?? 'unknown'} · cost $${(row.cost ?? row.reserve).toFixed(3)}${row.status === 'running' ? ' reserved' : ''} · ${row.turns ?? 0} turns`,
        ...(reports ? ['Slack delivery: unknown (a run is not linked to its posts yet)'] : []),
        ...(row.note ? [`note: ${redact(row.note)}`] : []),
      ].join('\n');
      return text(`${head}\n\n${answer || (row.status === 'running' ? progressBlock(runProgress(dir), row.started_at, new Date()) : '(no answer)')}${challenge}`);
    },
  );

  s.registerTool(
    'get_evidence',
    { description: 'The full tool result behind an evidence id cited in a run (redacted).', inputSchema: { run_id: z.string(), evidence_id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ run_id, evidence_id }) => {
      if (!RUN_ID.test(run_id) || !EV_ID.test(evidence_id)) return err('bad id');
      const row = ctx.engine.store.get(run_id);
      if (!readable(row)) return err(`no run ${run_id}`);
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
      description: 'Recent runs you can read, newest first.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional(), agent: z.string().optional(), mine: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, agent, mine }) => {
      const rows = ctx.engine.store.recent(limit ?? 20, {
        ...(agent ? { agent } : {}),
        ...(mine ? { user: user.name } : {}),
        ...(admin ? {} : { visibleTo: { user: user.name, agents: [...sharedAgents(ctx)] } }),
      });
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
      const here = agentsHere(ctx);
      const agents = here.map((a) => `  ${a.spec.name.padEnd(9)} $${st.spent(d, a.spec.name).toFixed(2)} of $${a.spec.limits.usd_per_day}`);
      // An agent's monthly share (the monitor's): what it leaves of the monthly cap is kept for people.
      const month = ctx.engine.monthlyCapUsd;
      const shares = here.flatMap((a) => {
        const cap = ctx.engine.agentMonthlyCapUsd?.[a.spec.name];
        if (cap === undefined) return [];
        const kept = month !== undefined && month > cap ? ` (the other $${month - cap} of $${month} is kept for people)` : '';
        return [`${a.spec.name} $${st.spent(d.slice(0, 7), a.spec.name).toFixed(2)} of $${cap} this month${kept}`];
      });
      return text(
        [
          `today: $${st.spent(d).toFixed(2)} of $${ctx.engine.dailyCapUsd} · this month: $${st.spent(d.slice(0, 7)).toFixed(2)} of $${ctx.engine.monthlyCapUsd ?? '∞'}`,
          ...shares,
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
      if (a.spec.visibility !== 'everyone' && !admin) return err(`${agent}'s proposals come from private runs; admins only`);
      const f = join(a.memory, 'proposed.md');
      return text(existsSync(f) ? readFileSync(f, 'utf8') : 'none');
    },
  );

  // Code only: kube-state-metrics (and Argo CD when scraped), no AI run, no cost.
  if (ctx.telemetry)
    s.registerTool(
      'deploys',
      {
        description:
          'Deploys in the last N hours (new ReplicaSets; scaling is not a deploy): when, which workload, image old → new, and the rollout state (complete in N min, rolling, stalled, rolled back). Read-only, from kube-state-metrics: no AI run, no cost.',
        inputSchema: {
          hours: z.number().int().min(1).max(72).optional().describe('Default 6'),
          service: z.string().min(1).max(200).optional().describe('One Deployment, or a service name the patrol uses (keycloak, backend-production-mesh)'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ hours, service }) => {
        try {
          const src = ctx.cfg.sources;
          const d = await listDeploys(ctx.telemetry!, src, new Date(), hours ?? 6, service && workloadFor(service, src.deploys.aliases));
          return text(redact([`${deploysHeading(d)}${service ? ` for ${service}` : ''}:`, ...deployLines(d)].join('\n')));
        } catch (e) {
          return err(redact((e as Error).message).slice(0, 300));
        }
      },
    );

  if (admin) {
    // The identity was checked when the request arrived; an admin removed or
    // demoted since (or whose token was rotated, or whose name now belongs to
    // another email) must not finish an admin action.
    const notAdminNow = () => {
      const now = ctx.users.list().find((u) => u.name === user.name);
      return now?.role === 'admin' && now.token_sha256 === user.token_sha256 && now.email === user.email ? undefined : err('you are no longer an admin');
    };
    s.registerTool(
      'approve_lesson',
      { description: 'Admin: add one lesson to an agent’s lessons.md (its system prompt). Changes the agent version.', inputSchema: { agent: z.string(), lesson: z.string().min(10).max(500) } },
      async ({ agent, lesson }) => {
        const denied = notAdminNow();
        if (denied) return denied;
        const a = agentByName(ctx, agent);
        if (!a) return err(`no agent "${agent}"`);
        const line = redact(lesson.replace(/\s+/g, ' ').trim());
        mkdirSync(a.memory, { recursive: true });
        appendFileSync(join(a.memory, 'lessons.md'), `- ${line} (approved by ${user.name}, ${today()})\n`);
        return text(`added to ${agent}'s lessons; the next run uses it`);
      },
    );
    s.registerTool(
      'stop_all',
      { description: 'Admin: kill switch. Running agents stop at their next step; new runs are skipped until resume.', inputSchema: { reason: z.string().min(3).max(200) } },
      async ({ reason }) => {
        const denied = notAdminNow();
        if (denied) return denied;
        mkdirSync(ctx.cfg.runsDir, { recursive: true });
        writeFileSync(ctx.engine.stopFile, `${new Date().toISOString()} ${user.name}: ${reason.replace(/\s+/g, ' ')}\n`);
        for (const r of runs.values()) r.controller.abort(`stop_all by ${user.name}`);
        return text(`STOP set; ${runs.size} run(s) in this server told to stop now`);
      },
    );
    s.registerTool('resume', { description: 'Admin: clear the kill switch.', inputSchema: {} }, async () => {
      const denied = notAdminNow();
      if (denied) return denied;
      if (existsSync(ctx.engine.stopFile)) unlinkSync(ctx.engine.stopFile);
      return text('STOP cleared');
    });
    // Who may use the engine: only invited emails can sign in; nothing here
    // mints a token.
    s.registerTool(
      'invite_user',
      { description: 'Admin: let someone sign in with their company account. Nobody else can.', inputSchema: { email: z.string().email().max(200), admin: z.boolean().default(false) } },
      async ({ email, admin: asAdmin }) => {
        const denied = notAdminNow();
        if (denied) return denied;
        const domain = ctx.cfg.mcp.login?.domain;
        if (domain && !email.toLowerCase().endsWith(`@${domain}`)) return err(`only @${domain} addresses`);
        try {
          const u = ctx.users.invite(email, { admin: asAdmin });
          const login = ctx.login ? ctx.cfg.mcp.login! : undefined;
          return text(`${u.email} can sign in as ${u.role} (user ${u.name})${login ? `: claude mcp add --transport http ${serverName(login.publicUrl)} ${login.publicUrl.replace(/\/+$/, '')}/mcp --client-id ${login.clientId} --callback-port ${CALLBACK_PORT}` : ''}`);
        } catch (e) {
          return err((e as Error).message);
        }
      },
    );
    s.registerTool('remove_user', { description: 'Admin: remove a user (by name or email); they lose access on their next request.', inputSchema: { name: z.string().max(200) } }, async ({ name }) => {
      const denied = notAdminNow();
      if (denied) return denied;
      const target = ctx.users.list().find((u) => u.name === name) ?? ctx.users.byEmail(name);
      if (!target) return err(`no user ${name}`);
      if (target.name === user.name) return err('you cannot remove yourself');
      return ctx.users.remove(target.name) ? text(`${target.name} removed`) : err(`no user ${name}`);
    });
    // "Not an issue" clicks in Slack. Read-only: a permanent rule stays a
    // reviewed change to config/noise.yaml.
    if (ctx.issues)
      s.registerTool(
        'noise_candidates',
        {
          description: 'Admin: issues people marked Not an issue in Slack, most often first, with their rows and who clicked when. Candidates for a reviewed config/noise.yaml change; nothing is muted for good.',
          inputSchema: {},
          annotations: { readOnlyHint: true },
        },
        async () => {
          const denied = notAdminNow();
          if (denied) return denied;
          const list = ctx.issues!.noiseCandidates();
          const lines = list.map((c) =>
            [`${c.issue} · ${c.status} · Not an issue ${c.dismissals.length}× · ${c.title}`, `  rows: ${c.rows.join(', ')}`, `  ${c.dismissals.map((d) => `${d.at.slice(0, 16)}Z by ${d.by}`).join('; ')}`].join('\n'),
          );
          return text(lines.length ? redact(`${lines.join('\n\n')}\n\nA rule that hides rows for good is a reviewed change to config/noise.yaml.`) : 'none');
        },
      );
    // An episode for the offline eval (`eval` in the CLI): the run's prompt,
    // every tool result its model saw, its reports and its challenge, redacted
    // again on the way out. One response holds at most EXPORT_PART characters.
    s.registerTool(
      'export_run',
      {
        description: `Admin: one run's input.md, evidence.jsonl, output.json and challenge.json (those it has), redacted, to save as an eval episode. In parts of at most ${EXPORT_PART} characters: the first line of each says which part of how many; the rest of every part, joined in order, is one JSON object of file name → content.`,
        inputSchema: { run_id: z.string(), part: z.number().int().min(1).optional().describe('Default 1') },
        annotations: { readOnlyHint: true },
      },
      async ({ run_id, part }) => {
        const denied = notAdminNow();
        if (denied) return denied;
        if (!RUN_ID.test(run_id)) return err('not a run id');
        const row = ctx.engine.store.get(run_id);
        if (!readable(row)) return err(`no run ${run_id}`);
        if (row.status === 'running') return err(`${run_id} is still running; export it once it has ended`);
        const dir = runFolder(ctx, row.agent, row.id);
        if (!existsSync(join(dir, 'input.md'))) return err(`${run_id} has no run folder (never started, or older than the retention)`);
        const files: Record<string, string> = {};
        for (const name of ['input.md', 'evidence.jsonl', 'output.json', 'challenge.json']) {
          if (!existsSync(join(dir, name))) continue;
          const raw = readFileSync(join(dir, name), 'utf8');
          try {
            // JSON is redacted value by value, so it stays JSON.
            if (name === 'input.md') files[name] = redact(raw);
            else if (name === 'evidence.jsonl') files[name] = raw.split('\n').filter((l) => l.trim()).map((l) => `${safeJson(JSON.parse(l))}\n`).join('');
            else files[name] = safeJson(JSON.parse(raw), 1);
          } catch {
            return err(`${name} of ${run_id} can't be read`);
          }
        }
        const all = JSON.stringify(files);
        const head = (n: number | string, of: number | string) => `export_run ${run_id} part ${n} of ${of}\n`;
        const size = EXPORT_PART - head('999999', '999999').length; // room for the header: a whole response stays within EXPORT_PART
        const parts = Math.max(1, Math.ceil(all.length / size));
        const n = part ?? 1;
        if (n > parts) return err(`${run_id} has ${parts} part(s)`);
        return text(head(n, parts) + all.slice((n - 1) * size, n * size));
      },
    );
    s.registerTool('list_users', { description: 'Admin: users, roles and how they sign in.', inputSchema: {} }, async () => {
      const denied = notAdminNow();
      if (denied) return denied;
      const rows = ctx.users.list().map((u) => `${u.name.padEnd(16)} ${u.role.padEnd(6)} ${!u.token_sha256 ? 'keycloak' : new Date(expiresAt(u)).getTime() > Date.now() ? `token until ${new Date(expiresAt(u)).toISOString().slice(0, 10)}` : 'expired'}  ${u.email ?? ''}`);
      return text(rows.join('\n') || 'no users');
    });
  }
  return s;
}

// Shutdown (SIGTERM on a redeploy): stop every run this server started and
// wait until each is settled and its requester notified, so no "running" row
// is left behind.
export async function shutdown(ctx: McpContext, reason: string, waitMs: number): Promise<number> {
  const runs = [...active(ctx).values()];
  for (const r of runs) r.controller.abort(reason);
  await Promise.race([Promise.all(runs.map((r) => r.done)), sleep(waitMs)]);
  return runs.length;
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

// Claude Code's fixed OAuth callback port: the Keycloak client allows exactly
// http://localhost:<port>/callback (and 127.0.0.1), nothing else.
export const CALLBACK_PORT = 33419;

// Streamable HTTP, stateless: each POST gets a fresh server bound to the
// caller's identity: a Keycloak access token when the sign-in is on, else a
// CLI-made token. On a loopback bind the Host header must be local too (DNS
// rebinding); anywhere else put TLS in front.
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
      // RFC 9728 puts the document at the path-suffixed form; some clients try the bare one.
      const isMetadata = url.pathname === METADATA_PATH || url.pathname === '/.well-known/oauth-protected-resource';
      if (url.pathname !== '/mcp' && !(isMetadata && ctx.login)) return send(404, 'not found');
      if (local && !LOOPBACK.has((req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, ''))) return send(403, 'bad host');
      if (isMetadata) {
        if (req.method !== 'GET') return send(405, 'GET only', { allow: 'GET' });
        return void res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=300' }).end(JSON.stringify(ctx.login!.metadata()));
      }
      // Browsers send Origin; MCP clients don't. A page in a developer's
      // browser must not drive the endpoint (MCP spec: validate Origin).
      const origin = req.headers.origin;
      if (origin && !(ctx.cfg.mcp.allowedOrigins ?? []).includes(origin)) return send(403, 'origin not allowed');
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
      let user: User | undefined;
      if (ctx.login) {
        try {
          const email = await ctx.login.verify(token);
          user = ctx.users.byEmail(email);
          if (!user) return send(403, `${email} has not been invited; ask an engine admin`);
        } catch (e) {
          if (!(e instanceof Refused)) throw e;
          if (e.status === 503) ctx.log?.(`sign-in: ${e.message}`);
          return send(e.status, e.message, e.status === 401 ? { 'www-authenticate': ctx.login.challenge() } : {});
        }
      } else {
        user = ctx.users.authenticate(token);
        if (!user) return send(401, 'missing or unknown token', { 'www-authenticate': 'Bearer' });
      }
      if (req.method !== 'POST') return send(405, 'stateless server: POST only', { allow: 'POST' });
      const parsed = await body(req);
      const mcp = buildServer(ctx, user);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !ctx.cfg.mcp.stream });
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
