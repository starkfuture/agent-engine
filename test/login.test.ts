import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { JwksKeys, Login, Refused, serverName } from '../src/mcp/login.js';
import { LOCK_WAIT_MS, nameFromEmail, Users } from '../src/mcp/users.js';
import { fakeKeycloak } from './fake-keycloak.js';

const refusal = async (p: Promise<unknown>): Promise<number> => {
  try {
    await p;
    return 200;
  } catch (e) {
    assert.ok(e instanceof Refused, String(e));
    return e.status;
  }
};

test('a Keycloak access token for the engine client yields the verified company email', async () => {
  const kc = fakeKeycloak();
  const login = new Login(kc.cfg, kc.keys);
  assert.equal(await login.verify(kc.token({ email: 'Ana@StarkFuture.com' })), 'ana@starkfuture.com');
  assert.equal(await login.verify(kc.token({ aud: ['account', 'agent-engine'] })), 'ana@starkfuture.com', 'aud may be a list');
  assert.equal(await login.verify(kc.token({ exp: Math.floor(Date.now() / 1000) - 2 })), 'ana@starkfuture.com', 'a few seconds of clock skew');
});

const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
for (const [why, status, make] of [
  ['no token', 401, () => undefined],
  ['garbage', 401, () => 'not-a-jwt'],
  ['wrong issuer', 401, (kc) => kc.token({ iss: 'https://evil.test/realms/stark' })],
  ['another realm on the same Keycloak', 401, (kc) => kc.token({ iss: 'https://keycloak.test/auth/realms/master' })],
  ['not for the engine (aud)', 401, (kc) => kc.token({ aud: 'account' })],
  ['an ID token', 401, (kc) => kc.token({ typ: 'ID' })],
  ['a refresh token', 401, (kc) => kc.token({ typ: 'Refresh' })],
  ['expired', 401, (kc) => kc.token({ exp: Math.floor(Date.now() / 1000) - 60 })],
  ['not valid yet', 401, (kc) => kc.token({ nbf: Math.floor(Date.now() / 1000) + 60 })],
  ['HS256 (public key as HMAC secret)', 401, (kc) => kc.token({}, { alg: 'HS256', kid: 'k1' })],
  ['alg none', 401, (kc) => kc.token({}, { alg: 'none', kid: 'k1' }).replace(/[^.]+$/, '')],
  ['unknown key', 401, (kc) => kc.token({}, { alg: 'RS256', kid: 'k9' })],
  ['signed by another key', 401, (kc) => kc.token({}, { alg: 'RS256', kid: 'k1' }, other)],
  ['payload changed after signing', 401, (kc) => {
    const [h, , s] = kc.token().split('.');
    return `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(kc.token().split('.')[1]!, 'base64url').toString()), email: 'boss@starkfuture.com' })).toString('base64url')}.${s}`;
  }],
  ['obtained by another client (azp)', 403, (kc) => kc.token({ azp: 'admin-mcp-claude-code' })],
  ['an impersonated session', 403, (kc) => kc.token({ impersonator: { username: 'admin' } })],
  ['an admin special-access session', 403, (kc) => kc.token({ adminUser: 'it@starkfuture.com' })],
  ['unverified email (a customer account using a company address)', 403, (kc) => kc.token({ email_verified: false })],
  ['another domain', 403, (kc) => kc.token({ email: 'ana@gmail.com' })],
  ['a look-alike domain', 403, (kc) => kc.token({ email: 'ana@evil-starkfuture.com' })],
  ['no email', 403, (kc) => kc.token({ email: undefined })],
] as [string, number, (kc: ReturnType<typeof fakeKeycloak>) => string | undefined][])
  test(`a token is refused: ${why}`, async () => {
    const kc = fakeKeycloak();
    assert.equal(await refusal(new Login(kc.cfg, kc.keys).verify(make(kc))), status, why);
  });

test('the protected-resource document points Claude Code at Keycloak', () => {
  const kc = fakeKeycloak('https://agent-engine.starkfuture.com/');
  const login = new Login({ ...kc.cfg, issuer: `${kc.cfg.issuer}/` }, kc.keys);
  assert.deepEqual(login.metadata(), { resource: 'https://agent-engine.starkfuture.com/mcp', authorization_servers: ['https://keycloak.test/auth/realms/stark'], bearer_methods_supported: ['header'], resource_name: 'agent-engine' });
  assert.equal(login.challenge(), 'Bearer resource_metadata="https://agent-engine.starkfuture.com/.well-known/oauth-protected-resource/mcp"');
});

test('the document advertises KEYCLOAK_SCOPES so Claude Code asks for an offline session, and nothing by default', () => {
  const env = { KEYCLOAK_ISSUER: 'https://keycloak.starkfuture.com/auth/realms/stark', ENGINE_PUBLIC_URL: 'https://agent-engine.starkfuture.com' };
  const kc = fakeKeycloak();
  assert.equal(loadConfig(env).mcp.login!.scopes.length, 0);
  assert.equal('scopes_supported' in new Login({ ...kc.cfg, scopes: [] }, kc.keys).metadata(), false, 'unset: Claude Code asks for no extra scope');
  const login = loadConfig({ ...env, KEYCLOAK_SCOPES: 'offline_access' }).mcp.login!;
  assert.deepEqual(login.scopes, ['offline_access']);
  assert.deepEqual(new Login({ ...kc.cfg, scopes: login.scopes }, kc.keys).metadata().scopes_supported, ['offline_access']);
  assert.throws(() => loadConfig({ ...env, KEYCLOAK_SCOPES: 'offline_access "x"' }), /not a scope name/);
  assert.deepEqual(loadConfig({ ...env, KEYCLOAK_SCOPES: 'offline_access, api://engine/read 1st' }).mcp.login!.scopes, ['offline_access', 'api://engine/read', '1st'], 'any RFC 6749 scope name');
  assert.throws(() => loadConfig({ KEYCLOAK_SCOPES: 'offline_access' }), /KEYCLOAK_SCOPES set without KEYCLOAK_ISSUER/, 'scopes alone mean a half-configured sign-in');
});

test('signing keys: cached, refetched for a new kid at most every 30 s, stale keys survive an outage', async (t) => {
  const kc = fakeKeycloak();
  const jwk = { ...kc.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' };
  const enc = { ...generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }), kid: 'e1', use: 'enc' };
  let now = 1_000_000;
  let fetches = 0;
  let down = false;
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  globalThis.fetch = (async () => {
    fetches++;
    if (down) throw new Error('connect timeout');
    return new Response(JSON.stringify({ keys: [jwk, enc] }), { status: 200 });
  }) as typeof fetch;

  const keys = new JwksKeys(kc.cfg.jwksUrl, () => now);
  assert.ok(await keys.keyFor('k1'));
  assert.equal(await keys.keyFor('e1'), undefined, 'an encryption key never verifies a signature');
  assert.equal(fetches, 1, 'the unknown kid right after a fetch waits for the 30 s floor');
  now += 31_000;
  assert.equal(await keys.keyFor('k9'), undefined);
  assert.equal(fetches, 2, 'an unknown kid refetches (rotation)');
  assert.equal(await keys.keyFor('k9'), undefined);
  assert.equal(fetches, 2, 'but not on every request');

  down = true;
  now += 11 * 60_000;
  assert.ok(await keys.keyFor('k1'), 'Keycloak unreachable: the cached key still verifies');
  const login = new Login(kc.cfg, keys, () => now);
  assert.equal(await login.verify(kc.token()), 'ana@starkfuture.com');

  // During the outage, a key we don't hold can't be checked: 503, and no fetch per request.
  assert.equal(await refusal(login.verify(kc.token({}, { alg: 'RS256', kid: 'k2' }))), 503, 'a rotated key during an outage is not "invalid"');
  assert.equal(await refusal(login.verify(kc.token({}, { alg: 'RS256', kid: 'k3' }))), 503);
  assert.equal(fetches, 3, 'unknown keys during an outage do not refetch on every request');
  now += 31_000;
  assert.equal(await refusal(login.verify(kc.token({}, { alg: 'RS256', kid: 'k2' }))), 503);
  assert.equal(fetches, 4, 'retried after 30 s');
  down = false;
  now += 31_000;
  assert.equal(await refusal(login.verify(kc.token({}, { alg: 'RS256', kid: 'k2' }))), 401, 'Keycloak back and the key really is unknown: invalid');
  assert.equal(fetches, 5);

  const cold = new JwksKeys(kc.cfg.jwksUrl, () => now);
  down = true;
  assert.equal(await refusal(new Login(kc.cfg, cold).verify(kc.token())), 503, 'cannot check is not invalid');
  assert.equal(await refusal(new Login(kc.cfg, cold).verify(kc.token())), 503);
  assert.equal(fetches, 6, 'a cold cache retries at most every 30 s too');
});

test('a sign-in maps only to a user invited with that email, never a CLI-made one', () => {
  const users = Users.load(join(mkdtempSync(join(tmpdir(), 'users-')), 'users.json'));
  users.add('lead', { admin: true }); // a CLI admin token, no email
  users.add('ana', { email: 'someone.else@starkfuture.com' });
  assert.equal(users.byEmail('lead@starkfuture.com'), undefined);
  assert.equal(users.byEmail('ana@starkfuture.com'), undefined);
  assert.throws(() => users.invite('ana@starkfuture.com'), /name ana is taken/);
  users.invite('Bo@starkfuture.com');
  assert.equal(users.byEmail('bo@StarkFuture.com')?.name, 'bo');
  assert.equal(users.byEmail('bo@starkfuture.com')?.token_sha256, undefined, 'an invite carries no token');
  const server = Users.load(users.file); // a running server
  assert.ok(users.remove('bo')); // the CLI, another process
  assert.equal(server.byEmail('bo@starkfuture.com'), undefined, 'removal reaches a running server');
});

test('a removal landing while the server loads the users file is not lost', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'users-')), 'users.json');
  const cli = Users.load(file);
  cli.invite('lead@starkfuture.com', { admin: true });
  // Interleave: the server reads the file, then the CLI removes the admin before the server takes its stamp.
  const statics = Users as unknown as { read: (f: string) => unknown };
  const read = statics.read;
  statics.read = (f: string) => {
    statics.read = read; // once: remove() reads the file too
    const before = read(f);
    cli.remove('lead');
    return before;
  };
  let server: Users;
  try {
    server = Users.load(file);
  } finally {
    statics.read = read;
  }
  assert.equal(server.byEmail('lead@starkfuture.com'), undefined, 'the next lookup re-reads the file');
});

test('ENGINE_ADMINS only seeds an empty file: a removed or demoted admin stays out', () => {
  const users = Users.load(join(mkdtempSync(join(tmpdir(), 'users-')), 'users.json'));
  assert.deepEqual(users.seedAdmins(['Lead@starkfuture.com', 'ops@starkfuture.com']), ['lead@starkfuture.com', 'ops@starkfuture.com']);
  assert.ok(users.remove('ops'));
  assert.ok(users.setRole('lead', 'member') === true && users.invite('boss@starkfuture.com', { admin: true }));
  assert.deepEqual(users.seedAdmins(['lead@starkfuture.com', 'ops@starkfuture.com']), [], 'an admin exists: nothing reseeded');
  assert.equal(users.byEmail('ops@starkfuture.com'), undefined, 'removed stays removed');
  assert.equal(users.byEmail('lead@starkfuture.com')?.role, 'member', 'demoted stays demoted');
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

test('CLI tokens expire: 90 days at most, an expired token is unknown', () => {
  const users = Users.load(join(mkdtempSync(join(tmpdir(), 'users-')), 'users.json'));
  assert.throws(() => users.add('long', { days: 91 }), /1 to 90 days/);
  const t = users.add('cy', { days: 1 });
  assert.equal(users.authenticate(t)?.name, 'cy');
  assert.equal(users.authenticate(t, new Date(Date.now() + 2 * 86_400_000)), undefined);
});

test('the MCP server is named after its deployment', () => {
  assert.equal(serverName('https://agent-engine.starkfuture.com'), 'agent-engine');
  assert.equal(serverName('https://agent-engine-web.starkfuture.com/'), 'agent-engine-web');
  assert.equal(serverName('http://localhost:8788'), 'agent-engine');
  assert.equal(serverName('http://127.0.0.1:8788'), 'agent-engine');
});

test('user names come from the email local part', () => {
  assert.equal(nameFromEmail('Ana.Lopez@starkfuture.com'), 'ana.lopez');
  assert.equal(nameFromEmail('1st+x@starkfuture.com'), 'u1st-x');
});

test('sign-in config: KEYCLOAK_ISSUER turns it on, and a half-configured one stops the program', () => {
  const env = { KEYCLOAK_ISSUER: 'https://keycloak.starkfuture.com/auth/realms/stark/', ENGINE_PUBLIC_URL: 'https://agent-engine.starkfuture.com' };
  const login = loadConfig(env).mcp.login!;
  assert.equal(login.issuer, 'https://keycloak.starkfuture.com/auth/realms/stark');
  assert.equal(login.jwksUrl, 'https://keycloak.starkfuture.com/auth/realms/stark/protocol/openid-connect/certs');
  assert.equal(login.clientId, 'agent-engine');
  assert.equal(loadConfig({ ...env, KEYCLOAK_JWKS_URL: 'http://keycloak-production.keycloak.svc.cluster.local:8080/auth/realms/stark/protocol/openid-connect/certs' }).mcp.login!.jwksUrl.startsWith('http://keycloak-production'), true);
  assert.equal(loadConfig({}).mcp.login, undefined);
  assert.equal(loadConfig({ ENGINE_PUBLIC_URL: env.ENGINE_PUBLIC_URL, ENGINE_LOGIN_DOMAIN: 'starkfuture.com' }).mcp.login, undefined, 'the URL alone does not turn it on (the monitor-only deployment carries it)');
  assert.throws(() => loadConfig({ KEYCLOAK_JWKS_URL: 'https://keycloak.starkfuture.com/certs' }), /set without KEYCLOAK_ISSUER/);
  assert.throws(() => loadConfig({ ENGINE_KC_CLIENT_ID: 'agent-engine' }), /ENGINE_KC_CLIENT_ID set without KEYCLOAK_ISSUER/);
  assert.throws(() => loadConfig({ KEYCLOAK_ISSUER: env.KEYCLOAK_ISSUER }), /ENGINE_PUBLIC_URL/);
  assert.throws(() => loadConfig({ ...env, KEYCLOAK_ISSUER: 'http://keycloak.starkfuture.com/auth/realms/stark' }), /KEYCLOAK_ISSUER must be https/);
  assert.throws(() => loadConfig({ ...env, KEYCLOAK_JWKS_URL: 'http://evil.test/certs' }), /KEYCLOAK_JWKS_URL/);
  assert.throws(() => loadConfig({ ...env, ENGINE_ADMINS: 'boss@gmail.com' }), /not an @starkfuture\.com address/);
});

test('with the Keycloak sign-in on, the CLI cannot mint tokens; it invites and promotes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const file = join(dir, 'users.json');
  const env = { ...process.env, ENGINE_USERS_FILE: file, KEYCLOAK_ISSUER: 'https://keycloak.starkfuture.com/auth/realms/stark', ENGINE_PUBLIC_URL: 'https://agent-engine.starkfuture.com', ANTHROPIC_API_KEY: '' };
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', ...args], { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8' });

  const add = cli('user', 'add', 'lead', '--admin');
  assert.notEqual(add.status, 0);
  assert.match(add.stderr, /Keycloak sign-in is on: `user invite <email>` instead/);
  assert.ok(!/eng_/.test(add.stdout), 'no token printed');

  assert.match(cli('user', 'invite', 'ana@starkfuture.com').stdout, /invited as member \(user ana\); they sign in with their company account/);
  assert.match(cli('user', 'promote', 'ana').stdout, /ana is now admin/);
  assert.equal(Users.load(file).byEmail('ana@starkfuture.com')?.role, 'admin');
  assert.match(cli('user', 'promote', 'nobody').stdout, /no user nobody \(invite them first\)/);
});

test('serve refuses a reachable bind without the Keycloak sign-in: CLI tokens are loopback-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const file = join(dir, 'users.json');
  Users.load(file).add('lead', { admin: true });
  const env = { ...process.env, ENGINE_USERS_FILE: file, ENGINE_RUNS_DIR: join(dir, 'runs'), ENGINE_REPOS_FILE: join(dir, 'repos.yaml'), ENGINE_PUBLIC_URL: 'https://agent-engine.starkfuture.com', ANTHROPIC_API_KEY: '', KEYCLOAK_ISSUER: '' };
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', 'serve', '--host', '0.0.0.0', '--port', '0'], { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /serving on 0\.0\.0\.0 needs the Keycloak sign-in/);
});

test('replay ignores Slack settings: no outbox database next to the runs, nothing outside SRE_OUT_DIR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const runsDir = join(dir, 'runs');
  const outDir = join(dir, 'out');
  const env = { ...process.env, ENGINE_RUNS_DIR: runsDir, SRE_OUT_DIR: outDir, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T000/B000/xxxxxxxx', SLACK_BOT_TOKEN: '', ANTHROPIC_API_KEY: '', KEYCLOAK_ISSUER: '' };
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', 'replay', '--from', '2026-10-26T10:00:00Z', '--to', '2026-10-26T10:00:00Z', '--replay', join(dir, 'export')], { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 60_000 });
  assert.ok(!existsSync(join(runsDir, 'engine.db')), `replay opened the Slack outbox (exit ${r.status}): ${r.stderr}`);
});
