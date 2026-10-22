import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RepoEntry } from './repos.js';

// Hosted, the codebase agent's repos live on the engine's volume: the engine
// clones them (once) and fetches them (every 10 min) itself, as a GitHub App.
// Clones are full (no partial clone), so a snapshot never needs the network.
// The token goes to git through GIT_CONFIG_* environment variables, never argv
// (argv is visible to every process on the host) and never a stored config.

export interface SyncState {
  lastFetch?: Date; // last successful clone or fetch
  lastError?: string;
  commit?: string; // origin/HEAD after the last sync
}

export type Git = (args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;

export const realGit: Git = (args, opts) =>
  new Promise((resolve, reject) =>
    execFile('git', args, { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
      err ? reject(Object.assign(new Error(String(stderr || err.message).trim().slice(0, 300)), { code: (err as { code?: unknown }).code })) : resolve(stdout),
    ),
  );

export interface RepoSyncOptions {
  token: () => Promise<string>; // installation token
  base?: string; // where owner/name lives (default https://github.com; tests use file://)
  intervalMs?: number;
  timeoutMs?: number;
  log?: (s: string) => void;
  git?: Git;
}

export class RepoSync {
  readonly state = new Map<string, SyncState>();
  private readonly base: string;
  private readonly git: Git;
  private running?: Promise<void>;

  constructor(
    private readonly repos: Map<string, RepoEntry>,
    private readonly o: RepoSyncOptions,
  ) {
    this.base = (o.base ?? 'https://github.com').replace(/\/$/, '');
    this.git = o.git ?? realGit;
    for (const [name, r] of repos) if (r.github) this.state.set(name, {});
  }

  private async env(): Promise<NodeJS.ProcessEnv> {
    const basic = Buffer.from(`x-access-token:${await this.o.token()}`).toString('base64');
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${this.base}/.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    };
  }

  private async one(name: string, r: RepoEntry & { github: string }): Promise<void> {
    const env = await this.env();
    const opts = { env, timeoutMs: this.o.timeoutMs ?? 10 * 60_000 };
    if (!existsSync(`${r.path}/.git`) && !existsSync(`${r.path}/HEAD`)) {
      // Clone beside the target and move it into place, so a half clone never
      // looks like a repo.
      const partial = `${r.path}.partial`;
      await rm(partial, { recursive: true, force: true });
      await mkdir(dirname(r.path), { recursive: true });
      await this.git(['clone', '--no-checkout', '--single-branch', '--no-tags', `${this.base}/${r.github}.git`, partial], opts);
      await rm(r.path, { recursive: true, force: true });
      await rename(partial, r.path);
    } else {
      await this.git(['-C', r.path, 'fetch', '--prune', '--no-tags', 'origin'], opts);
    }
    // Snapshots default to origin/HEAD: make sure it exists (clone sets it;
    // a fetch into a clone that lost it doesn't).
    try {
      await this.git(['-C', r.path, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD'], opts);
    } catch {
      await this.git(['-C', r.path, 'remote', 'set-head', 'origin', '--auto'], opts);
    }
    const commit = (await this.git(['-C', r.path, 'rev-parse', 'refs/remotes/origin/HEAD'], opts)).trim();
    this.state.set(name, { lastFetch: new Date(), commit });
  }

  // One repo at a time, so a big fetch never runs beside another one.
  async syncAll(): Promise<void> {
    this.running ??= (async () => {
      for (const [name, r] of this.repos) {
        if (!r.github) continue;
        try {
          await this.one(name, r as RepoEntry & { github: string });
        } catch (e) {
          const msg = (e as Error).message.replace(/(Authorization: Basic|x-access-token:)\s*\S+/gi, '$1 <secret>').slice(0, 300);
          this.state.set(name, { ...this.state.get(name), lastError: msg });
          this.o.log?.(`repo ${name}: sync failed: ${msg}`);
        }
      }
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  // Sync now, then every interval. Returns a function that stops the timer.
  start(): () => void {
    void this.syncAll();
    const t = setInterval(() => void this.syncAll(), this.o.intervalMs ?? 10 * 60_000);
    t.unref();
    return () => clearInterval(t);
  }
}
