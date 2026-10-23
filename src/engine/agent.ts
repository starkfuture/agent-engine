import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

// An agent is a folder:
//   agent.yaml          limits, tools, triggers, challenge, sinks
//   CLAUDE.md           the system prompt
//   memory/lessons.md   human-curated lessons (in git), read at run start
//   memory/proposed.md  lessons runs propose (engine appends; a human promotes)
// With a memory root (ENGINE_MEMORY_DIR, on a persistent volume when hosted),
// runtime writes go to <root>/<agent>/ instead: proposed.md and lessons
// approved over MCP. Both lesson files are read; git ones come first.
//   skills/, agents/    Claude Code skills and subagents, loaded as a local plugin
// Code (gate, credentialed tools, output checks) lives in src/agents/<code>.ts.

export const FILE_TOOLS = ['Read', 'Grep', 'Glob'] as const;
export const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const;
const BUILTIN = z.enum([...FILE_TOOLS, ...WEB_TOOLS]);

const duration = z
  .string()
  .regex(/^\d+[mh]$/)
  .transform((s) => Number(s.slice(0, -1)) * (s.endsWith('h') ? 60 : 1));

export const AgentSpec = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    description: z.string().default(''),
    model: z.string().default('claude-sonnet-5-5'),
    code: z.string().optional(), // module in src/agents/
    every: duration.optional(), // interval trigger in minutes; absent = manual only
    builtin_tools: z.array(BUILTIN).default([]),
    // Packs that reach credentialed or sensitive systems (Grafana, k8s, …).
    sensitive_tools: z.boolean().default(false),
    // In-process tools the engine supplies to runs started over MCP:
    // telemetry = read-only Prometheus/Loki/Tempo (the monitor's tools).
    tool_pack: z.enum(['telemetry']).optional(),
    concurrency: z.number().int().min(1).max(10).default(1), // runs of this agent at once
    limits: z
      .object({
        max_turns: z.number().int().min(1).max(200).default(30),
        usd_per_run: z.number().positive().max(20).default(1),
        usd_per_day: z.number().positive().max(200).default(10),
        deadline_min: z.number().positive().max(120).default(10),
      })
      .strict()
      .default({ max_turns: 30, usd_per_run: 1, usd_per_day: 10, deadline_min: 10 }),
    challenge: z
      .object({
        when: z.enum(['never', 'always', 'gate']).default('never'),
        model: z.string().optional(), // defaults to the agent's model
        usd: z.number().positive().max(20).default(1),
        max_turns: z.number().int().min(1).max(100).default(15),
      })
      .strict()
      .default({ when: 'never', usd: 1, max_turns: 15 }),
    sinks: z.array(z.enum(['file', 'slack'])).default(['file']),
    // Who may read a run over MCP: the requester and admins, or every user.
    // Agents that read customer data stay at the default.
    visibility: z.enum(['requester', 'everyone']).default('requester'),
  })
  .strict();
export type AgentSpec = z.infer<typeof AgentSpec>;

export interface LoadedAgent {
  dir: string;
  spec: AgentSpec;
  prompt: string; // CLAUDE.md + lessons
  version: string; // sha256 of the folder and runtime lessons (minus proposed lessons), first 12 hex
  memory: string; // where runtime writes go: proposed.md, approved lessons
  plugin: boolean; // has skills/ or agents/
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

export function loadAgent(dir: string, memoryRoot?: string): LoadedAgent {
  const spec = AgentSpec.parse(parse(readFileSync(join(dir, 'agent.yaml'), 'utf8')));
  if (spec.name !== basename(dir)) throw new Error(`agent.yaml name "${spec.name}" must match its folder "${basename(dir)}"`);

  // Rule of Two: a run that reads sensitive data (local files or credentialed
  // packs) must not also be able to send data out (the web tools take URLs).
  const reads = spec.sensitive_tools || spec.builtin_tools.some((t) => (FILE_TOOLS as readonly string[]).includes(t));
  const egress = spec.builtin_tools.some((t) => (WEB_TOOLS as readonly string[]).includes(t));
  if (reads && egress) throw new Error(`${spec.name}: an agent cannot have both sensitive reads (files or credentialed tools) and web tools`);
  if (spec.tool_pack && !spec.sensitive_tools) throw new Error(`${spec.name}: tool_pack reaches production data, so sensitive_tools must be true`);

  // Hooks and settings in an agent folder would run outside the engine's control.
  for (const bad of ['hooks', '.claude', '.mcp.json']) if (existsSync(join(dir, bad))) throw new Error(`${spec.name}: "${bad}" is not allowed in an agent folder`);

  const claude = join(dir, 'CLAUDE.md');
  if (!existsSync(claude)) throw new Error(`${spec.name}: CLAUDE.md is required`);
  const memory = memoryRoot ? join(memoryRoot, spec.name) : join(dir, 'memory');
  const lessonFiles = [...new Set([join(dir, 'memory', 'lessons.md'), join(memory, 'lessons.md')])];
  const lessons = lessonFiles
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, 'utf8').trim())
    .filter(Boolean)
    .join('\n');
  const prompt = readFileSync(claude, 'utf8').trim() + (lessons ? `\n\n# Lessons from past runs (curated by humans)\n\n${lessons}` : '');

  const h = createHash('sha256');
  for (const f of files(dir)) {
    const rel = relative(dir, f);
    if (rel === join('memory', 'proposed.md')) continue;
    h.update(rel).update('\0').update(readFileSync(f)).update('\0');
  }
  const runtime = join(memory, 'lessons.md');
  if (memoryRoot && existsSync(runtime)) h.update('runtime-lessons\0').update(readFileSync(runtime));
  const plugin = existsSync(join(dir, 'skills')) || existsSync(join(dir, 'agents'));
  return { dir, spec, prompt, version: h.digest('hex').slice(0, 12), plugin, memory };
}

export function listAgents(root: string, memoryRoot?: string): LoadedAgent[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => existsSync(join(root, n, 'agent.yaml')))
    .sort()
    .map((n) => loadAgent(join(root, n), memoryRoot));
}
