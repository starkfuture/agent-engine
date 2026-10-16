import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Engine } from '../src/engine/run.js';
import { snapshot } from '../src/engine/snapshot.js';
import { Store } from '../src/engine/store.js';
import { appJwt, InstallationTokens } from '../src/mcp/github-app.js';
import { loadRepos, type RepoEntry } from '../src/mcp/repos.js';
import { realGit, RepoSync, type Git } from '../src/mcp/reposync.js';
import { Metrics } from '../src/metrics.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', ...args], { encoding: 'utf8' }).trim();
const TOKEN = 'ghs_TOPSECRETinstallationTOKEN0123456789';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

test('the app JWT is RS256, signed by the app key, short-lived, issued by the app id', () => {
  const now = Date.parse('2026-10-16T10:00:00Z');
  const [h, b, s] = appJwt('123456', privateKey, now).split('.') as [string, string, string];
  const head = JSON.parse(Buffer.from(h, 'base64url').toString());
  const body = JSON.parse(Buffer.from(b, 'base64url').toString());
  assert.deepEqual(head, { alg: 'RS256', typ: 'JWT' });
  assert.equal(body.iss, '123456');
  assert.equal(body.iat, now / 1000 - 60, 'backdated for clock drift');
  assert.ok(body.exp - body.iat <= 600, 'GitHub refuses more than 10 min');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')));
});

test('installation tokens are cached until 5 min before expiry; errors carry no secrets', async () => {
  const calls: Array<{ url: string; auth: string }> = [];
  let status = 200;
  const fetchStub = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization! });
    return new Response(JSON.stringify({ token: TOKEN, expires_at: '2026-10-16T11:00:00Z' }), { status });
  }) as unknown as typeof fetch;
  const t = new InstallationTokens({ appId: '1', installationId: '42', privateKey }, fetchStub);
  const at = (iso: string) => Date.parse(iso);
  assert.equal(await t.token(at('2026-10-16T10:00:00Z')), TOKEN);
  assert.equal(await t.token(at('2026-10-16T10:50:00Z')), TOKEN);
  assert.equal(calls.length, 1, 'cached');
  await t.token(at('2026-10-16T10:56:00Z'));
  assert.equal(calls.length, 2, 'refreshed 5 min before expiry');
  assert.equal(calls[0]!.url, 'https://api.github.com/app/installations/42/access_tokens');
  assert.match(calls[0]!.auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  status = 401;
  const t2 = new InstallationTokens({ appId: '1', installationId: '42', privateKey }, fetchStub);
  await assert.rejects(t2.token(), (e: Error) => e.message === 'GitHub App token: HTTP 401');
  assert.throws(() => new InstallationTokens({ appId: 'x', installationId: '42', privateKey }), /numbers/);
});

// A local bare repo plays GitHub: <base>/acme/app.git.
function remote() {
  const base = tmp('gh-');
  const bare = join(base, 'acme', 'app.git');
  mkdirSync(bare, { recursive: true });
  git('init', '-q', '--bare', '-b', 'main', bare);
  const work = tmp('work-');
  git('init', '-q', '-b', 'main', work);
  const commit = (content: string) => {
    writeFileSync(join(work, 'a.ts'), content);
    git('-C', work, 'add', '-A');
    git('-C', work, 'commit', '-q', '--no-verify', '-m', content);
    git('-C', work, 'push', '-q', bare, 'main');
    return git('-C', work, 'rev-parse', 'HEAD');
  };
  return { base: `file://${base}`, commit };
}

test('repo sync clones, fetches, keeps origin/HEAD, and never puts the token in argv, logs or config', async () => {
  const r = remote();
  const c1 = r.commit('v1');
  const dir = join(tmp('repos-'), 'app');
  const repos = new Map<string, RepoEntry>([
    ['app', { path: dir, github: 'acme/app' }],
    ['local', { path: '/somewhere' }],
  ]);
  const argv: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const spy: Git = (args, o) => (argv.push(args), envs.push(o.env), realGit(args, o));
  const logs: string[] = [];
  const sync = new RepoSync(repos, { token: async () => TOKEN, base: r.base, git: spy, log: (s) => logs.push(s) });
  assert.deepEqual([...sync.state.keys()], ['app'], 'only github repos are synced');

  await sync.syncAll();
  assert.equal(sync.state.get('app')?.commit, c1, sync.state.get('app')?.lastError);
  assert.ok(sync.state.get('app')?.lastFetch);
  assert.ok(existsSync(join(dir, '.git')) && !existsSync(join(dir, 'a.ts')), 'no checkout: snapshots read commits');

  const c2 = r.commit('v2');
  await sync.syncAll();
  assert.equal(sync.state.get('app')?.commit, c2, 'fetch picks up the new commit');

  git('-C', dir, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  await sync.syncAll();
  assert.equal(git('-C', dir, 'rev-parse', 'refs/remotes/origin/HEAD'), c2, 'origin/HEAD restored');

  const s = await snapshot(dir);
  assert.equal(s.ref, 'origin/HEAD');
  assert.equal(readFileSync(join(s.dir, 'a.ts'), 'utf8'), 'v2', 'the codebase agent reads the synced commit');

  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  for (const a of argv) assert.ok(!a.join(' ').includes(TOKEN) && !a.join(' ').includes(basic), `token in argv: ${a.join(' ')}`);
  assert.ok(envs.every((e) => e.GIT_CONFIG_VALUE_0 === `Authorization: Basic ${basic}`), 'token goes through the environment');
  assert.ok(!readFileSync(join(dir, '.git', 'config'), 'utf8').includes(basic), 'not stored in the clone');
  assert.ok(!logs.join('\n').includes(TOKEN));
});

test('a repo that fails to sync is reported and shown in metrics; the others still sync', async () => {
  const r = remote();
  r.commit('v1');
  const root = tmp('repos-');
  const logs: string[] = [];
  const sync = new RepoSync(
    new Map<string, RepoEntry>([
      ['gone', { path: join(root, 'gone'), github: 'acme/missing' }],
      ['app', { path: join(root, 'app'), github: 'acme/app' }],
    ]),
    { token: async () => TOKEN, base: r.base, log: (s) => logs.push(s) },
  );
  await sync.syncAll();
  assert.ok(sync.state.get('gone')?.lastError);
  assert.ok(!existsSync(join(root, 'gone')), 'a failed clone leaves no repo behind');
  assert.ok(sync.state.get('app')?.commit);
  assert.match(logs.join('\n'), /repo gone: sync failed/);
  assert.ok(!logs.join('\n').includes(TOKEN));

  const m = new Metrics();
  m.repoSync(sync.state);
  const runsDir = tmp('runs-');
  const engine = { store: new Store(':memory:'), runsDir, stopFile: join(runsDir, 'STOP'), dailyCapUsd: 1, llmAvailable: true } as unknown as Engine;
  const text = m.render(engine);
  assert.match(text, /^engine_repo_last_fetch_timestamp_seconds\{repo="app"\} \d+$/m);
  assert.match(text, /^engine_repo_sync_ok\{repo="gone"\} 0$/m);
  assert.doesNotMatch(text, /engine_repo_last_fetch_timestamp_seconds\{repo="gone"\}/);
});

test('repos file: github entries clone into the repos dir', () => {
  const f = join(tmp('cfg-'), 'repos.yaml');
  writeFileSync(f, 'repos:\n  backend-nest: { github: starkfuture/backend-nest }\n  pinned: { github: starkfuture/admin-next, ref: origin/main }\n  local: /abs/here\n');
  const m = loadRepos(f, '/data/repos');
  assert.deepEqual(m.get('backend-nest'), { path: '/data/repos/backend-nest', github: 'starkfuture/backend-nest' });
  assert.deepEqual(m.get('pinned'), { path: '/data/repos/pinned', github: 'starkfuture/admin-next', ref: 'origin/main' });
  assert.deepEqual(m.get('local'), { path: '/abs/here' });
  assert.throws(() => loadRepos(f), /ENGINE_REPOS_DIR/);
  writeFileSync(f, 'repos:\n  bad: { ref: main }\n');
  assert.throws(() => loadRepos(f), /path or github/);
});
