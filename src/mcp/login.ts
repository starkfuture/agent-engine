import { createHash, randomBytes } from 'node:crypto';
import { NotInvited, type Users } from './users.js';
export { nameFromEmail } from './users.js';

// Tokens are issued only after a Google login on the company domain (DevOps,
// 2026-10-16): /login sends the browser to Google, /login/callback checks the
// identity and shows a fresh token once. Claude Code then uses that token as a
// bearer header (it can't pass an SSO page in front of /mcp). Move to MCP OAuth
// before a wider rollout.

export interface LoginConfig {
  clientId: string;
  clientSecret: string;
  publicUrl: string; // https://agent-engine.<internal domain>, the address people open
  domain: string; // starkfuture.com
  admins?: string[]; // ENGINE_ADMINS: emails that may sign in before anyone invited them, as admins
}

export interface LoginResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const STATE_TTL_MS = 10 * 60_000;
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
};
const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const page = (status: number, title: string, body: string): LoginResponse => ({
  status,
  headers: PAGE_HEADERS,
  body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${html(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;color:#111;background:#fff}code,pre{background:#f3f3f3;padding:.2rem .4rem;border-radius:4px;word-break:break-all;white-space:pre-wrap}</style><h1>${html(title)}</h1>${body}`,
});

export class Login {
  private readonly pending = new Map<string, { verifier: string; at: number }>();

  constructor(
    private readonly cfg: LoginConfig,
    private readonly users: Users,
    private readonly now: () => number = Date.now,
  ) {}

  private redirectUri(): string {
    return `${this.cfg.publicUrl.replace(/\/$/, '')}/login/callback`;
  }

  async handle(url: URL): Promise<LoginResponse> {
    for (const [k, v] of this.pending) if (this.now() - v.at > STATE_TTL_MS) this.pending.delete(k);
    if (url.pathname === '/login') return this.start();
    if (url.pathname === '/login/callback') return this.callback(url);
    return page(404, 'Not found', '');
  }

  // PKCE + a one-time state; hd asks Google to offer company accounts only
  // (a hint, checked again on the way back).
  private start(): LoginResponse {
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.pending.set(state, { verifier, at: this.now() });
    const u = new URL(AUTH);
    for (const [k, v] of Object.entries({
      client_id: this.cfg.clientId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: 'openid email',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      hd: this.cfg.domain,
      prompt: 'select_account',
    }))
      u.searchParams.set(k, v);
    return { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' }, body: '' };
  }

  private async callback(url: URL): Promise<LoginResponse> {
    const state = url.searchParams.get('state') ?? '';
    const p = this.pending.get(state);
    this.pending.delete(state); // one use, whatever happens next
    if (!p) return page(400, 'Login expired', '<p>Start again at <a href="/login">/login</a>.</p>');
    const code = url.searchParams.get('code');
    if (!code) return page(400, 'Login cancelled', '<p>Start again at <a href="/login">/login</a>.</p>');

    let idToken: string;
    try {
      const res = await fetch(TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, redirect_uri: this.redirectUri(), grant_type: 'authorization_code', code_verifier: p.verifier }),
        signal: AbortSignal.timeout(10_000),
      });
      const j = (await res.json()) as { id_token?: string };
      if (!res.ok || !j.id_token) return page(502, 'Google login failed', '<p>Try again.</p>');
      idToken = j.id_token;
    } catch {
      return page(502, 'Google login failed', '<p>Try again.</p>');
    }

    // The ID token came straight from Google's token endpoint over TLS, so its
    // claims are trusted without a signature check (OIDC Core 3.1.3.7). The
    // checks that matter: our client, not expired, a verified company email.
    const c = claims(idToken);
    const email = typeof c.email === 'string' ? c.email.toLowerCase() : '';
    const ok =
      ISSUERS.has(String(c.iss)) &&
      c.aud === this.cfg.clientId &&
      typeof c.exp === 'number' &&
      c.exp * 1000 > this.now() &&
      c.email_verified === true &&
      c.hd === this.cfg.domain &&
      email.endsWith(`@${this.cfg.domain}`);
    if (!ok) return page(403, 'Not allowed', `<p>Sign in with your verified @${html(this.cfg.domain)} Google account.</p>`);

    let issued;
    try {
      issued = this.users.issue(email, new Date(this.now()), this.cfg.admins ?? []);
    } catch (e) {
      if (e instanceof NotInvited) return page(403, 'Not on the list yet', `<p>Signed in as <b>${html(email)}</b>, but an engine admin hasn't added you. Ask one to invite you, then sign in again.</p>`);
      return page(409, 'Ask an admin', `<p>${html((e as Error).message)}</p>`);
    }
    const mcp = `${this.cfg.publicUrl.replace(/\/$/, '')}/mcp`;
    // One MCP name per deployment (agent-engine, agent-engine-web), so adding both doesn't collide.
    const server = new URL(this.cfg.publicUrl).hostname.split('.')[0]!.replace(/[^a-z0-9-]/gi, '') || 'engine';
    return page(
      200,
      'Your agent-engine token',
      `<p>Signed in as <b>${html(email)}</b> (user <code>${html(issued.user.name)}</code>). This token is shown once and expires on <b>${html(issued.user.expires_at!.slice(0, 10))}</b>. Any older token of yours stopped working just now.</p>
<p>Add the engine to Claude Code:</p>
<pre>claude mcp add --transport http ${html(server)} ${html(mcp)} --header "Authorization: Bearer ${html(issued.token)}"</pre>
<p>Keep it like a password. To renew it or after losing it, sign in here again.</p>`,
    );
  }
}

function claims(jwt: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}
