import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Login, nameFromEmail } from '../src/mcp/login.js';
import { Users } from '../src/mcp/users.js';

const cfg = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh', publicUrl: 'https://agent-engine.internal.test', domain: 'starkfuture.com' };
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const good = (over: Record<string, unknown> = {}) => ({ iss: 'https://accounts.google.com', aud: cfg.clientId, exp: Math.floor(Date.now() / 1000) + 600, email: 'ana.lopez@starkfuture.com', email_verified: true, hd: 'starkfuture.com', ...over });

function setup(idClaims: Record<string, unknown>) {
  const users = Users.load(join(mkdtempSync(join(tmpdir(), 'users-')), 'users.json'));
  const sent: URLSearchParams[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => {
    sent.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id_token: jwt(idClaims) }), { status: 200 });
  }) as typeof fetch;
  const login = new Login(cfg, users);
  const begin = async () => {
    const r = await login.handle(new URL('https://x/login'));
    assert.equal(r.status, 302);
    return new URL(r.headers.location!);
  };
  const back = (state: string, code = 'c0de') => login.handle(new URL(`https://x/login/callback?state=${encodeURIComponent(state)}&code=${code}`));
  return { users, sent, begin, back, restore: () => (globalThis.fetch = real) };
}

test('Google login issues a 90-day token to a verified company account, once', async (t) => {
  const s = setup(good());
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
  assert.equal(r.status, 409);
  assert.equal((await s.back('forged-state')).status, 400);
  assert.equal(s.sent.length, 1, 'no code exchange for a forged state');
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
