import { randomBytes } from 'node:crypto';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { fence, redact, redactDeep, safeJson, truncate } from './text.js';

const MAX_OUT = 9000;

export interface EvidenceItem {
  id: string;
  by: string; // 'author' | 'challenger'
  tool: string;
  args: unknown; // redacted
  text: string; // redacted, truncated: exactly what the model saw
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// One registry per run, shared by the author and the challenger. Ids carry a
// per-run random nonce, so text planted in a log line ("[E2] …") can't pass
// for a real tool result, and ids can't collide across sessions.
export class Evidence {
  readonly nonce = randomBytes(2).toString('hex');
  readonly items = new Map<string, EvidenceItem>();

  add(by: string, tool: string, args: unknown, body: string): EvidenceItem {
    const id = `E-${this.nonce}-${this.items.size + 1}`;
    const item = { id, by, tool, args: redactDeep(args), text: truncate(redact(body), MAX_OUT) };
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

  // The cheapest deterministic grounding: the quoted text must really be in
  // that tool result. It proves the text exists, not that it supports the claim.
  quoteProblem(id: string, quote: string): string | undefined {
    const item = this.items.get(id);
    if (!item) return `evidence ${id} does not match any tool result in this run`;
    if (!norm(item.text).includes(norm(quote))) return `quote not found in ${id}: "${quote.slice(0, 80)}"`;
    return undefined;
  }

  byWhom(by: string): number {
    return [...this.items.values()].filter((e) => e.by === by).length;
  }

  // Short index for a reader who didn't see the tool calls (the challenger).
  index(maxChars = 400): string {
    return [...this.items.values()].map((e) => `${e.id} ${e.tool} ${safeJson(e.args).slice(0, 200)}\n${e.text.slice(0, maxChars)}`).join('\n\n');
  }
}

// Built-in tools return objects. Give the model the content, not an escaped
// JSON blob: file text for Read, the answer for WebFetch, matches for Grep.
export function toolText(response: unknown): string {
  if (typeof response === 'string') return response;
  const r = (response ?? {}) as Record<string, any>;
  if (typeof r.file?.content === 'string') return `${r.file.filePath ?? ''}\n${r.file.content}`;
  if (typeof r.result === 'string') return r.result;
  if (typeof r.content === 'string') return r.content;
  if (Array.isArray(r.filenames)) return r.filenames.join('\n');
  return safeJson(r, 1);
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
          const item = ev.add(by, input.tool_name, input.tool_input, toolText(input.tool_response));
          return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: ev.stamp(item) } };
        } catch {
          return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: WITHHELD } };
        }
      },
    ],
  };
}
