import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config.js';
import type { Telemetry } from '../clients/telemetry.js';
import { fence } from '../patrol/text.js';
import { renderSummary, type Summary } from '../patrol/summary.js';
import { SYSTEM_PROMPT, userPrompt } from './prompt.js';
import type { Report } from './report.js';
import { buildInvestigation } from './tools.js';

export interface InvestigationResult {
  reports: Report[];
  costUsd: number;
  turns: number;
  toolCalls: number;
  outcome: 'ok' | 'no_report' | 'error' | 'budget';
  note?: string;
}

// The subprocess gets only what it needs to reach the model. No Grafana token:
// the tools run in this process, the model only sees their output.
function llmEnv(): Record<string, string | undefined> {
  const keep = /^(PATH|HOME|TMPDIR|LANG|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|AWS_REGION|AWS_PROFILE|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|HTTPS?_PROXY|NO_PROXY)$/;
  const env: Record<string, string | undefined> = { CLAUDE_AGENT_SDK_CLIENT_APP: 'sre-agent/0.1.0', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' };
  for (const [k, v] of Object.entries(process.env)) if (keep.test(k)) env[k] = v;
  return env;
}

export async function investigate(tel: Telemetry, cfg: Config, summary: Summary, at: Date): Promise<InvestigationResult> {
  const rowKeys = summary.send.map((r) => r.key);
  const inv = buildInvestigation(tel, cfg, at, new Set(rowKeys));
  let costUsd = 0;
  let turns = 0;
  let outcome: InvestigationResult['outcome'] = 'ok';
  let note: string | undefined;

  const run = query({
    prompt: userPrompt(fence('patrol-summary', renderSummary(summary)), rowKeys),
    options: {
      model: cfg.llm.model,
      systemPrompt: SYSTEM_PROMPT,
      tools: [], // no built-in tools: no shell, no files, no web
      mcpServers: { sre: inv.server },
      allowedTools: inv.toolNames,
      strictMcpConfig: true,
      settingSources: [], // ignore ~/.claude and any CLAUDE.md
      permissionMode: 'dontAsk', // anything not in allowedTools is denied, never prompted
      maxTurns: cfg.llm.maxTurns,
      maxBudgetUsd: cfg.llm.maxUsdPerInvestigation,
      persistSession: false,
      cwd: mkdtempSync(join(tmpdir(), 'sre-agent-')),
      env: llmEnv(),
    },
  });

  try {
    for await (const m of run) {
      if (m.type === 'result') {
        costUsd = m.total_cost_usd ?? 0;
        turns = m.num_turns ?? 0;
        if (m.subtype !== 'success') {
          outcome = m.subtype === 'error_max_budget_usd' ? 'budget' : 'error';
          note = m.subtype;
        } else if (m.is_error) {
          outcome = 'error';
          note = m.result.slice(0, 300);
        }
      }
    }
  } catch (e) {
    outcome = 'error';
    note = (e as Error).message.slice(0, 300);
  }
  if (outcome === 'ok' && inv.reports.length === 0) outcome = 'no_report';
  return { reports: inv.reports, costUsd, turns, toolCalls: inv.evidence.size, outcome, ...(note ? { note } : {}) };
}
