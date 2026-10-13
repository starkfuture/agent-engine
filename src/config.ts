import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const HttpFamily = z.object({
  id: z.string(),
  selector: z.string(),
  // Either a fixed service name or the label that carries it.
  service: z.string().optional(),
  service_label: z.string().optional(),
  // No route label = one row per status for the whole service.
  route_label: z.string().optional(),
  status_label: z.string(),
});
export type HttpFamily = z.infer<typeof HttpFamily>;

const ErrorCounter = z.object({
  id: z.string(),
  selector: z.string(),
  group_by: z.array(z.string()).min(1),
});
export type ErrorCounter = z.infer<typeof ErrorCounter>;

const Sources = z.object({
  http_families: z.array(HttpFamily),
  error_counters: z.array(ErrorCounter).default([]),
  workloads: z.object({ namespaces: z.string() }),
  logs: z.object({
    selector: z.string(),
    error_filter: z.string(),
    service_label: z.string(),
    max_lines: z.number().int().positive().max(5000),
  }),
  traces: z.object({ traceql: z.string(), limit: z.number().int().positive().max(1000) }),
});
export type Sources = z.infer<typeof Sources>;

export interface Config {
  grafanaUrl: string;
  grafanaTokenFile: string;
  promUid: string;
  lokiUid: string | undefined;
  tempoUid: string | undefined;
  windowMinutes: number;
  sources: Sources;
  noiseFile: string;
  stateFile: string;
  outDir: string;
  llm: {
    // True when some credential the Agent SDK can use is present.
    available: boolean;
    // Across all agents. Per-agent limits live in agents/<name>/agent.yaml.
    dailyCapUsd: number;
  };
  agentsDir: string;
  runsDir: string;
  slackWebhookUrl: string | undefined;
}

const expandHome = (p: string) => (p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p));
const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));
const opt = (v: string | undefined) => (v === undefined || v === '' ? undefined : v);

// Minimal .env reader: KEY=VALUE lines, no interpolation. Real env wins.
export function loadDotEnv(file = resolve('.env'), env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, k, v] = m as unknown as [string, string, string];
    if (env[k] === undefined) env[k] = v.replace(/^(['"])(.*)\1$/, '$2');
  }
}

export function loadSources(file: string): Sources {
  return Sources.parse(parse(readFileSync(file, 'utf8')));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): Config {
  const r = (p: string) => resolve(root, p);
  return {
    grafanaUrl: (env.GRAFANA_URL ?? 'https://monitoring.starkfuture.com').replace(/\/$/, ''),
    grafanaTokenFile: expandHome(env.GRAFANA_TOKEN_FILE ?? '~/.config/golive/grafana-token'),
    promUid: env.PROM_DATASOURCE_UID || 'prometheus',
    lokiUid: opt(env.LOKI_DATASOURCE_UID),
    tempoUid: opt(env.TEMPO_DATASOURCE_UID),
    windowMinutes: num(env.PATROL_WINDOW_MINUTES, 15),
    sources: loadSources(r(env.SRE_SOURCES_FILE ?? 'config/sources.yaml')),
    noiseFile: r(env.SRE_NOISE_FILE ?? 'config/noise.yaml'),
    stateFile: r(env.SRE_STATE_FILE ?? '.state/state.json'),
    outDir: r(env.SRE_OUT_DIR ?? 'out'),
    llm: {
      available: Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_USE_BEDROCK === '1'),
      dailyCapUsd: num(env.ENGINE_DAILY_CAP_USD, 20),
    },
    agentsDir: r(env.ENGINE_AGENTS_DIR ?? 'agents'),
    runsDir: r(env.ENGINE_RUNS_DIR ?? 'runs'),
    slackWebhookUrl: opt(env.SLACK_WEBHOOK_URL),
  };
}
