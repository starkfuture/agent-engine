import { createSign } from 'node:crypto';

// The engine reads our repos as a GitHub App with contents:read, never with a
// person's token. An app JWT (10 min) buys an installation token (1 h), which
// is cached until 5 min before it expires. Neither the key nor a token is ever
// logged or put in an error message.

export interface AppCreds {
  appId: string;
  installationId: string;
  privateKey: string; // PEM
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

// RS256 JWT for the app itself. iat is backdated 60 s for clock drift; GitHub
// refuses exp more than 10 min after iat.
export function appJwt(appId: string, privateKey: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

export class InstallationTokens {
  private cached?: { token: string; expiresAt: number };

  constructor(
    private readonly creds: AppCreds,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly api = 'https://api.github.com',
  ) {
    if (!/^\d+$/.test(creds.appId) || !/^\d+$/.test(creds.installationId)) throw new Error('GitHub App id and installation id must be numbers');
  }

  async token(nowMs = Date.now()): Promise<string> {
    if (this.cached && this.cached.expiresAt - 5 * 60_000 > nowMs) return this.cached.token;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.api}/app/installations/${this.creds.installationId}/access_tokens`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${appJwt(this.creds.appId, this.creds.privateKey, nowMs)}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new Error(`GitHub App token: ${(e as Error).name}`); // the message could echo the request
    }
    if (!res.ok) throw new Error(`GitHub App token: HTTP ${res.status}`);
    const j = (await res.json()) as { token?: string; expires_at?: string };
    if (!j.token || !j.expires_at) throw new Error('GitHub App token: unexpected response');
    this.cached = { token: j.token, expiresAt: Date.parse(j.expires_at) };
    return j.token;
  }
}
