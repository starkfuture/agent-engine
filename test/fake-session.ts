import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { mcpName, type Session, type SessionEvent, type SessionRequest } from '../src/engine/session.js';

// Plays the model, as close to the real SDK as matters for the engine:
// - every tool call emits a tool_use event (MCP tools with their mcp__engine__ name),
//   delivered before anything else the script yields;
// - built-in tools outside the session's allowlist are refused;
// - built-in tools run the engine's real hooks around an SDK-shaped response;
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
    for (const m of (this.req.hooks.PostToolUse ?? []).filter(matches))
      for (const h of m.hooks) {
        const out = (await h({ ...base, hook_event_name: 'PostToolUse', tool_response: response } as HookInput, 't', { signal: this.req.abort.signal })) as { hookSpecificOutput?: { updatedToolOutput?: unknown } };
        if (out.hookSpecificOutput?.updatedToolOutput !== undefined) output = out.hookSpecificOutput.updatedToolOutput;
      }
    return typeof output === 'string' ? output : JSON.stringify(output);
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
