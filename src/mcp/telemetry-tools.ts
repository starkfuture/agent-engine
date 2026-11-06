import { existsSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config, Exposure } from '../config.js';
import { Evidence } from '../engine/evidence.js';
import { forServer } from '../engine/session.js';
import { safeJson } from '../engine/text.js';
import { monitorTools } from '../investigate/tools.js';
import type { McpContext } from './server.js';
import type { User } from './users.js';

// The investigator's read-only telemetry tools, called by a signed-in person
// directly: the same redacted, capped, fenced and evidence-stamped results the
// model gets, with no AI run and no cost. Nothing is offered until
// ENGINE_MCP_TELEMETRY (aggregates) or ENGINE_MCP_TELEMETRY_RAW (log lines,
// traces, PromQL) names admins or members.

// Names the pack doesn't have are skipped, so tools added to it later appear
// here only once listed. recent_changes is left out: `deploys` covers it.
export const AGGREGATE = ['service_overview', 'route_timeline', 'workload_state', 'pod_status', 'firing_alerts'];
export const RAW = ['log_search', 'trace_search', 'promql'];
export const PREFIX = 'tel_';

type Settings = NonNullable<Config['mcp']['telemetry']>;
type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const refuse = (t: string): Result => ({ content: [{ type: 'text', text: `error: ${t}` }], isError: true });

// Calls admitted per person, kept per context (one per process) like the runs
// in flight. A restart forgets them.
interface Window {
  recent: number[]; // admitted calls in the last minute
  day: string; // UTC
  n: number; // admitted calls on `day`
}
const USE = new WeakMap<McpContext, Map<string, Window>>();
const use = (ctx: McpContext) => USE.get(ctx) ?? (USE.set(ctx, new Map()), USE.get(ctx)!);
const MINUTE = 60_000;
// The audit line's arguments, at most: a whole PromQL query fits. A request may
// carry up to 1 MB, and Loki refuses a line over its size limit (256 KB by
// default): a padded argument must not keep its own audit line out.
const AUDIT_ARGS = 4000;

function current(w: Window | undefined, now: number): Window {
  const day = new Date(now).toISOString().slice(0, 10);
  return { recent: (w?.recent ?? []).filter((t) => t > now - MINUTE), day, n: w?.day === day ? w.n : 0 };
}

function overLimit(w: Window, perMinute: number, perDay: number, what: string, now: number, why = ''): string | undefined {
  if (perMinute < 1 || perDay < 1) return `${what} are turned off on this engine`;
  if (w.n >= perDay) return `rate limit: at most ${perDay} ${what} a day per person${why}; try again after ${new Date(Date.parse(w.day) + 24 * 3600_000).toISOString().slice(0, 10)} 00:00Z`;
  if (w.recent.length >= perMinute) return `rate limit: at most ${perMinute} ${what} a minute per person${why}; try again in ${Math.max(1, Math.ceil((w.recent[0]! + MINUTE - now) / 1000))} s`;
  return undefined;
}

// Refuses the call (without counting it) or counts it against the person's
// overall limits and, for trace_search, its own tighter ones.
function admit(ctx: McpContext, who: string, tool: string, l: Settings, now: number): string | undefined {
  const m = use(ctx);
  const keys = tool === 'trace_search' ? [who, `${who}\ntrace_search`] : [who];
  const ws = keys.map((k) => current(m.get(k), now));
  const refused = (ws[1] && overLimit(ws[1], l.traceSearchPerMinute, l.traceSearchPerDay, 'trace_search calls', now, ' (Tempo is shared)')) || overLimit(ws[0]!, l.perMinute, l.perDay, 'telemetry calls', now);
  if (refused) return refused;
  keys.forEach((k, i) => {
    const w = ws[i]!;
    w.recent.push(now);
    w.n++;
    m.set(k, w);
  });
  return undefined;
}

// Who may call one pack tool; a tool on neither list is never offered.
export const levelOf = (name: string, limits: Settings): Exposure => (AGGREGATE.includes(name) ? limits.aggregate : RAW.includes(name) ? limits.raw : 'off');

export function registerTelemetryTools(s: McpServer, ctx: McpContext, user: User): void {
  const tel = ctx.telemetry;
  const limits = ctx.cfg.mcp.telemetry;
  if (!tel || !limits) return;
  const level = (name: string) => levelOf(name, limits);
  const offered = (name: string) => {
    const l = level(name);
    if (l === 'off' || (l === 'admins' && user.role !== 'admin')) return false;
    return !((name === 'log_search' && !tel.has.loki) || (name === 'trace_search' && !tel.has.tempo));
  };
  // The same check as the admin tools': demoted, removed or re-tokened since the request arrived.
  const stillAdmin = () => {
    const now = ctx.users.list().find((u) => u.name === user.name);
    return now?.role === 'admin' && now.token_sha256 === user.token_sha256 && now.email === user.email;
  };
  // Built per call, so each query reads up to now. The evidence registry lives
  // for that one call; its `by` names the person, not a run role.
  const pack = () => monitorTools(tel, ctx.cfg, new Date())(new Evidence(), `mcp:${user.name}` as 'author').map(forServer);

  for (const t of pack()) {
    if (!offered(t.name)) continue;
    const name = PREFIX + t.name;
    const admins = level(t.name) === 'admins';
    const per = t.name === 'trace_search' ? ` (trace_search: ${limits.traceSearchPerMinute} a minute, ${limits.traceSearchPerDay} a day)` : '';
    s.registerTool(
      name,
      {
        description: `${admins ? 'Admin: ' : ''}${t.description} Read-only production telemetry: no AI run, no cost; redacted and capped like the investigator's results, and "the patrol time" is now. At most ${limits.perMinute} calls a minute and ${limits.perDay} a day per person${per}.`,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: true },
      },
      async (args: Record<string, unknown>, extra: unknown) => {
        const refusal = (): [code: string, text: string] | undefined => {
          if (admins && !stillAdmin()) return ['not-admin', 'you are no longer an admin'];
          if (existsSync(ctx.engine.stopFile)) return ['stop', 'STOP is set: telemetry tools are off until an admin runs resume'];
          const limited = admit(ctx, user.name, t.name, limits, Date.now());
          return limited ? ['rate-limit', limited] : undefined;
        };
        let status = 'error';
        let r: Result = refuse('the call failed');
        try {
          const why = refusal();
          if (why) {
            status = `refused:${why[0]}`;
            r = refuse(why[1]);
          } else {
            r = (await pack().find((x) => x.name === t.name)!.handler(args, extra)) as Result;
            status = r.isError ? 'error' : 'ok';
          }
          return r;
        } finally {
          // One audit line per call; the arguments are redacted, never raw, and capped.
          const a = safeJson(args ?? {});
          ctx.log?.(`telemetry call user=${user.name} tool=${name} result=${status} size=${r.content.reduce((n, c) => n + c.text.length, 0)} args=${a.length > AUDIT_ARGS ? `${a.slice(0, AUDIT_ARGS)}… [${a.length} chars]` : a}`);
        }
      },
    );
  }
}
