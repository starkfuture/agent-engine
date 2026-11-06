import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { MCP_NAME } from '../engine/session.js';
import { redact, safeJson } from '../engine/text.js';

// What a running run has done so far, read from its transcript.jsonl (run.ts
// appends one line per model event). Code only: no model call, no cost. The
// transcript is redacted when written; everything shown here is redacted again
// and capped, so an older or hand-edited transcript can't leak through.

export const PROGRESS_EVERY_MS = 5_000;
const ARGS_MAX = 80;
const SHOWN = 10; // calls listed in get_run; earlier ones become a count
const BLOCK_MAX = 2_000;
const LINE_MAX = 300;
const READ_MAX = 1_000_000; // bytes read from the end of a transcript, every 5 s while a call waits

export interface Step {
  by: 'author' | 'challenger';
  tool: string;
  args: string; // redacted, one line, at most ARGS_MAX characters
}

export interface RunProgress {
  steps: Step[];
  challenger: boolean; // the challenger has started
  lastAt?: Date; // when the transcript last grew
  earlier?: boolean; // longer than READ_MAX: calls before its last part were not read
  unreadable?: boolean; // the transcript exists but could not be read
}

const PREFIX = `mcp__${MCP_NAME}__`;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

// Redact first, then cut: a cut first could split a secret so no pattern matches it.
function argSummary(tool: string, input: unknown): string {
  if (tool.startsWith('submit_')) return ''; // the whole answer; get_run shows it once submitted
  const s = oneLine(redact(safeJson(input ?? {})));
  return s === '{}' ? '' : cap(s, ARGS_MAX);
}

export function runProgress(dir: string): RunProgress {
  let fd: number;
  try {
    fd = openSync(join(dir, 'transcript.jsonl'), 'r');
  } catch (e) {
    // No transcript yet. Any other failure must not read as "no tool calls".
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { steps: [], challenger: false } : { steps: [], challenger: false, unreadable: true };
  }
  let raw: string;
  let lastAt: Date;
  let earlier = false;
  try {
    const st = fstatSync(fd);
    lastAt = st.mtime;
    const from = Math.max(0, st.size - READ_MAX);
    const buf = Buffer.alloc(st.size - from);
    raw = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, from));
    if (from > 0) {
      earlier = true;
      raw = raw.slice(raw.indexOf('\n') + 1); // its first line is cut
    }
  } catch {
    return { steps: [], challenger: false, unreadable: true };
  } finally {
    closeSync(fd);
  }
  const steps: Step[] = [];
  let challenger = false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: { by?: unknown; kind?: unknown; name?: unknown; input?: unknown };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue; // the line being written
    }
    if (e.by === 'challenger') challenger = true;
    if (e.kind !== 'tool_use' || typeof e.name !== 'string') continue;
    const tool = cap(oneLine(redact(e.name.startsWith(PREFIX) ? e.name.slice(PREFIX.length) : e.name)), 60);
    steps.push({ by: e.by === 'challenger' ? 'challenger' : 'author', tool, args: argSummary(tool, e.input) });
  }
  return { steps, challenger, lastAt, ...(earlier ? { earlier } : {}) };
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function calls(p: RunProgress): string {
  const n = p.steps.length;
  if (p.unreadable) return 'transcript unreadable';
  if (p.earlier) return `${n || 'no'} recent tool call${n === 1 ? '' : 's'} (earlier ones not read)`;
  return n === 0 ? 'no tool calls yet' : `${n} tool call${n === 1 ? '' : 's'}`;
}
const step = (x: Step) => `${x.by === 'challenger' ? 'challenger: ' : ''}${x.tool}${x.args ? ` ${x.args}` : ''}`;
const elapsed = (startedAt: string, now: Date) => {
  const t = Date.parse(startedAt);
  return Number.isFinite(t) ? `${duration(now.getTime() - t)} so far` : 'running';
};

// get_run on a running run: elapsed time, the calls so far (the latest last),
// and how long ago the run last did anything.
export function progressBlock(p: RunProgress, startedAt: string, now: Date): string {
  const head = [
    `(still running) ${elapsed(startedAt, now)}`,
    calls(p),
    ...(p.lastAt && p.steps.length ? [`last activity ${duration(now.getTime() - p.lastAt.getTime())} ago`] : []),
    ...(p.challenger ? ['the challenger is checking the answer'] : []),
  ].join(' · ');
  const from = Math.max(0, p.steps.length - SHOWN);
  // Past READ_MAX the calls' numbers in the whole run are unknown: no numbers then.
  const lines = [
    head,
    ...(p.earlier ? ['  … earlier calls not read (a long transcript)'] : from ? [`  … ${from} earlier call${from === 1 ? '' : 's'}`] : []),
    ...p.steps.slice(from).map((x, i) => `  ${p.earlier ? '-' : `${from + i + 1}.`} ${step(x)}`),
  ];
  return cap(redact(lines.join('\n')), BLOCK_MAX);
}

// One line per progress notification: the run id first, so a client that gives
// up waiting still knows which run to read with get_run.
export function progressLine(agent: string, runId: string, p: RunProgress, startedAt: string, now: Date): string {
  const last = p.steps.at(-1);
  const parts = [`${agent} run ${runId}: ${elapsed(startedAt, now)}`, calls(p), ...(last ? [`last ${step(last)}`] : []), ...(p.challenger ? ['challenger checking'] : [])];
  return cap(redact(parts.join(' · ')), LINE_MAX);
}

type Extra = Pick<RequestHandlerExtra<ServerRequest, ServerNotification>, '_meta' | 'sendNotification' | 'signal'>;

// While a tool call waits: notifications/progress at once and then every
// `everyMs`, only when the caller sent a progress token. Returns the stop
// function. Never throws: a failed send (client gone, JSON-response transport)
// is dropped and the wait goes on.
export function progressNotifier(extra: Extra, message: () => string, everyMs = PROGRESS_EVERY_MS): () => void {
  const token = extra._meta?.progressToken;
  if (token === undefined || extra.signal.aborted) return () => {};
  let n = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      const params = { progressToken: token, progress: ++n, message: message() };
      void extra.sendNotification({ method: 'notifications/progress', params }).catch(() => {});
    } catch {
      /* a progress message must never fail the call */
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    extra.signal.removeEventListener('abort', stop);
  };
  extra.signal.addEventListener('abort', stop, { once: true });
  tick();
  return stop;
}
