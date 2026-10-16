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
  // In-cluster backends (hosted). When PROMETHEUS_URL is set these are used
  // directly and Grafana is not; locally, Grafana's proxy with a token.
  direct: { prometheusUrl: string; lokiUrl: string | undefined; lokiOrgId: string | undefined; tempoUrl: string | undefined } | undefined;
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
    monthlyCapUsd: number;
  };
  agentsDir: string;
  memoryDir: string | undefined; // runtime lessons and proposals (a persistent volume when hosted); unset = in the agent folders
  runsDir: string;
  build: string | undefined; // engine code version (image tag or commit), recorded on every run
  slackWebhookUrl: string | undefined;
  mcp: {
    usersFile: string; // hashed tokens, one per person (gitignored)
    reposFile: string; // repos the codebase agent may read on this host (gitignored)
    userDailyCapUsd: number; // per person, across agents
    userMaxRunning: number; // per person, at once
    notifySlack: boolean; // @-mention the requester in Slack when a run ends
    allowedOrigins: string[]; // browser origins allowed to call the endpoint; MCP clients send none
    // Agents this server offers (ENGINE_AGENTS=monitor,codebase); unset = all.
    // Hosted, web-reading agents run in their own deployment, away from prod data.
    agents: string[] | undefined;
    // Google login that issues tokens (GOOGLE_CLIENT_ID/SECRET, ENGINE_PUBLIC_URL).
    login: { clientId: string; clientSecret: string; publicUrl: string; domain: string } | undefined;
    reposDir: string | undefined; // where the engine clones `github:` repos (a persistent volume when hosted)
    // GitHub App (contents: read) the engine fetches those repos as.
    githubApp: { appId: string; installationId: string; privateKeyFile: string } | undefined;
  };
}

const expandHome = (p: string) => (p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p));
// A malformed number must stop the program: NaN in a cap comparison is always
// false, which would silently disable the cap.
const num = (v: string | undefined, d: number, name = 'value') => {
  if (v === undefined || v.trim() === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${v}"`);
  return n;
};
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

// All three or none: a half-configured login must stop the server, not run open.
function loginConfig(env: NodeJS.ProcessEnv): Config['mcp']['login'] {
  const [clientId, clientSecret, publicUrl] = [opt(env.GOOGLE_CLIENT_ID), opt(env.GOOGLE_CLIENT_SECRET), opt(env.ENGINE_PUBLIC_URL)];
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret || !publicUrl) throw new Error('Google login needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ENGINE_PUBLIC_URL');
  if (!/^https:\/\//.test(publicUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(publicUrl)) throw new Error('ENGINE_PUBLIC_URL must be https (or localhost for testing)');
  return { clientId, clientSecret, publicUrl, domain: env.ENGINE_LOGIN_DOMAIN || 'starkfuture.com' };
}

export function loadSources(file: string): Sources {
  return Sources.parse(parse(readFileSync(file, 'utf8')));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): Config {
  const r = (p: string) => resolve(root, p);
  const legacy = ['SRE_MODEL', 'SRE_MAX_USD_PER_INVESTIGATION', 'SRE_DAILY_CAP_USD', 'SRE_MAX_TURNS'].filter((k) => env[k] !== undefined);
  if (legacy.length) throw new Error(`${legacy.join(', ')} no longer apply: set model and limits in agents/monitor/agent.yaml and the global cap in ENGINE_DAILY_CAP_USD`);
  return {
    direct: env.PROMETHEUS_URL
      ? { prometheusUrl: env.PROMETHEUS_URL, lokiUrl: opt(env.LOKI_URL), lokiOrgId: opt(env.LOKI_ORG_ID), tempoUrl: opt(env.TEMPO_URL) }
      : undefined,
    grafanaUrl: (env.GRAFANA_URL ?? 'https://monitoring.starkfuture.com').replace(/\/$/, ''),
    grafanaTokenFile: expandHome(env.GRAFANA_TOKEN_FILE ?? '~/.config/golive/grafana-token'),
    promUid: env.PROM_DATASOURCE_UID || 'prometheus',
    lokiUid: opt(env.LOKI_DATASOURCE_UID),
    tempoUid: opt(env.TEMPO_DATASOURCE_UID),
    windowMinutes: num(env.PATROL_WINDOW_MINUTES, 15, 'PATROL_WINDOW_MINUTES'),
    sources: loadSources(r(env.SRE_SOURCES_FILE ?? 'config/sources.yaml')),
    noiseFile: r(env.SRE_NOISE_FILE ?? 'config/noise.yaml'),
    stateFile: r(env.SRE_STATE_FILE ?? '.state/state.json'),
    outDir: r(env.SRE_OUT_DIR ?? 'out'),
    llm: {
      available: Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_USE_BEDROCK === '1'),
      dailyCapUsd: num(env.ENGINE_DAILY_CAP_USD, 30, 'ENGINE_DAILY_CAP_USD'),
      monthlyCapUsd: num(env.ENGINE_MONTHLY_CAP_USD, 300, 'ENGINE_MONTHLY_CAP_USD'),
    },
    agentsDir: r(env.ENGINE_AGENTS_DIR ?? 'agents'),
    memoryDir: env.ENGINE_MEMORY_DIR ? r(env.ENGINE_MEMORY_DIR) : undefined,
    runsDir: r(env.ENGINE_RUNS_DIR ?? 'runs'),
    build: opt(env.ENGINE_BUILD),
    slackWebhookUrl: opt(env.SLACK_WEBHOOK_URL),
    mcp: {
      usersFile: r(env.ENGINE_USERS_FILE ?? 'config/users.local.json'),
      reposFile: r(env.ENGINE_REPOS_FILE ?? 'config/repos.local.yaml'),
      userDailyCapUsd: num(env.ENGINE_USER_DAILY_CAP_USD, 10, 'ENGINE_USER_DAILY_CAP_USD'),
      userMaxRunning: num(env.ENGINE_USER_MAX_RUNNING, 2, 'ENGINE_USER_MAX_RUNNING'),
      notifySlack: env.ENGINE_NOTIFY_SLACK === '1',
      allowedOrigins: (env.ENGINE_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      agents: env.ENGINE_AGENTS ? env.ENGINE_AGENTS.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      login: loginConfig(env),
      reposDir: env.ENGINE_REPOS_DIR ? r(env.ENGINE_REPOS_DIR) : undefined,
      githubApp:
        env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY_FILE
          ? { appId: env.GITHUB_APP_ID, installationId: env.GITHUB_APP_INSTALLATION_ID, privateKeyFile: expandHome(env.GITHUB_APP_PRIVATE_KEY_FILE) }
          : undefined,
    },
  };
}
