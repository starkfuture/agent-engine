import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query, type HookCallbackMatcher, type HookEvent, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

// Everything one model session needs. The engine builds it; a Session runs it.
// Tests swap in a fake Session that calls the tool handlers directly.
export interface SessionRequest {
  model: string;
  system: string;
  prompt: string;
  tools: SdkMcpToolDefinition<any>[]; // in-process tools (credentialed packs + submit)
  builtin: string[]; // built-in Claude Code tools allowed in this session
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  maxTurns: number;
  maxBudgetUsd: number;
  abort: AbortController;
  cwd: string;
  roots?: string[]; // folders file tools may read (snapshots); cwd is the first
  pluginDir?: string; // agent folder with skills/ and agents/
}

// Read deny rules for the CLI. It turns them into ripgrep exclusions and checks
// every Grep/Glob result against them, so they hold per file, not per call.
// Belt and braces: the snapshot already leaves these files out.
export const READ_DENY = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/.npmrc', '**/.netrc', '**/*.tfstate', '**/kubeconfig'].map((g) => `Read(${g})`);

export type SessionEvent =
  | { kind: 'tool_use'; name: string; input: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'result'; ok: boolean; subtype: string; cost: number; turns: number; text: string; usage?: unknown } // usage: per-model tokens and cost basis, kept in transcript.jsonl
  | { kind: 'usage'; id: string; cost?: number }; // one completed model turn; cost undefined when the model has no price

export type Session = (r: SessionRequest) => AsyncIterable<SessionEvent>;

export const MCP_NAME = 'engine';
export const mcpName = (tool: string) => `mcp__${MCP_NAME}__${tool}`;

// The subprocess gets only what it needs to reach the model. Credentialed tools
// run in this process; the model only sees their output.
function llmEnv(): Record<string, string | undefined> {
  const keep =
    /^(PATH|LANG|NODE_EXTRA_CA_CERTS|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_BEDROCK_BASE_URL|CLAUDE_CODE_USE_BEDROCK|AWS_BEARER_TOKEN_BEDROCK|AWS_REGION|AWS_DEFAULT_REGION|AWS_PROFILE|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|AWS_STS_REGIONAL_ENDPOINTS|AWS_ROLE_ARN|AWS_ROLE_SESSION_NAME|AWS_WEB_IDENTITY_TOKEN_FILE|AWS_CONTAINER_CREDENTIALS_FULL_URI|AWS_CONTAINER_CREDENTIALS_RELATIVE_URI|AWS_CONTAINER_AUTHORIZATION_TOKEN|AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE|HTTPS?_PROXY|NO_PROXY)$/;
  const env: Record<string, string | undefined> = {
    CLAUDE_AGENT_SDK_CLIENT_APP: 'agent-engine/0.1.0',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  };
  for (const [k, v] of Object.entries(process.env)) if (keep.test(k)) env[k] = v;
  // A throwaway HOME keeps ~/.claude, ~/.aws and dotfiles out of reach. Bedrock
  // via an SSO profile needs the real one for its token cache.
  env.HOME = process.env.CLAUDE_CODE_USE_BEDROCK === '1' ? process.env.HOME : mkdtempSync(join(tmpdir(), 'engine-home-'));
  env.TMPDIR = process.env.TMPDIR;
  return env;
}

// Skills and subagents load as a local plugin, so the folder never needs
// settingSources (which would also load parent CLAUDE.md files and settings).
// The copy also pins what this run loaded, whatever happens to the folder mid-run.
export function pluginCopy(dir: string, name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'engine-plugin-'));
  mkdirSync(join(root, '.claude-plugin'));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '0.0.0' }));
  for (const sub of ['skills', 'agents']) if (existsSync(join(dir, sub))) cpSync(join(dir, sub), join(root, sub), { recursive: true });
  return root;
}

// $/MTok: input, output, cache write (5 min), cache read. First-party list
// prices (research/ai-sre-2026-10-07/04-runtime-hosting.md). Bedrock EU is
// assumed at 1.1x; confirm on the AWS bill.
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-sonnet-5-5': [2, 10, 2.5, 0.2],
  'claude-opus-5-5': [4, 20, 5, 0.2],
};
const BEDROCK_EU = 1.1;

interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  costUSD?: number;
  costBasis?: string;
  canonicalModel?: string;
}

// The CLI prices models it doesn't know (costBasis "unknown") at a fallback
// rate: Sonnet 5.5 is booked at Opus 5.5 prices. Re-price those from tokens
// with our table; keep the CLI's number for anything we can't price.
export function realCost(cliTotal: number, usage: unknown, multiplier = 1): number {
  if (!usage || typeof usage !== 'object') return cliTotal;
  let sum = 0;
  for (const [model, raw] of Object.entries(usage as Record<string, ModelUsage>)) {
    const u = raw ?? {};
    if (u.costBasis === 'list' && typeof u.costUSD === 'number') {
      sum += u.costUSD;
      continue;
    }
    const p = PRICES[u.canonicalModel ?? model];
    if (!p) return cliTotal; // unknown model: stay conservative
    sum += (((u.inputTokens ?? 0) * p[0] + (u.outputTokens ?? 0) * p[1] + (u.cacheCreationInputTokens ?? 0) * p[2] + (u.cacheReadInputTokens ?? 0) * p[3]) / 1e6) * multiplier;
  }
  return sum;
}

// Price one model turn from its usage block (Messages API field names).
export function turnCost(model: string, u: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } | undefined, multiplier = 1): number | undefined {
  const key = Object.keys(PRICES).find((k) => model.includes(k));
  if (!key || !u) return undefined;
  const p = PRICES[key]!;
  return (((u.input_tokens ?? 0) * p[0] + (u.output_tokens ?? 0) * p[1] + (u.cache_creation_input_tokens ?? 0) * p[2] + (u.cache_read_input_tokens ?? 0) * p[3]) / 1e6) * multiplier;
}

// What a session spent so far, from completed turns. Used when a session ends
// without a result message (cancelled, deadline, crash): book what was spent
// plus the turn that may have been in flight, never more than the allowance.
// If spend can't be known (turns happened but no usage arrived, or a model
// has no price), book the whole allowance.
export class SpendMeter {
  private readonly seen = new Set<string>();
  private priced = 0;
  private unpriced = false;
  private steps = 0;

  observe(e: SessionEvent): void {
    if (e.kind === 'usage') {
      if (this.seen.has(e.id)) return;
      this.seen.add(e.id);
      if (e.cost === undefined) this.unpriced = true;
      else this.priced += e.cost;
    } else if (e.kind === 'tool_use' || e.kind === 'text') this.steps++;
  }

  unsettled(allowance: number): number {
    if (this.unpriced || (this.steps > 0 && this.seen.size === 0)) return allowance;
    return Math.min(allowance, this.priced + Math.max(0.25 * allowance, 0.5));
  }
}

export const sdkSession: Session = async function* (r) {
  const server = createSdkMcpServer({ name: MCP_NAME, version: '0.1.0', tools: r.tools, alwaysLoad: true, timeout: 60_000 });
  const plugins = r.pluginDir ? [{ type: 'local' as const, path: r.pluginDir }] : [];
  const run = query({
    prompt: r.prompt,
    options: {
      model: r.model,
      systemPrompt: r.system,
      tools: r.builtin, // [] = no shell, no files, no web
      mcpServers: { [MCP_NAME]: server },
      allowedTools: [...r.builtin, ...r.tools.map((t) => mcpName(t.name))],
      strictMcpConfig: true,
      settingSources: [], // no ~/.claude, no CLAUDE.md from parent folders
      plugins,
      ...(r.pluginDir ? { skills: 'all' as const } : {}),
      ...(r.roots && r.roots.length > 1 ? { additionalDirectories: r.roots.slice(1) } : {}),
      settings: {
        disableSkillShellExecution: true,
        ...(r.roots ? { permissions: { deny: READ_DENY, blockReadsOutsideWorkingDirectories: true } } : {}),
      },
      permissionMode: 'dontAsk', // anything not allowed is denied, never prompted
      hooks: r.hooks,
      maxTurns: r.maxTurns,
      maxBudgetUsd: r.maxBudgetUsd,
      abortController: r.abort,
      persistSession: false,
      cwd: r.cwd,
      env: llmEnv(),
    },
  });
  const multiplier = process.env.CLAUDE_CODE_USE_BEDROCK === '1' ? BEDROCK_EU : 1;
  for await (const m of run) {
    if (m.type === 'assistant') {
      yield { kind: 'usage', id: m.message.id ?? m.uuid, cost: turnCost(String(m.message.model ?? r.model), m.message.usage as never, multiplier) };
      for (const b of m.message.content) {
        if (b.type === 'tool_use') yield { kind: 'tool_use', name: b.name, input: b.input };
        else if (b.type === 'text') yield { kind: 'text', text: b.text };
      }
    } else if (m.type === 'result') {
      const ok = m.subtype === 'success' && !m.is_error;
      const cost = realCost(m.total_cost_usd ?? 0, m.modelUsage, multiplier);
      yield { kind: 'result', ok, subtype: m.subtype, cost, turns: m.num_turns ?? 0, text: m.subtype === 'success' ? m.result : '', usage: { cliCostUsd: m.total_cost_usd, models: m.modelUsage } };
    }
  }
};

