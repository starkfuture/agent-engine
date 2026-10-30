import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { DEFAULT_FLOOR } from './patrol/digest.js';

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
  attentionFloor: number; // fresh or worse event rows below this count are "quiet" on the card, not "to look at"
  sources: Sources;
  noiseFile: string;
  ownersFile: string; // service → Slack mention for lines to look at
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
  retentionDays: number; // run folders and cards older than this are deleted (serve)
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
    // Sign-in through Keycloak (KEYCLOAK_ISSUER, ENGINE_PUBLIC_URL); unset = tokens from the CLI.
    // admins: ENGINE_ADMINS, the first admins: seeded into the users file (as invites)
    // at startup while it has no admin. Who may sign in is decided by the file alone.
    login: { issuer: string; jwksUrl: string; clientId: string; publicUrl: string; domain: string; admins: string[]; scopes: string[] } | undefined;
    reposDir: string | undefined; // where the engine clones `github:` repos (a persistent volume when hosted)
    reposGithub: string | undefined; // ENGINE_REPOS_GITHUB: name=owner/repo[@ref],… (env-only hosts)
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

// KEYCLOAK_ISSUER turns the sign-in on, and then the rest must be right: a
// half-configured login must stop the server, not run open. Keycloak
// settings without the issuer stop it too: the sign-in would be off and CLI
// tokens would work instead. (ENGINE_PUBLIC_URL and the like alone are allowed:
// the monitor-only deployment carries them; `serve` refuses a non-loopback
// bind without the sign-in anyway.)
const LOGIN_VARS = ['KEYCLOAK_JWKS_URL', 'ENGINE_KC_CLIENT_ID', 'KEYCLOAK_SCOPES'];
function loginConfig(env: NodeJS.ProcessEnv): Config['mcp']['login'] {
  const issuer = opt(env.KEYCLOAK_ISSUER)?.replace(/\/+$/, '');
  if (!issuer) {
    const set = LOGIN_VARS.filter((k) => opt(env[k]));
    if (set.length) throw new Error(`${set.join(', ')} set without KEYCLOAK_ISSUER: set the issuer to turn the Keycloak sign-in on, or unset them`);
    return undefined;
  }
  const publicUrl = opt(env.ENGINE_PUBLIC_URL);
  if (!publicUrl) throw new Error('Keycloak sign-in needs ENGINE_PUBLIC_URL, the address people add to Claude Code');
  const secure = (u: string) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u);
  if (!secure(publicUrl)) throw new Error('ENGINE_PUBLIC_URL must be https (or localhost for testing)');
  if (!secure(issuer)) throw new Error('KEYCLOAK_ISSUER must be https (or localhost for testing)');
  const jwksUrl = opt(env.KEYCLOAK_JWKS_URL) ?? `${issuer}/protocol/openid-connect/certs`;
  if (!secure(jwksUrl) && !/^http:\/\/[a-z0-9.-]+\.svc(\.cluster\.local)?(:\d+)?\//.test(jwksUrl)) throw new Error('KEYCLOAK_JWKS_URL must be https, in-cluster or localhost');
  const domain = env.ENGINE_LOGIN_DOMAIN || 'starkfuture.com';
  const admins = (env.ENGINE_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const a of admins) if (!a.endsWith(`@${domain}`)) throw new Error(`ENGINE_ADMINS: ${a} is not an @${domain} address`);
  // KEYCLOAK_SCOPES: scopes the protected-resource document advertises, so Claude Code requests them
  // (offline_access = stay signed in for the client's offline cap). Only scopes the Keycloak client
  // carries: Keycloak refuses a sign-in that asks for one it doesn't.
  const scopes = (env.KEYCLOAK_SCOPES ?? '').split(/[\s,]+/).filter(Boolean);
  // RFC 6749 scope-token characters, minus the comma that separates them here.
  for (const s of scopes) if (!/^[\x21\x23-\x2b\x2d-\x5b\x5d-\x7e]+$/.test(s)) throw new Error(`KEYCLOAK_SCOPES: "${s}" is not a scope name`);
  return { issuer, jwksUrl, clientId: env.ENGINE_KC_CLIENT_ID || 'agent-engine', publicUrl, domain, admins, scopes };
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
    attentionFloor: num(env.PATROL_ATTENTION_FLOOR, DEFAULT_FLOOR, 'PATROL_ATTENTION_FLOOR'),
    sources: loadSources(r(env.SRE_SOURCES_FILE ?? 'config/sources.yaml')),
    noiseFile: r(env.SRE_NOISE_FILE ?? 'config/noise.yaml'),
    ownersFile: r(env.SRE_OWNERS_FILE ?? 'config/owners.yaml'),
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
    build: opt(env.ENGINE_BUILD) === 'unknown' ? undefined : opt(env.ENGINE_BUILD),
    retentionDays: num(env.ENGINE_RETENTION_DAYS, 30, 'ENGINE_RETENTION_DAYS'),
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
      reposGithub: opt(env.ENGINE_REPOS_GITHUB),
      githubApp:
        env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY_FILE
          ? { appId: env.GITHUB_APP_ID, installationId: env.GITHUB_APP_INSTALLATION_ID, privateKeyFile: expandHome(env.GITHUB_APP_PRIVATE_KEY_FILE) }
          : undefined,
    },
  };
}
