import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool, type HookCallbackMatcher, type HookEvent, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z, type ZodRawShape } from 'zod';
import { FILE_TOOLS, WEB_TOOLS, type LoadedAgent } from './agent.js';
import { challengeLite, type ChallengeResult } from './challenge.js';
import { Evidence, evidenceHook } from './evidence.js';
import { pathGuard } from './guard.js';
import { pluginCopy, type Session, type SessionEvent, type SessionRequest } from './session.js';
import { snapshot } from './snapshot.js';
import type { RunStatus, Store } from './store.js';
import { fence, redact, safeJson } from './text.js';

export interface Engine {
  store: Store; // admission, single flight, spend
  runsDir: string; // run folders
  stopFile: string; // touch it to stop every run at the next message
  session: Session;
  dailyCapUsd: number; // across all agents
  monthlyCapUsd?: number; // across all agents, UTC month
  llmAvailable: boolean;
  now?: () => Date;
}

// How an agent answers. Output arrives only through this tool; the engine
// validates it (schema, evidence ids and quotes, agent checks) before accepting it.
export interface OutputSpec<T> {
  tool: string;
  description: string;
  shape: ZodRawShape;
  evidenceOf: (v: T) => Array<{ id: string; quote: string }>;
  check?: (v: T) => string[];
  lessonsOf?: (v: T) => string[];
  max?: number; // how many outputs one run may submit (default 10)
}

export type ToolFactory = (ev: Evidence, by: 'author' | 'challenger') => SdkMcpToolDefinition<any>[];

export interface RunInput<T> {
  agent: LoadedAgent;
  trigger: string; // 'manual' | 'patrol' | 'replay' | …
  task: string; // the instruction for this run, from the operator or the gate
  data?: string; // untrusted context (patrol summary, alert body): fenced
  tools?: ToolFactory; // in-process tools; these hold credentials, so they count as sensitive reads
  output: OutputSpec<T>;
  challenge?: boolean;
  roots?: string[]; // git folders the file tools may read; each is snapshotted
}

export interface RunResult<T> {
  runId: string;
  status: Exclude<RunStatus, 'running'>;
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
const hasAny = (tools: string[], set: readonly string[]) => tools.some((t) => set.includes(t));

// Limits the SDK doesn't enforce for one session: the stop file and repeated calls.
function watcher(stopFile: string, onStop: (why: 'stopped' | 'loop', note: string) => void) {
  const seen = new Map<string, number>();
  return (e: SessionEvent) => {
    if (existsSync(stopFile)) onStop('stopped', 'stop file');
    if (e.kind !== 'tool_use') return;
    const k = `${e.name} ${JSON.stringify(e.input)}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n >= LOOP_REPEATS) onStop('loop', `same call ${LOOP_REPEATS}×: ${e.name}`);
  };
}

export async function runAgent<T>(engine: Engine, input: RunInput<T>): Promise<RunResult<T>> {
  const { agent } = input;
  const spec = agent.spec;
  const clock = () => engine.now?.() ?? new Date();
  const now = clock();
  const evidence = new Evidence();
  const runId = `${stamp(now)}-${spec.name}-${randomBytes(3).toString('hex')}`;

  // Configuration errors are the caller's bug: fail loudly, before any money moves.
  const fileTools = hasAny(spec.builtin_tools, FILE_TOOLS);
  if (fileTools && !input.roots?.length) throw new Error(`${spec.name}: file tools need roots (the folders they may read)`);
  if (input.tools && hasAny(spec.builtin_tools, WEB_TOOLS)) throw new Error(`${spec.name}: credentialed tools and web tools can't share a run (Rule of Two)`);

  const skipped = (note: string): RunResult<T> => {
    engine.store.skipped({ id: runId, agent: spec.name, version: agent.version, trigger: input.trigger, now, note });
    return { runId, status: 'skipped', outputs: [], evidence, cost: 0, turns: 0, note };
  };
  if (!engine.llmAvailable) return skipped('no LLM credentials configured');
  if (existsSync(engine.stopFile)) return skipped(`stop file present: ${engine.stopFile}`);

  const challenge = input.challenge ?? spec.challenge.when === 'always';
  const reserve = spec.limits.usd_per_run + (challenge ? spec.challenge.usd : 0);
  const admitted = engine.store.admit({
    id: runId,
    agent: spec.name,
    version: agent.version,
    trigger: input.trigger,
    now,
    deadlineMs: spec.limits.deadline_min * 60_000,
    reserve,
    agentCap: spec.limits.usd_per_day,
    globalCap: engine.dailyCapUsd,
    ...(engine.monthlyCapUsd !== undefined ? { monthlyCap: engine.monthlyCapUsd } : {}),
  });
  if (!admitted.ok) return skipped(admitted.reason);

  // From here on the run is admitted: whatever happens, it gets settled.
  const outputs: T[] = [];
  const temps: string[] = [];
  let status: Exclude<RunStatus, 'running'> = 'ok';
  let note: string | undefined;
  let cost = 0;
  let turns = 0;
  let dir: string | undefined;
  let challengeResult: ChallengeResult | undefined;
  let modelStarted = false;
  const abort = new AbortController();
  let stopped: 'deadline' | 'stopped' | 'loop' | undefined;
  const stop = (why: 'deadline' | 'stopped' | 'loop', n: string) => {
    if (stopped) return;
    stopped = why;
    note = n;
    abort.abort();
  };
  const timer = setTimeout(() => stop('deadline', `deadline ${spec.limits.deadline_min} min`), spec.limits.deadline_min * 60_000);

  try {
    dir = join(engine.runsDir, spec.name, runId);
    mkdirSync(dir, { recursive: true });
    const runDir = dir;
    const transcript = (by: string, e: SessionEvent) => {
      try {
        appendFileSync(join(runDir, 'transcript.jsonl'), safeJson({ by, ...e }) + '\n');
      } catch {
        /* a lost transcript line must not fail the run */
      }
    };

    // File tools read snapshots: git-tracked files without secret files.
    const roots = input.roots?.map((r) => {
      const s = snapshot(r);
      temps.push(s.dir);
      return s.dir;
    });
    const where = roots ? `\n\nThe folder${roots.length > 1 ? 's' : ''} you may read (a copy of ${input.roots!.join(', ')}, git-tracked files only, secret files removed): ${roots.join(', ')}` : '';
    const task = input.task + where;
    const prompt = [task, ...(input.data ? ['', fence('context', input.data)] : [])].join('\n');
    writeFileSync(join(dir, 'input.md'), redact(`# ${spec.name} @ ${agent.version}\n\ntrigger: ${input.trigger}\nchallenge: ${challenge}\n\n${prompt}\n`));

    const Out = z.object(input.output.shape);
    const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: `error: ${msg}` }], isError: true });
    const submit = tool(input.output.tool, input.output.description, input.output.shape, async (args) => {
      const parsed = Out.safeParse(args);
      if (!parsed.success) return fail(parsed.error.message);
      const v = parsed.data as T;
      const problems = [...input.output.evidenceOf(v).map((e) => evidence.quoteProblem(e.id, e.quote)).filter((p): p is string => !!p), ...(input.output.check?.(v) ?? [])];
      if (outputs.length >= (input.output.max ?? 10)) problems.push('too many submissions for one run');
      if (problems.length) return fail(problems.join('; '));
      outputs.push(v);
      return { content: [{ type: 'text' as const, text: `accepted ${outputs.length}` }] };
    });

    const cwd = roots?.[0] ?? mkdtempSync(join(tmpdir(), 'engine-cwd-'));
    if (!roots) temps.push(cwd);
    const hooks = (by: 'author' | 'challenger'): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
      PostToolUse: [evidenceHook(evidence, by)],
      ...(roots ? { PreToolUse: [pathGuard(roots, cwd)] } : {}),
    });
    const pluginDir = agent.plugin ? pluginCopy(agent.dir, spec.name) : undefined;
    if (pluginDir) temps.push(pluginDir);
    const base = { builtin: spec.builtin_tools, cwd, ...(roots ? { roots } : {}), ...(pluginDir ? { pluginDir } : {}) };

    // Author.
    let gotResult = false;
    const watchAuthor = watcher(engine.stopFile, stop);
    modelStarted = true;
    try {
      for await (const e of engine.session({
        ...base,
        abort,
        hooks: hooks('author'),
        model: spec.model,
        system: agent.prompt,
        prompt,
        tools: [...(input.tools?.(evidence, 'author') ?? []), submit],
        maxTurns: spec.limits.max_turns,
        maxBudgetUsd: spec.limits.usd_per_run,
      })) {
        transcript('author', e);
        watchAuthor(e);
        if (e.kind === 'result') {
          gotResult = true;
          cost = e.cost;
          turns = e.turns;
          if (!e.ok) {
            status = e.subtype === 'error_max_budget_usd' ? 'budget' : 'error';
            note = e.subtype === 'success' ? e.text.slice(0, 300) : e.subtype;
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
    if (evidence.failure && status === 'ok') {
      status = 'error';
      note = evidence.failure;
    }
    if (status === 'ok' && outputs.length === 0) status = 'no_output';

    // Challenger: its own loop detector and its own abort, chained to the run's.
    if (challenge && outputs.length && !stopped) {
      const cAbort = new AbortController();
      abort.signal.addEventListener('abort', () => cAbort.abort());
      let cStop: string | undefined;
      const watchChallenger = watcher(engine.stopFile, (why, n) => {
        if (why === 'stopped') stop('stopped', n);
        cStop ??= n;
        cAbort.abort();
      });
      challengeResult = await challengeLite({
        session: engine.session,
        base: { ...base, abort: cAbort, hooks: hooks('challenger') },
        model: spec.challenge.model ?? spec.model,
        maxTurns: spec.challenge.max_turns,
        usd: spec.challenge.usd,
        about: spec.description || spec.name,
        task: input.task,
        ...(input.data ? { data: input.data } : {}),
        output: outputs.length === 1 ? outputs[0] : outputs,
        evidence,
        tools: input.tools?.(evidence, 'challenger') ?? [],
        onEvent: (e) => {
          transcript('challenger', e);
          watchChallenger(e);
        },
      });
      const cBroke = cStop ?? evidence.failure;
      if (cBroke && challengeResult.verdict === 'upheld') challengeResult = { ...challengeResult, verdict: 'error', note: cBroke };
      cost += challengeResult.cost;
      writeFileSync(join(dir, 'challenge.json'), safeJson(challengeResult, 1));
    }
  } catch (err) {
    // Setup or bookkeeping failed (disk full, not a git folder, …).
    if (!stopped) {
      status = 'error';
      note = (err as Error).message.slice(0, 300);
    }
    if (!cost && modelStarted) cost = reserve; // unknown spend: book the whole reservation
  } finally {
    clearTimeout(timer);
    if (stopped) status = stopped; // also when the deadline or STOP hit during the challenge
    const best = (f: () => void) => {
      try {
        f();
      } catch {
        /* artifacts are best-effort; settlement is not */
      }
    };
    if (dir) {
      best(() => writeFileSync(join(dir!, 'evidence.jsonl'), [...evidence.items.values()].map((e) => safeJson(e)).join('\n') + '\n'));
      best(() => writeFileSync(join(dir!, 'output.json'), safeJson(outputs, 1)));
    }
    const lessons = outputs.flatMap((o) => input.output.lessonsOf?.(o) ?? []);
    if (lessons.length)
      best(() => {
        mkdirSync(join(agent.dir, 'memory'), { recursive: true });
        appendFileSync(join(agent.dir, 'memory', 'proposed.md'), redact(`\n## ${runId}\n${lessons.map((l) => `- ${l}`).join('\n')}\n`));
      });
    engine.store.settle(runId, {
      status,
      cost,
      turns,
      outputs: outputs.length,
      now: clock(),
      ...(challengeResult ? { challenge: challengeResult.verdict } : {}),
      ...(note ? { note } : {}),
    });
    for (const t of temps) best(() => rmSync(t, { recursive: true, force: true }));
  }
  return { runId, status, outputs, evidence, cost, turns, ...(dir ? { dir } : {}), ...(challengeResult ? { challenge: challengeResult } : {}), ...(note ? { note } : {}) };
}
