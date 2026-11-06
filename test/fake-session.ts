import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { toolText } from '../src/engine/evidence.js';
import { mcpName, type Session, type SessionEvent, type SessionRequest } from '../src/engine/session.js';

// The CLI keeps a PostToolUse rewrite only if it has the tool's output shape
// (same type, same keys with the same types); otherwise the original is shown.
function sameShape(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b);
  if (a && typeof a === 'object') return !!b && typeof b === 'object' && !Array.isArray(b) && Object.keys(a).every((k) => sameShape((a as any)[k], (b as any)[k]));
  return typeof a === typeof b;
}

// Plays the model, as close to the real SDK as matters for the engine:
// - every tool call emits a tool_use event (MCP tools with their mcp__engine__ name),
//   delivered before anything else the script yields;
// - built-in tools outside the session's allowlist are refused;
// - built-in tools run the engine's real hooks around an SDK-shaped response;
//   a rewrite of the wrong shape is dropped, additionalContext is shown next to
//   the result, and continue: false ends the session;
// - once the run is aborted, the stream ends with an error, like query() does.
export class Sim {
  readonly pending: SessionEvent[] = [];
  constructor(readonly req: SessionRequest) {}

  private check() {
    if (this.req.abort.signal.aborted) throw new Error('aborted');
  }

  async mcp(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    this.check();
    this.pending.push({ kind: 'tool_use', name: mcpName(name), input: args });
    const t = this.req.tools.find((x) => x.name === name);
    if (!t) return { text: `error: no such tool ${name}`, isError: true };
    const r = await t.handler(args as never, {});
    return { text: r.content.map((c) => ('text' in c ? c.text : '')).join(''), isError: Boolean(r.isError) };
  }

  async builtin(name: string, input: Record<string, unknown>, response: unknown): Promise<string> {
    this.check();
    this.pending.push({ kind: 'tool_use', name, input });
    if (!this.req.builtin.includes(name)) return `denied: ${name} is not available in this session`;
    const base = { session_id: 's', transcript_path: '', cwd: this.req.cwd, tool_name: name, tool_input: input, tool_use_id: 't' };
    const matches = (m: { matcher?: string }) => !m.matcher || new RegExp(`^(?:${m.matcher})$`).test(name);
    for (const m of (this.req.hooks.PreToolUse ?? []).filter(matches))
      for (const h of m.hooks) {
        const out = (await h({ ...base, hook_event_name: 'PreToolUse' } as HookInput, 't', { signal: this.req.abort.signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
        if (out.hookSpecificOutput?.permissionDecision === 'deny') return `denied: ${out.hookSpecificOutput.permissionDecisionReason}`;
      }
    let output: unknown = response;
    const context: string[] = [];
    for (const m of (this.req.hooks.PostToolUse ?? []).filter(matches))
      for (const h of m.hooks) {
        const out = (await h({ ...base, hook_event_name: 'PostToolUse', tool_response: response } as HookInput, 't', { signal: this.req.abort.signal })) as {
          continue?: boolean;
          stopReason?: string;
          hookSpecificOutput?: { updatedToolOutput?: unknown; additionalContext?: string };
        };
        if (out.continue === false) throw new Error(`stopped by hook: ${out.stopReason ?? ''}`);
        const upd = out.hookSpecificOutput?.updatedToolOutput;
        if (upd !== undefined && sameShape(response, upd)) output = upd;
        if (out.hookSpecificOutput?.additionalContext) context.push(out.hookSpecificOutput.additionalContext);
      }
    return [toolText(output), ...context].join('\n');
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.req.abort.signal.aborted) return reject(new Error('aborted'));
      const t = setTimeout(resolve, ms);
      this.req.abort.signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      });
    });
  }
}

export type Script = (s: Sim) => AsyncGenerator<SessionEvent>;

export const ok = (cost = 0.1, turns = 3): SessionEvent => ({ kind: 'result', ok: true, subtype: 'success', cost, turns, text: 'done' });
// A result whose per-model usage is shaped like the SDK's modelUsage.
export const okWithUsage = (models: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>, cost = 0.1, turns = 3): SessionEvent => ({ ...(ok(cost, turns) as object), usage: { cliCostUsd: cost, models } }) as SessionEvent;
export const fail = (subtype: string, cost = 0.1): SessionEvent => ({ kind: 'result', ok: false, subtype, cost, turns: 2, text: '' });
export const say = (text = '…'): SessionEvent => ({ kind: 'text', text });

// SDK-shaped built-in responses (sdk-tools.d.ts).
export const readResponse = (filePath: string, content: string) => ({ type: 'text', file: { filePath, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } });
export const fetchResponse = (url: string, result: string) => ({ bytes: result.length, code: 200, codeText: 'OK', result, durationMs: 5, url });

// One script per session, in order: the author first, then the challenger.
export function fakeSession(...scripts: Script[]): Session & { requests: SessionRequest[] } {
  const requests: SessionRequest[] = [];
  const session = (req: SessionRequest): AsyncIterable<SessionEvent> => {
    requests.push(req);
    const script = scripts[requests.length - 1];
    if (!script) throw new Error(`no script for session ${requests.length}`);
    const sim = new Sim(req);
    return (async function* () {
      const it = script(sim);
      for (;;) {
        let step: IteratorResult<SessionEvent>;
        try {
          step = await it.next();
        } finally {
          while (sim.pending.length) yield sim.pending.shift()!;
        }
        if (req.abort.signal.aborted) throw new Error('aborted');
        if (step.done) return;
        yield step.value;
      }
    })();
  };
  return Object.assign(session, { requests });
}
