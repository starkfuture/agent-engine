import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool, type HookCallbackMatcher, type HookEvent, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z, type ZodRawShape } from 'zod';
import type { LoadedAgent } from './agent.js';
import { challengeLite, type ChallengeResult } from './challenge.js';
import { Evidence, evidenceHook } from './evidence.js';
import { pathGuard } from './guard.js';
import { Ledger, Lock, type RunStatus } from './ledger.js';
import { pluginCopy, type Session, type SessionRequest } from './session.js';
import { fence, redact } from './text.js';

export interface Engine {
  ledger: Ledger;
  runsDir: string;
  stopFile: string; // touch it to stop every run at the next message
  session: Session;
  dailyCapUsd: number; // across all agents
  llmAvailable: boolean;
  now?: () => Date;
}

// How an agent answers. Output arrives only through this tool; the engine
// validates it (schema, evidence ids, agent checks) before accepting it.
export interface OutputSpec<T> {
  tool: string;
  description: string;
  shape: ZodRawShape;
  evidenceOf: (v: T) => string[];
  check?: (v: T) => string[];
  lessonsOf?: (v: T) => string[];
  max?: number; // how many outputs one run may submit (default 10)
}

export type ToolFactory = (ev: Evidence, by: 'author' | 'challenger') => SdkMcpToolDefinition<any>[];

export interface RunInput<T> {
  agent: LoadedAgent;
  trigger: string; // 'manual' | 'schedule' | …
  task: string; // the instruction for this run, from the operator or the gate
  data?: string; // untrusted context (patrol summary, alert body): fenced
  tools?: ToolFactory;
  output: OutputSpec<T>;
  challenge?: boolean;
  roots?: string[]; // folders the file tools may read
  cwd?: string;
}

export interface RunResult<T> {
  runId: string;
  status: RunStatus;
  outputs: T[];
  evidence: Evidence;
  cost: number;
  turns: number;
  dir?: string;
  challenge?: ChallengeResult;
  note?: string;
}

const LOOP_REPEATS = 3;
const stamp = (d: Date) => d.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';

export async function runAgent<T>(engine: Engine, input: RunInput<T>): Promise<RunResult<T>> {
  const { agent } = input;
  const spec = agent.spec;
  const now = engine.now?.() ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const evidence = new Evidence();
  const runId = `${stamp(now)}-${spec.name}-${randomBytes(3).toString('hex')}`;
  const skipped = (note: string): RunResult<T> => {
    engine.ledger.append({ ev: 'end', run: runId, agent: spec.name, at: now.toISOString(), status: 'skipped', cost: 0, turns: 0, outputs: 0, note });
    return { runId, status: 'skipped', outputs: [], evidence, cost: 0, turns: 0, note };
  };

  if (!engine.llmAvailable) return skipped('no LLM credentials configured');
  const challenge = input.challenge ?? spec.challenge.when === 'always';
  const reserve = spec.limits.usd_per_run + (challenge ? spec.challenge.usd : 0);
  if (engine.ledger.spent(day, spec.name) + reserve > spec.limits.usd_per_day) return skipped(`agent daily cap $${spec.limits.usd_per_day} reached`);
  if (engine.ledger.spent(day) + reserve > engine.dailyCapUsd) return skipped(`global daily cap $${engine.dailyCapUsd} reached`);
  if (existsSync(engine.stopFile)) return skipped(`stop file present: ${engine.stopFile}`);

  const lock = new Lock(join(engine.runsDir, 'locks', `${spec.name}.lock`));
  if (!lock.acquire()) return skipped('another run of this agent is in progress');

  const dir = join(engine.runsDir, spec.name, runId);
  mkdirSync(dir, { recursive: true });
  const transcript = (e: unknown) => appendFileSync(join(dir, 'transcript.jsonl'), redact(JSON.stringify(e)) + '\n');
  engine.ledger.append({ ev: 'start', run: runId, agent: spec.name, version: agent.version, trigger: input.trigger, at: now.toISOString(), reserve });

  const prompt = [input.task, ...(input.data ? ['', fence('context', input.data)] : [])].join('\n');
  writeFileSync(join(dir, 'input.md'), redact(`# ${spec.name} @ ${agent.version}\n\ntrigger: ${input.trigger}\nchallenge: ${challenge}\n\n${prompt}\n`));

  // Output tool: the only way to answer.
  const outputs: T[] = [];
  const Out = z.object(input.output.shape);
  const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: `error: ${msg}` }], isError: true });
  const submit = tool(input.output.tool, input.output.description, input.output.shape, async (args) => {
    const parsed = Out.safeParse(args);
    if (!parsed.success) return fail(parsed.error.message);
    const v = parsed.data as T;
    const problems = [
      ...input.output.evidenceOf(v).filter((id) => !evidence.has(id)).map((id) => `evidence ${id} does not match any tool result in this run`),
      ...(input.output.check?.(v) ?? []),
    ];
    if (outputs.length >= (input.output.max ?? 10)) problems.push('too many submissions for one run');
    if (problems.length) return fail(problems.join('; '));
    outputs.push(v);
    return { content: [{ type: 'text' as const, text: `accepted ${outputs.length}` }] };
  });

  // Limits the SDK doesn't enforce: wall clock, stop file, repeated calls.
  const abort = new AbortController();
  let stopped: RunStatus | undefined;
  let note: string | undefined;
  const stop = (why: RunStatus, n: string) => {
    if (stopped) return;
    stopped = why;
    note = n;
    abort.abort();
  };
  const timer = setTimeout(() => stop('deadline', `deadline ${spec.limits.deadline_min} min`), spec.limits.deadline_min * 60_000);
  const seen = new Map<string, number>();
  const watch = (e: { kind: string; name?: string; input?: unknown }) => {
    if (existsSync(engine.stopFile)) stop('stopped', 'stop file');
    if (e.kind !== 'tool_use') return;
    const k = `${e.name} ${JSON.stringify(e.input)}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n >= LOOP_REPEATS) stop('loop', `same call ${LOOP_REPEATS}×: ${e.name}`);
  };

  const cwd = input.cwd ?? input.roots?.[0] ?? mkdtempSync(join(tmpdir(), 'engine-cwd-'));
  const hooks = (by: 'author' | 'challenger'): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    PostToolUse: [evidenceHook(evidence, by)],
    ...(input.roots ? { PreToolUse: [pathGuard(input.roots, cwd)] } : {}),
  });
  const base: Omit<SessionRequest, 'system' | 'prompt' | 'tools' | 'maxTurns' | 'maxBudgetUsd' | 'model' | 'hooks'> = {
    builtin: spec.builtin_tools,
    abort,
    cwd,
    ...(agent.plugin ? { pluginDir: pluginCopy(agent.dir, spec.name) } : {}),
  };

  let cost = 0;
  let turns = 0;
  let gotResult = false;
  let status: RunStatus = 'ok';
  let challengeResult: ChallengeResult | undefined;
  try {
    try {
      for await (const e of engine.session({
        ...base,
        hooks: hooks('author'),
        model: spec.model,
        system: agent.prompt,
        prompt,
        tools: [...(input.tools?.(evidence, 'author') ?? []), submit],
        maxTurns: spec.limits.max_turns,
        maxBudgetUsd: spec.limits.usd_per_run,
      })) {
        transcript({ by: 'author', ...e });
        watch(e);
        if (e.kind === 'result') {
          gotResult = true;
          cost = e.cost;
          turns = e.turns;
          if (!e.ok) {
            status = e.subtype === 'error_max_budget_usd' ? 'budget' : 'error';
            note = e.subtype;
          }
        }
      }
    } catch (err) {
      if (!stopped) {
        status = 'error';
        note = (err as Error).message.slice(0, 300);
      }
    }
    if (!gotResult) cost = spec.limits.usd_per_run; // aborted or crashed: book the whole allowance
    if (stopped) status = stopped;
    else if (status === 'ok' && outputs.length === 0) status = 'no_output';

    if (challenge && outputs.length && !stopped) {
      challengeResult = await challengeLite({
        session: engine.session,
        base: { ...base, hooks: hooks('challenger') },
        model: spec.challenge.model ?? spec.model,
        maxTurns: spec.challenge.max_turns,
        usd: spec.challenge.usd,
        authorInstructions: agent.prompt,
        output: outputs.length === 1 ? outputs[0] : outputs,
        evidence,
        tools: input.tools?.(evidence, 'challenger') ?? [],
        onEvent: (e) => {
          transcript(e);
          watch(e as { kind: string });
        },
      });
      cost += challengeResult.cost;
      writeFileSync(join(dir, 'challenge.json'), redact(JSON.stringify(challengeResult, null, 1)));
    }
  } finally {
    clearTimeout(timer);
    writeFileSync(join(dir, 'evidence.jsonl'), [...evidence.items.values()].map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(join(dir, 'output.json'), redact(JSON.stringify(outputs, null, 1)));
    const lessons = outputs.flatMap((o) => input.output.lessonsOf?.(o) ?? []);
    if (lessons.length) {
      mkdirSync(join(agent.dir, 'memory'), { recursive: true });
      appendFileSync(join(agent.dir, 'memory', 'proposed.md'), redact(`\n## ${runId}\n${lessons.map((l) => `- ${l}`).join('\n')}\n`));
    }
    engine.ledger.append({
      ev: 'end',
      run: runId,
      agent: spec.name,
      at: (engine.now?.() ?? new Date()).toISOString(),
      status,
      cost,
      turns,
      outputs: outputs.length,
      ...(challengeResult ? { challenge: challengeResult.verdict } : {}),
      ...(note ? { note } : {}),
    });
    lock.release();
  }
  return { runId, status, outputs, evidence, cost, turns, dir, ...(challengeResult ? { challenge: challengeResult } : {}), ...(note ? { note } : {}) };
}
