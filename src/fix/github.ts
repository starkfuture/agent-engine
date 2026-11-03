import { appJwt } from '../mcp/github-app.js';
import { gitAuthEnv, type Git } from '../mcp/reposync.js';
import { allowedRepo, OWNER } from './repos.js';

// The fix App (GITHUB_FIX_APP_ID, GITHUB_FIX_APP_PRIVATE_KEY): contents and
// pull requests, write, on FIX_REPOS only. This file is all the engine does
// with it: a token for one repo, a look for the issue's PR or branch, the push
// of one fix branch, and a draft pull request. Nothing here marks a PR ready,
// merges, or pushes any other branch. The key and tokens never reach a log,
// an error message or the model.

export interface FixAppCreds {
  appId: string;
  privateKey: string; // PEM
}

export const FIX_BRANCH = /^agent-engine\/fix-I-[0-9a-f]{4,6}$/;
export const fixBranch = (issue: string) => `agent-engine/fix-${issue}`;
const BRANCH = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;

export interface DraftPr {
  url: string; // https://github.com/starkfuture/<repo>/pull/<n>
  number: number;
  state?: string | undefined; // open or closed
}

const notAllowed = (repo: string) => new Error(`${repo} is not a repo the engine may open fixes in`);

export class FixGitHub {
  constructor(
    private readonly app: FixAppCreds,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly api = 'https://api.github.com',
  ) {
    if (!/^\d+$/.test(app.appId)) throw new Error('GITHUB_FIX_APP_ID must be a number');
  }

  private async call(path: string, auth: string, o: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.api}${path}`, {
        method: o.method ?? 'GET',
        headers: { Authorization: auth, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'agent-engine', ...(o.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(o.body ? { body: JSON.stringify(o.body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new Error(`GitHub: ${(e as Error).name}`); // the message could echo the request
    }
    return { status: res.status, json: await res.json().catch(() => undefined) };
  }

  // A token for one repo, with only what a draft fix needs. It expires in an hour.
  async token(repo: string, nowMs = Date.now()): Promise<string> {
    if (!allowedRepo(repo)) throw notAllowed(repo);
    const jwt = `Bearer ${appJwt(this.app.appId, this.app.privateKey, nowMs)}`;
    const inst = await this.call(`/repos/${OWNER}/${repo}/installation`, jwt);
    const id = (inst.json as { id?: unknown } | undefined)?.id;
    if (inst.status !== 200 || typeof id !== 'number') throw new Error(`GitHub: the fix App is not installed on ${OWNER}/${repo} (HTTP ${inst.status})`);
    const t = await this.call(`/app/installations/${id}/access_tokens`, jwt, { method: 'POST', body: { repositories: [repo], permissions: { contents: 'write', pull_requests: 'write' } } });
    const token = (t.json as { token?: unknown } | undefined)?.token;
    if (t.status !== 201 || typeof token !== 'string') throw new Error(`GitHub: no token for ${OWNER}/${repo} (HTTP ${t.status})`);
    return token;
  }

  async defaultBranch(repo: string, token: string): Promise<string> {
    if (!allowedRepo(repo)) throw notAllowed(repo);
    const r = await this.call(`/repos/${OWNER}/${repo}`, `Bearer ${token}`);
    const b = (r.json as { default_branch?: unknown } | undefined)?.default_branch;
    if (r.status !== 200 || typeof b !== 'string' || !BRANCH.test(b)) throw new Error(`GitHub: can't read ${OWNER}/${repo} (HTTP ${r.status})`);
    return b;
  }

  // The fix branch's pull request, open or closed, if it has one.
  async findPr(repo: string, branch: string, token: string): Promise<DraftPr | undefined> {
    if (!allowedRepo(repo)) throw notAllowed(repo);
    const r = await this.call(`/repos/${OWNER}/${repo}/pulls?head=${encodeURIComponent(`${OWNER}:${branch}`)}&state=all&per_page=1`, `Bearer ${token}`);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`GitHub: can't list pull requests of ${OWNER}/${repo} (HTTP ${r.status})`);
    const p = r.json[0] as { html_url?: unknown; number?: unknown; state?: unknown } | undefined;
    return p ? prOf(repo, p) : undefined;
  }

  async branchExists(repo: string, branch: string, token: string): Promise<boolean> {
    if (!allowedRepo(repo)) throw notAllowed(repo);
    if (!FIX_BRANCH.test(branch)) throw new Error(`not a fix branch: ${branch}`);
    const r = await this.call(`/repos/${OWNER}/${repo}/git/ref/heads/${branch}`, `Bearer ${token}`);
    if (r.status === 404) return false;
    if (r.status === 200) return true;
    throw new Error(`GitHub: can't read branch ${branch} of ${OWNER}/${repo} (HTTP ${r.status})`);
  }

  // Always a draft: a person reviews it and marks it ready.
  async openDraft(repo: string, pr: { branch: string; base: string; title: string; body: string }, token: string): Promise<DraftPr> {
    if (!allowedRepo(repo)) throw notAllowed(repo);
    if (!FIX_BRANCH.test(pr.branch)) throw new Error(`refusing a pull request from ${pr.branch}: only agent-engine/fix-<issue> branches`);
    const r = await this.call(`/repos/${OWNER}/${repo}/pulls`, `Bearer ${token}`, { method: 'POST', body: { title: pr.title, head: pr.branch, base: pr.base, body: pr.body, draft: true } });
    const j = r.json as { html_url?: unknown; number?: unknown; draft?: unknown } | undefined;
    if (r.status !== 201 || !j) throw new Error(`GitHub: the draft pull request was not opened (HTTP ${r.status})`);
    const out = prOf(repo, j);
    if (j.draft !== true) throw new Error(`GitHub opened ${out.url} as ready for review, not as a draft: mark it draft by hand`);
    return out;
  }
}

function prOf(repo: string, p: { html_url?: unknown; number?: unknown; state?: unknown }): DraftPr {
  const url = String(p.html_url);
  if (!new RegExp(`^https://github\\.com/${OWNER}/${repo}/pull/\\d+$`).test(url) || typeof p.number !== 'number') throw new Error(`GitHub: unexpected pull request in ${OWNER}/${repo}`);
  return { url, number: p.number, ...(typeof p.state === 'string' ? { state: p.state } : {}) };
}

// The only push the engine makes: the current commit to a new fix branch of
// an allowed repo, never forced, with no hooks run.
export async function pushFixBranch(git: Git, o: { dir: string; repo: string; branch: string; base: string; token: string; timeoutMs?: number }): Promise<void> {
  if (!allowedRepo(o.repo)) throw notAllowed(o.repo);
  if (!FIX_BRANCH.test(o.branch)) throw new Error(`refusing to push ${o.branch}: the engine pushes only agent-engine/fix-<issue> branches`);
  await git(['-C', o.dir, '-c', 'core.hooksPath=/dev/null', 'push', '--no-verify', '--porcelain', `${o.base}/${OWNER}/${o.repo}.git`, `HEAD:refs/heads/${o.branch}`], {
    env: gitAuthEnv(o.base, o.token),
    timeoutMs: o.timeoutMs ?? 5 * 60_000,
  });
}
