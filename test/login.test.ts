import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Login, nameFromEmail } from '../src/mcp/login.js';
import { LOCK_WAIT_MS, Users } from '../src/mcp/users.js';

const cfg = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh', publicUrl: 'https://agent-engine.internal.test', domain: 'starkfuture.com' };
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const good = (over: Record<string, unknown> = {}) => ({ iss: 'https://accounts.google.com', aud: cfg.clientId, exp: Math.floor(Date.now() / 1000) + 600, email: 'ana.lopez@starkfuture.com', email_verified: true, hd: 'starkfuture.com', ...over });

function setup(idClaims: Record<string, unknown>, opts: { invite?: string; admins?: string[] } = {}) {
  const users = Users.load(join(mkdtempSync(join(tmpdir(), 'users-')), 'users.json'));
  const sent: URLSearchParams[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => {
    sent.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id_token: jwt(idClaims) }), { status: 200 });
  }) as typeof fetch;
  if (opts.invite) users.invite(opts.invite);
  if (opts.admins) users.seedAdmins(opts.admins);
  const login = new Login(cfg, users);
  const begin = async () => {
    const r = await login.handle(new URL('https://x/login'));
    assert.equal(r.status, 302);
    return new URL(r.headers.location!);
  };
  const back = (state: string, code = 'c0de') => login.handle(new URL(`https://x/login/callback?state=${encodeURIComponent(state)}&code=${code}`));
  return { users, sent, begin, back, restore: () => (globalThis.fetch = real) };
}

test('Google login issues a 90-day token to an invited company account, once', async (t) => {
  const s = setup(good(), { invite: 'ana.lopez@starkfuture.com' });
  t.after(s.restore);
  const to = await s.begin();
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(to.searchParams.get('hd'), 'starkfuture.com');
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(to.searchParams.get('redirect_uri'), 'https://agent-engine.internal.test/login/callback');

  const r = await s.back(to.searchParams.get('state')!);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.headers['cache-control'], 'no-store');
  const token = /Bearer (eng_[A-Za-z0-9_-]+)/.exec(r.body)![1]!;
  const u = s.users.authenticate(token)!;
  assert.equal(u.name, 'ana.lopez');
  assert.equal(u.role, 'member');
  assert.equal(u.email, 'ana.lopez@starkfuture.com');
  const days = (Date.parse(u.expires_at!) - Date.now()) / 86_400_000;
  assert.ok(days > 89.9 && days <= 90, `${days}`);
  // PKCE verifier went to Google; the state can't be replayed.
  assert.ok(s.sent[0]!.get('code_verifier'));
  assert.equal((await s.back(to.searchParams.get('state')!)).status, 400);

  // Signing in again rotates: the old token stops working.
  const again = await s.back((await s.begin()).searchParams.get('state')!);
  const token2 = /Bearer (eng_[A-Za-z0-9_-]+)/.exec(again.body)![1]!;
  assert.equal(s.users.authenticate(token), undefined);
  assert.equal(s.users.authenticate(token2)?.name, 'ana.lopez');
  assert.equal(s.users.list().length, 1);
});

for (const [why, claims] of [
  ['another domain', good({ email: 'ana@gmail.com', hd: undefined })],
  ['hd spoofed with a foreign email', good({ email: 'ana@evil.test' })],
  ['unverified email', good({ email_verified: false })],
  ['a personal Google account using the company address (no hd)', good({ hd: undefined })],
  ['another client', good({ aud: 'other' })],
  ['expired id token', good({ exp: Math.floor(Date.now() / 1000) - 10 })],
  ['wrong issuer', good({ iss: 'https://evil.test' })],
] as const)
  test(`Google login refuses: ${why}`, async (t) => {
    const s = setup(claims);
    t.after(s.restore);
    const r = await s.back((await s.begin()).searchParams.get('state')!);
    assert.equal(r.status, 403, why);
    assert.equal(s.users.list().length, 0);
  });

test('a login never takes over a user tied to another email; unknown state is refused', async (t) => {
  const s = setup(good({ email: 'ana@starkfuture.com' }));
  t.after(s.restore);
  s.users.add('ana', { email: 'someone.else@starkfuture.com' });
  const r = await s.back((await s.begin()).searchParams.get('state')!);
  assert.equal(r.status, 403);
  assert.throws(() => s.users.invite('ana@starkfuture.com'), /name ana is taken/);
  assert.equal((await s.back('forged-state')).status, 400);
  assert.equal(s.sent.length, 1, 'no code exchange for a forged state');
});

test('a login never adopts a CLI-made user, even an admin whose name matches the email', async (t) => {
  const s = setup(good({ email: 'lead@starkfuture.com' }));
  t.after(s.restore);
  const admin = s.users.add('lead', { admin: true }); // an admin token handed out by name
  const r = await s.back((await s.begin()).searchParams.get('state')!);
  assert.equal(r.status, 403);
  assert.equal(s.users.authenticate(admin)?.role, 'admin', 'the admin token still works');
  assert.equal(s.users.list().length, 1);
});

test('the token page names the MCP server after the deployment', async (t) => {
  const s = setup(good(), { invite: 'ana.lopez@starkfuture.com' });
  t.after(s.restore);
  const login = new Login({ ...cfg, publicUrl: 'https://agent-engine-web.starkfuture.com' }, s.users);
  const to = new URL((await login.handle(new URL('https://x/login'))).headers.location!);
  const r = await login.handle(new URL(`https://x/login/callback?state=${to.searchParams.get('state')}&code=c`));
  assert.match(r.body, /claude mcp add --transport http agent-engine-web https:\/\/agent-engine-web\.starkfuture\.com\/mcp/);
});

test('a company account that was not invited gets no token; ENGINE_ADMINS seeds the first admin', async (t) => {
  const s = setup(good({ email: 'stranger@starkfuture.com' }));
  t.after(s.restore);
  const r = await s.back((await s.begin()).searchParams.get('state')!);
  assert.equal(r.status, 403);
  assert.match(r.body, /admin hasn't added you/);
  assert.ok(!/eng_/.test(r.body));
  assert.equal(s.users.list().length, 0, 'nothing is recorded for an uninvited login');

  const boot = setup(good({ email: 'Lead@starkfuture.com' }), { admins: ['lead@starkfuture.com'] });
  const ok = await boot.back((await boot.begin()).searchParams.get('state')!);
  boot.restore();
  assert.equal(ok.status, 200, ok.body);
  const token = /Bearer (eng_[A-Za-z0-9_-]+)/.exec(ok.body)![1]!;
  assert.equal(boot.users.authenticate(token)?.role, 'admin');
});

test('invited users renew by signing in; once removed, they can neither use nor renew a token', async (t) => {
  const s = setup(good({ email: 'bo@starkfuture.com' }), { invite: 'bo@starkfuture.com' });
  t.after(s.restore);
  const invited = s.users.list()[0]!;
  assert.equal(invited.token_sha256, undefined, 'an invite carries no token');
  assert.equal(s.users.authenticate('eng_' + 'x'.repeat(43)), undefined);
  const first = /Bearer (eng_[A-Za-z0-9_-]+)/.exec((await s.back((await s.begin()).searchParams.get('state')!)).body)![1]!;
  assert.equal(s.users.authenticate(first)?.role, 'member');
  assert.ok(s.users.remove('bo'));
  assert.equal(s.users.authenticate(first), undefined);
  assert.equal((await s.back((await s.begin()).searchParams.get('state')!)).status, 403);
});

test('ENGINE_ADMINS only seeds an empty file: a removed or demoted admin stays out', () => {
  const users = Users.load(join(mkdtempSync(join(tmpdir(), 'users-')), 'users.json'));
  assert.deepEqual(users.seedAdmins(['Lead@starkfuture.com', 'ops@starkfuture.com']), ['lead@starkfuture.com', 'ops@starkfuture.com']);
  users.issue('lead@starkfuture.com');
  assert.ok(users.remove('ops'));
  assert.ok(users.setRole('lead', 'member') === true && users.invite('boss@starkfuture.com', { admin: true }));
  assert.deepEqual(users.seedAdmins(['lead@starkfuture.com', 'ops@starkfuture.com']), [], 'an admin exists: nothing reseeded');
  assert.throws(() => users.issue('ops@starkfuture.com'), /has not been added/, 'removed stays removed');
  assert.equal(users.issue('lead@starkfuture.com').user.role, 'member', 'a sign-in never restores a role');
});

test('two writers (server and CLI) never undo each other, and a held lock is respected', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'users-')), 'users.json');
  const server = Users.load(file);
  server.invite('ana@starkfuture.com');
  server.invite('bo@starkfuture.com');
  const cli = Users.load(file); // a second process with its own copy
  assert.ok(cli.remove('bo'));
  server.invite('cy@starkfuture.com'); // the server's copy still has bo
  assert.deepEqual(Users.load(file).list().map((u) => u.name).sort(), ['ana', 'cy'], 'the removal sticks');

  writeFileSync(`${file}.lock`, ''); // another process mid-write
  const t0 = Date.now();
  assert.throws(() => server.invite('dee@starkfuture.com'), /busy/);
  assert.ok(Date.now() - t0 >= LOCK_WAIT_MS - 50, 'it waited before giving up');
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.lock`, old, old); // left over from a crash
  assert.equal(server.invite('dee@starkfuture.com').name, 'dee');
});

test('tokens expire: 90 days at most, an expired token is unknown', () => {
  const users = Users.load(join(mkdtempSync(join(tmpdir(), 'users-')), 'users.json'));
  assert.throws(() => users.add('long', { days: 91 }), /1 to 90 days/);
  const t = users.add('cy', { days: 1 });
  assert.equal(users.authenticate(t)?.name, 'cy');
  assert.equal(users.authenticate(t, new Date(Date.now() + 2 * 86_400_000)), undefined);
});

test('login names come from the email local part', () => {
  assert.equal(nameFromEmail('Ana.Lopez@starkfuture.com'), 'ana.lopez');
  assert.equal(nameFromEmail('1st+x@starkfuture.com'), 'u1st-x');
});

test('with the Google login on, the CLI cannot mint tokens; admins are promoted after signing in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const file = join(dir, 'users.json');
  const env = { ...process.env, ENGINE_USERS_FILE: file, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'shh', ENGINE_PUBLIC_URL: 'https://agent-engine.starkfuture.com', ANTHROPIC_API_KEY: '' };
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', ...args], { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8' });

  const add = cli('user', 'add', 'lead', '--admin');
  assert.notEqual(add.status, 0);
  assert.match(add.stderr, /people get their token at https:\/\/agent-engine\.starkfuture\.com\/login/);
  assert.ok(!/eng_/.test(add.stdout), 'no token printed');

  // Someone signs in (a login-issued user), then an admin promotes them.
  const users = Users.load(file);
  users.invite('ana@starkfuture.com');
  const { token } = users.issue('ana@starkfuture.com');
  assert.match(cli('user', 'promote', 'ana').stdout, /ana is now admin/);
  assert.equal(Users.load(file).authenticate(token)?.role, 'admin');
  assert.match(cli('user', 'promote', 'nobody').stdout, /no user nobody/);
});
