import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { Session, SessionEvent, SessionRequest } from '../src/engine/session.js';

// Plays the model: a script decides which tools to call. MCP tools run their
// real handlers; built-in tools run the engine's real hooks around a canned
// response, the way Claude Code would.
export class Sim {
  constructor(readonly req: SessionRequest) {}

  private check() {
    if (this.req.abort.signal.aborted) throw new Error('aborted');
  }

  async mcp(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    this.check();
    const t = this.req.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    const r = await t.handler(args as never, {});
    const text = r.content.map((c) => ('text' in c ? c.text : '')).join('');
    return { text, isError: Boolean(r.isError) };
  }

  async builtin(name: string, input: Record<string, unknown>, response: unknown): Promise<string> {
    this.check();
    const base = { session_id: 's', transcript_path: '', cwd: this.req.cwd, tool_name: name, tool_input: input, tool_use_id: 't' };
    for (const m of this.req.hooks.PreToolUse ?? []) {
      if (m.matcher && !new RegExp(`^(?:${m.matcher})$`).test(name)) continue;
      for (const h of m.hooks) {
        const out = (await h({ ...base, hook_event_name: 'PreToolUse' } as HookInput, 't', { signal: this.req.abort.signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
        if (out.hookSpecificOutput?.permissionDecision === 'deny') return `denied: ${out.hookSpecificOutput.permissionDecisionReason}`;
      }
    }
    let output: unknown = response;
    for (const m of this.req.hooks.PostToolUse ?? [])
      for (const h of m.hooks) {
        const out = (await h({ ...base, hook_event_name: 'PostToolUse', tool_response: response } as HookInput, 't', { signal: this.req.abort.signal })) as { hookSpecificOutput?: { updatedToolOutput?: unknown } };
        if (out.hookSpecificOutput?.updatedToolOutput !== undefined) output = out.hookSpecificOutput.updatedToolOutput;
      }
    return String(output);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
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
export const use = (name: string, input: unknown = {}): SessionEvent => ({ kind: 'tool_use', name, input });

// One script per session, in order: the author first, then the challenger.
export function fakeSession(...scripts: Script[]): Session & { requests: SessionRequest[] } {
  const requests: SessionRequest[] = [];
  const session = (req: SessionRequest) => {
    requests.push(req);
    const script = scripts[requests.length - 1];
    if (!script) throw new Error(`no script for session ${requests.length}`);
    return script(new Sim(req));
  };
  return Object.assign(session, { requests });
}
