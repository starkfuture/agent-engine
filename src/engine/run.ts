import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool, type HookCallbackMatcher, type HookEvent, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z, type ZodRawShape } from 'zod';
import { FILE_TOOLS, WEB_TOOLS, type LoadedAgent } from './agent.js';
import { challengeLite, notRun, unsound, type ChallengeResult } from './challenge.js';
import { Evidence, evidenceHook } from './evidence.js';
import { pathGuard } from './guard.js';
import { firstTurnUsd, pluginCopy, SpendMeter, type Session, type SessionEvent, type SessionRequest } from './session.js';
import { freeBytes } from './retention.js';
import { snapshot, type Snapshot } from './snapshot.js';
import type { RunStatus, Store } from './store.js';
import { fence, redact, safeJson } from './text.js';

export interface Engine {
  store: Store; // admission, single flight, spend
  runsDir: string; // run folders
  stopFile: string; // touch it to stop every run at the next message
  session: Session;
  dailyCapUsd: number; // across all agents
  monthlyCapUsd?: number; // across all agents, UTC month
  // An agent's share of monthlyCapUsd: the monitor's leaves the rest for people.
  agentMonthlyCapUsd?: Record<string, number>;
  llmAvailable: boolean;
  build?: string; // engine code version, recorded on every run
  minFreeBytes?: number; // refuse new runs below this much free space on the runs volume
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

// roots: the snapshots the file tools read, for tools that work on them (a draft fix's edits).
export type ToolFactory = (ev: Evidence, by: 'author' | 'challenger', roots?: string[]) => SdkMcpToolDefinition<any>[];

export interface RunInput<T> {
  agent: LoadedAgent;
  trigger: string; // 'manual' | 'patrol' | 'replay' | …
  task: string; // the instruction for this run, from the operator or the gate
  data?: string; // untrusted context (patrol summary, alert body): fenced
  tools?: ToolFactory; // in-process tools; these hold credentials, so they count as sensitive reads
  output: OutputSpec<T>;
  // true: a challenger checks the outputs. A function: decided once the
  // outputs exist (a gate that depends on the answer).
  challenge?: boolean | ((outputs: T[]) => boolean);
  roots?: Array<string | Root>; // git folders the file tools may read; each is snapshotted at a commit
  user?: { name: string; usdPerDay?: number; maxRunning?: number }; // who asked (MCP)
  signal?: AbortSignal; // cancel this run (status 'stopped')
  onAdmitted?: (runId: string) => void; // called once the run is admitted, before the model starts
  // Why the caller's last run was skipped, if that still holds (a cap, the kill
  // switch). A skip for this same reason is returned but not recorded again.
  heldBy?: string;
}

// A repo to read and the ref to read it at (default: origin/HEAD, else HEAD).
export interface Root {
  path: string;
  ref?: string;
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
  sources?: Array<Omit<Snapshot, 'dir' | 'files' | 'skipped'> & { path: string }>; // the commits file tools read
}

const LOOP_REPEATS = 3;
const HEARTBEAT_MS = 30_000;

// Admitted runs in this process, so a shutdown can stop and settle them
// instead of leaving "running" rows behind.
const INFLIGHT = new Map<string, { stop: (note: string) => void; settled: Promise<void> }>();
let closing: string | undefined;

// Stop every run in this process, wait (up to waitMs) until each is settled,
// and refuse new runs from now on. Returns how many runs were stopped.
export async function stopAllRuns(reason: string, waitMs: number): Promise<number> {
  closing = reason;
  const runs = [...INFLIGHT.values()];
  for (const r of runs) r.stop(reason);
  await Promise.race([Promise.all(runs.map((r) => r.settled)), new Promise((res) => setTimeout(res, waitMs).unref())]);
  return runs.length;
}
const stamp = (d: Date) => d.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
const hasAny = (tools: string[], set: readonly string[]) => tools.some((t) => set.includes(t));

// Who set the kill switch, when and why, as stop_all wrote it ("<time> <user>: <reason>";
// the CLI writes only the time). Never the file's path: callers see this note.
function stopDetail(file: string): string {
  try {
    const line = readFileSync(file, 'utf8').split('\n')[0]!.replace(/\s+/g, ' ').trim().slice(0, 200);
    return line ? ` (set ${line})` : '';
  } catch {
    return '';
  }
}

// Limits the SDK doesn't enforce for one session: the stop file and repeated calls.
function watcher(stopFile: string, onStop: (why: 'stopped' | 'loop', note: string) => void) {
  const seen = new Map<string, number>();
  return (e: SessionEvent) => {
    if (existsSync(stopFile)) onStop('stopped', 'kill switch');
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
    if (note !== input.heldBy) engine.store.skipped({ id: runId, agent: spec.name, version: agent.version, trigger: input.trigger, now, note, ...(input.user ? { user: input.user.name } : {}) });
    return { runId, status: 'skipped', outputs: [], evidence, cost: 0, turns: 0, note };
  };
  const settleSkipped = (note: string): RunResult<T> => {
    engine.store.settle(runId, { status: 'stopped', cost: 0, turns: 0, outputs: 0, note, now: clock() });
    return { runId, status: 'stopped', outputs: [], evidence, cost: 0, turns: 0, note };
  };
  if (!engine.llmAvailable) return skipped('no LLM credentials configured');
  if (closing) return skipped(`engine is shutting down (${closing})`);
  if (engine.minFreeBytes !== undefined) {
    const free = freeBytes(engine.runsDir);
    if (free !== undefined && free < engine.minFreeBytes) return skipped(`runs volume nearly full (${Math.round(free / 1e6)} MB free)`);
  }
  if (existsSync(engine.stopFile)) return skipped(`kill switch is on${stopDetail(engine.stopFile)}; an admin clears it with resume`);

  const decide = typeof input.challenge === 'function' ? input.challenge : undefined;
  const challenge = decide ? true : (input.challenge ?? spec.challenge.when === 'always'); // may run: reserved up front
  const admission = {
    id: runId,
    agent: spec.name,
    version: agent.version,
    trigger: input.trigger,
    now,
    deadlineMs: spec.limits.deadline_min * 60_000,
    agentCap: spec.limits.usd_per_day,
    ...(engine.agentMonthlyCapUsd?.[spec.name] !== undefined ? { agentMonthlyCap: engine.agentMonthlyCapUsd[spec.name] } : {}),
    globalCap: engine.dailyCapUsd,
    ...(engine.monthlyCapUsd !== undefined ? { monthlyCap: engine.monthlyCapUsd } : {}),
    concurrency: spec.concurrency,
    ...(engine.build ? { build: engine.build } : {}),
    ...(input.user ? { user: input.user.name, userCap: input.user.usdPerDay, userMaxRunning: input.user.maxRunning } : {}),
  };
  let reserve = spec.limits.usd_per_run + (challenge ? spec.challenge.usd : 0);
  let admitted = engine.store.admit({ ...admission, reserve });
  // A challenge decided on the outputs never costs the author its run: when
  // the caps can't hold both, the author runs alone, and a challenge it then
  // needs is recorded as not run.
  let unpaid: string | undefined;
  if (!admitted.ok && decide) {
    unpaid = admitted.reason;
    reserve = spec.limits.usd_per_run;
    admitted = engine.store.admit({ ...admission, reserve });
  }
  if (!admitted.ok) return skipped(admitted.reason);
  if (input.signal?.aborted) return settleSkipped('cancelled before start');

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
  let sources: RunResult<T>['sources'];
  const abort = new AbortController();
  let stopped: 'deadline' | 'stopped' | 'loop' | undefined;
  const stop = (why: 'deadline' | 'stopped' | 'loop', n: string) => {
    if (stopped) return;
    stopped = why;
    note = n;
    abort.abort();
  };
  const timer = setTimeout(() => stop('deadline', `deadline ${spec.limits.deadline_min} min`), spec.limits.deadline_min * 60_000);
  // The kill switch acts within seconds, also while the model is mid-turn.
  const stopPoll = setInterval(() => existsSync(engine.stopFile) && stop('stopped', 'kill switch'), 2000);
  stopPoll.unref();
  // A run whose process died (OOM, SIGKILL) stops beating and is reaped by the
  // next admission, even if a new process got the same pid.
  const heartbeat = setInterval(() => {
    try {
      engine.store.beat(runId, clock());
    } catch {
      /* a missed beat is retried; settlement does not depend on it */
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  input.signal?.addEventListener('abort', () => stop('stopped', String(input.signal?.reason ?? 'cancelled')));
  let markSettled!: () => void;
  INFLIGHT.set(runId, { stop: (n) => stop('stopped', n), settled: new Promise<void>((res) => (markSettled = res)) });
  try {
    input.onAdmitted?.(runId);
  } catch {
    /* a caller's callback must not leave an admitted run unsettled */
  }

  try {
    dir = join(engine.runsDir, spec.name, runId);
    mkdirSync(dir, { recursive: true });
    const runDir = dir;
    const transcript = (by: string, e: SessionEvent) => {
      if (e.kind === 'usage') return; // per-turn cost; the result carries the totals
      try {
        appendFileSync(join(runDir, 'transcript.jsonl'), safeJson({ by, ...e }) + '\n');
      } catch {
        /* a lost transcript line must not fail the run */
      }
    };

    // File tools read snapshots: one commit's files without secret files.
    let roots: string[] | undefined;
    if (input.roots) {
      roots = [];
      sources = [];
      for (const r of input.roots.map((x) => (typeof x === 'string' ? { path: x } : x))) {
        const s = await snapshot(r.path, r.ref);
        temps.push(s.dir);
        roots.push(s.dir);
        sources.push({ path: r.path, ref: s.ref, commit: s.commit, date: s.date });
      }
    }
    const where = roots ? `\n\nThe folder${roots.length > 1 ? 's' : ''} you may read (${sources!.map((s) => `${s.path} at ${s.ref}, commit ${s.commit.slice(0, 10)} of ${s.date}`).join('; ')}; committed files only, secret files removed): ${roots.join(', ')}` : '';
    // The task and context are redacted before the model sees them: a pasted
    // token or customer email in a question must not leave the process.
    const askedTask = redact(input.task);
    const data = input.data === undefined ? undefined : redact(input.data);
    const task = askedTask + where;
    const prompt = [task, ...(data ? ['', fence('context', data)] : [])].join('\n');
    writeFileSync(join(dir, 'input.md'), redact(`# ${spec.name} @ ${agent.version}\n\nengine: ${engine.build ?? 'unknown'}\ntrigger: ${input.trigger}\nchallenge: ${decide ? 'if the outputs need it' : challenge}\n\n${prompt}\n`));

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
    const meter = new SpendMeter();
    const watchAuthor = watcher(engine.stopFile, stop);
    if (stopped) throw new Error('stopped before the model started'); // cancel or STOP while snapshotting
    modelStarted = true;
    try {
      for await (const e of engine.session({
        ...base,
        abort,
        hooks: hooks('author'),
        model: spec.model,
        system: agent.prompt,
        prompt,
        tools: [...(input.tools?.(evidence, 'author', roots) ?? []), submit],
        maxTurns: spec.limits.max_turns,
        maxBudgetUsd: spec.limits.usd_per_run,
      })) {
        transcript('author', e);
        meter.observe(e);
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
    if (!gotResult) cost = meter.unsettled(spec.limits.usd_per_run, firstTurnUsd(spec.model, spec.limits.usd_per_run)); // aborted or crashed: what was spent, plus the turn in flight
    if (evidence.failure && status === 'ok') {
      status = 'error';
      note = evidence.failure;
    }
    if (status === 'ok' && outputs.length === 0) status = 'no_output';

    // Challenger: its own loop detector and its own abort, chained to the run's.
    // One that is due but can't start (a spend cap, or the run was stopped) is
    // recorded as not run, so the outputs read as not verified.
    const due = outputs.length > 0 && (decide ? decide(outputs) : challenge);
    if (due && (unpaid || stopped)) challengeResult = notRun(unpaid ?? note ?? 'run stopped');
    else if (due) {
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
        task: askedTask,
        ...(data ? { data } : {}),
        output: outputs.length === 1 ? outputs[0] : outputs,
        evidence,
        tools: input.tools?.(evidence, 'challenger', roots) ?? [],
        onEvent: (e) => {
          transcript('challenger', e);
          watchChallenger(e);
        },
      });
      const cBroke = cStop ?? evidence.failure;
      if (cBroke && challengeResult.verdict !== 'error') challengeResult = unsound(challengeResult, cBroke);
      cost += challengeResult.cost;
    }
    if (challengeResult) writeFileSync(join(dir, 'challenge.json'), safeJson(challengeResult, 1));
  } catch (err) {
    // Setup or bookkeeping failed (disk full, not a git folder, …).
    if (!stopped) {
      status = 'error';
      note = (err as Error).message.slice(0, 300);
    }
    if (!cost && modelStarted) cost = reserve; // unknown spend: book the whole reservation
  } finally {
    clearTimeout(timer);
    clearInterval(stopPoll);
    clearInterval(heartbeat);
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
        mkdirSync(agent.memory, { recursive: true });
        appendFileSync(join(agent.memory, 'proposed.md'), redact(`\n## ${runId}\n${lessons.map((l) => `- ${l}`).join('\n')}\n`));
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
    INFLIGHT.delete(runId);
    markSettled();
  }
  return { runId, status, outputs, evidence, cost, turns, ...(dir ? { dir } : {}), ...(challengeResult ? { challenge: challengeResult } : {}), ...(note ? { note } : {}), ...(sources ? { sources } : {}) };
}
