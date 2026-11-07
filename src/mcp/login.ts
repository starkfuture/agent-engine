import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { nameFromEmail } from './users.js';

// Sign-in through Keycloak, the company login, as the MCP authorization spec
// describes it: the engine is a plain OAuth resource server. Claude Code finds
// Keycloak through /.well-known/oauth-protected-resource/mcp, signs the person
// in there (authorization code + PKCE, the public `agent-engine` client) and
// sends the access token; Keycloak owns the login, refresh and session
// lifetimes. The engine checks every token itself (signature against the
// realm's published keys, issuer, audience, client, expiry), then the users
// file: a company account alone is not enough, an admin must have invited the
// email, since the engine reads prod telemetry and the repos.
//
// Same checks as the admin MCP's Keycloak mode (backend-nest
// packages/admin-mcp-service/src/auth/keycloak-access-token.verifier.ts),
// without its token exchange: the engine calls no Stark service as the user.

export interface LoginConfig {
  issuer: string; // the realm issuer exactly as Keycloak stamps it in `iss`
  jwksUrl: string; // the realm's signing keys
  clientId: string; // the Keycloak client Claude Code signs in with; tokens must be for it (aud) and from it (azp)
  publicUrl: string; // https://agent-engine.<internal domain>, the address people add to Claude Code
  domain: string; // starkfuture.com
  scopes?: string[]; // what Claude Code should ask for (offline_access: stay signed in for the client's offline cap); only scopes the Keycloak client has, or Keycloak refuses the sign-in
}

// 401: the token itself is wrong (expired, forged, another issuer); signing in
// again fixes it, so the reply carries the challenge. 403: a valid token that
// may not use the engine; signing in again would not help. 503: the keys could
// not be fetched; "cannot check" must never look like "invalid".
export class Refused extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    message: string,
  ) {
    super(message);
  }
}

export interface SigningKeys {
  keyFor(kid: string): Promise<KeyObject | undefined>;
}

const JWKS_TIMEOUT_MS = 5_000;
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_MIN_REFETCH_MS = 30_000; // an unknown kid refetches (key rotation), at most this often

// The realm's public keys, cached. A failed refresh keeps the keys already
// held: Keycloak rotates by adding a key first, so one timed-out fetch must not
// lock everyone out. Fetches (successful or not) happen at most every 30 s, so
// requests naming unknown keys can't make the engine hammer Keycloak. While
// the last fetch failed, a key we don't hold is "cannot check" (503), never
// "invalid" (401), which would send people to sign in again for nothing.
export class JwksKeys implements SigningKeys {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = -Infinity; // last successful fetch
  private attemptedAt = -Infinity; // last fetch, successful or not
  private failure: string | undefined; // why the last fetch failed
  private inflight: Promise<void> | undefined;

  constructor(
    private readonly url: string,
    private readonly now: () => number = Date.now,
  ) {}

  async keyFor(kid: string): Promise<KeyObject | undefined> {
    const now = this.now();
    if (now - this.attemptedAt >= JWKS_MIN_REFETCH_MS && (now - this.fetchedAt > JWKS_TTL_MS || !this.keys.has(kid))) await this.refresh();
    const key = this.keys.get(kid);
    if (!key && this.failure) throw new Refused(503, `cannot fetch Keycloak's signing keys: ${this.failure}`);
    return key;
  }

  private async refresh(): Promise<void> {
    this.attemptedAt = this.now();
    try {
      this.inflight ??= this.load().finally(() => (this.inflight = undefined));
      await this.inflight;
      this.failure = undefined;
    } catch (e) {
      this.failure = (e as Error).message;
    }
  }

  private async load(): Promise<void> {
    const res = await fetch(this.url, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string; use?: string })[] };
    const next = new Map<string, KeyObject>();
    // Signing RSA keys only: Keycloak also publishes an encryption key (use: enc).
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid || jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig')) continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        /* a malformed entry is skipped, never fatal to the rest */
      }
    }
    this.keys = next;
    this.fetchedAt = this.now();
  }
}

const SKEW_S = 5;
const MAX_TOKEN = 16_384;
// Someone acting as someone else (Keycloak impersonation, the admin
// "special access" session) must never use the engine as that person.
const IMPERSONATION = ['adminUser', 'specialAccess', 'impersonator', 'act'];
export const METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';
// RFC 6749 3.3 scope-token: no space, quote or backslash, so it sits in a
// quoted-string as is. config.ts already refuses anything else at startup.
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
// Sign-ins remembered for the offline_access log line (person and answer).
// Past this, the earliest logged is forgotten and logs again on its next request.
export const OFFLINE_LOG_MAX = 500;
// The serve log's format (cli.ts), for the one line the sign-in writes itself.
const stderrLog = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

// The MCP server name people add, after the deployment's host
// (agent-engine, agent-engine-web), so adding both doesn't collide.
export function serverName(publicUrl: string): string {
  const host = new URL(publicUrl).hostname;
  const first = host.split('.')[0] ?? '';
  return host.includes('.') && /^[a-z][a-z0-9-]{0,40}$/.test(first) ? first : 'agent-engine';
}

const part = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export class Login {
  private readonly base: string;
  private readonly issuer: string;
  private readonly wwwAuthenticate: string;
  private readonly logged = new Set<string>();

  constructor(
    private readonly cfg: LoginConfig,
    private readonly keys: SigningKeys = new JwksKeys(cfg.jwksUrl),
    private readonly now: () => number = Date.now,
    private readonly log: (s: string) => void = stderrLog,
  ) {
    this.base = cfg.publicUrl.replace(/\/+$/, '');
    this.issuer = cfg.issuer.replace(/\/+$/, '');
    const scopes = (cfg.scopes ?? []).filter((s) => SCOPE_TOKEN.test(s));
    this.wwwAuthenticate = `Bearer resource_metadata="${this.base}${METADATA_PATH}"${scopes.length ? `, scope="${scopes.join(' ')}"` : ''}`;
  }

  // RFC 9728: where Claude Code learns which authorization server to use.
  metadata(): Record<string, unknown> {
    return { resource: `${this.base}/mcp`, authorization_servers: [this.issuer], bearer_methods_supported: ['header'], resource_name: 'agent-engine', ...(this.cfg.scopes?.length ? { scopes_supported: this.cfg.scopes } : {}) };
  }

  // The 401's WWW-Authenticate. With scopes configured it also names them
  // (RFC 6750 section 3): the MCP authorization spec has clients ask for the
  // challenge's scope before the document's scopes_supported. Without any, it
  // is the bare resource_metadata challenge.
  challenge(): string {
    return this.wwwAuthenticate;
  }

  // Once per person and answer, per process (while remembered, OFFLINE_LOG_MAX):
  // whether their access token came with offline_access, so the logs show which
  // clients asked for the offline session. The user name and a yes/no only,
  // never the token or its claims.
  private noteOffline(email: string, offline: boolean): void {
    const key = `${email} ${offline}`;
    if (this.logged.has(key)) return;
    if (this.logged.size >= OFFLINE_LOG_MAX) {
      const [oldest] = this.logged;
      if (oldest !== undefined) this.logged.delete(oldest);
    }
    this.logged.add(key);
    this.log(`sign-in: ${nameFromEmail(email)} · offline_access ${offline ? 'yes' : 'no'}`);
  }

  // The company email the token was issued to, or Refused.
  async verify(token: string | undefined): Promise<string> {
    if (!token) throw new Refused(401, 'sign in first');
    const parts = token.length <= MAX_TOKEN ? token.split('.') : [];
    if (parts.length !== 3) throw new Refused(401, 'invalid token');
    const [h, p, s] = parts as [string, string, string];
    const header = part(h);
    // RS256 pinned: a token naming HS256 would otherwise be checked with the public key as an HMAC secret.
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Refused(401, 'invalid token');
    const key = await this.keys.keyFor(header.kid);
    if (!key || !verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) throw new Refused(401, 'invalid token');

    const c = part(p);
    const nowS = this.now() / 1000;
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    // typ: Keycloak signs ID and refresh tokens with the same keys; only an access token (Bearer) may pass.
    const ok =
      c.iss === this.issuer &&
      aud.includes(this.cfg.clientId) &&
      c.typ === 'Bearer' &&
      typeof c.exp === 'number' &&
      c.exp + SKEW_S > nowS &&
      !(typeof c.nbf === 'number' && c.nbf - SKEW_S > nowS);
    if (!ok) throw new Refused(401, 'invalid or expired token');
    // Which client obtained it. Only the engine's own client, so a token another app got for the person can't be replayed here.
    if (c.azp !== this.cfg.clientId) throw new Refused(403, `tokens from ${String(c.azp)} are not accepted`);
    if (IMPERSONATION.some((k) => k in c)) throw new Refused(403, 'impersonated sessions may not use the engine');
    // email_verified: the realm also holds customer accounts, and an unverified
    // address is only a claim; the invite list alone is not enough.
    const email = typeof c.email === 'string' ? c.email.toLowerCase() : '';
    if (c.email_verified !== true || !email.endsWith(`@${this.cfg.domain}`)) throw new Refused(403, `sign in with your verified @${this.cfg.domain} account`);
    this.noteOffline(email, typeof c.scope === 'string' && c.scope.split(' ').includes('offline_access'));
    return email;
  }
}
