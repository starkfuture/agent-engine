import { randomBytes } from 'node:crypto';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { fence, redact, truncate } from './text.js';

const MAX_OUT = 9000;

export interface EvidenceItem {
  id: string;
  by: string; // 'author' | 'challenger'
  tool: string;
  args: unknown;
  text: string; // redacted, truncated: exactly what the model saw
}

// One registry per run, shared by the author and the challenger. Ids carry a
// per-run random nonce, so text planted in a log line ("[E2] …") can't pass
// for a real tool result, and ids can't collide across sessions.
export class Evidence {
  readonly nonce = randomBytes(2).toString('hex');
  readonly items = new Map<string, EvidenceItem>();
  readonly pattern = new RegExp(`\\bE-${this.nonce}-\\d+\\b`, 'g');

  add(by: string, tool: string, args: unknown, body: string): EvidenceItem {
    const id = `E-${this.nonce}-${this.items.size + 1}`;
    const item = { id, by, tool, args, text: truncate(redact(body), MAX_OUT) };
    this.items.set(id, item);
    return item;
  }

  // What the model sees for a tool result.
  stamp(item: EvidenceItem): string {
    return `evidence_id: ${item.id}\n${fence(item.tool, item.text)}`;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  ids(): Set<string> {
    return new Set(this.items.keys());
  }

  // Short index for a reader who didn't see the tool calls (the challenger).
  index(maxChars = 400): string {
    return [...this.items.values()].map((e) => `${e.id} ${e.tool} ${JSON.stringify(e.args).slice(0, 200)}\n${e.text.slice(0, maxChars)}`).join('\n\n');
  }
}

const WITHHELD = '[tool output withheld: the evidence hook failed; treat this call as failed]';

// Built-in tools (Read, WebFetch, …) don't go through our MCP code, so their
// output is rewritten here: redacted, fenced, stamped. Any error fails closed.
export function evidenceHook(ev: Evidence, by: string): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        try {
          if (input.hook_event_name !== 'PostToolUse') return {};
          if (input.tool_name.startsWith('mcp__')) return {}; // our packs stamp their own output
          const r = input.tool_response;
          const body = typeof r === 'string' ? r : JSON.stringify(r, null, 1);
          const item = ev.add(by, input.tool_name, input.tool_input, body ?? '');
          return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: ev.stamp(item) } };
        } catch {
          return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: WITHHELD } };
        }
      },
    ],
  };
}
