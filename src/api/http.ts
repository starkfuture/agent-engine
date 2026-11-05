import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Users } from '../mcp/users.js';
import { decodeCursor, encodeCursor, type FeedQuery, type Finding, type FindingsFeed } from './findings.js';
import type { ApiKey, ApiKeys, Refusal, Scope } from './keys.js';

// GET /api/v1/findings for local tools, with an API key (keys.ts). It never
// reaches MCP: no McpServer is built, and /mcp refuses these keys. Errors are
// `{ "error": … }`; a 401 names this API's realm, not the Keycloak sign-in,
// so a client is never sent into OAuth.

export const FEED_PATH = '/api/v1/findings';
const REALM = 'agent-engine-api';
const NEEDS: Scope = 'findings:read';
const PARAMS = new Set(['cursor', 'since', 'min_level', 'status', 'limit']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// Per key, in memory (one replica; a restart refills every bucket).
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    readonly burst: number,
    readonly perMinute: number,
  ) {}

  // 0 when allowed; else the seconds until one more request is.
  take(key: string, now: number): number {
    const rate = this.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) * rate);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
  }
}

export interface FindingsApiOptions {
  users: Users; // a key works only while the user who made it may still use the engine
  log?: ((s: string) => void) | undefined;
  slackLink?: ((ts: string) => Promise<string | undefined>) | undefined; // a Slack thread → its permalink
  rate?: { burst: number; perMinute: number };
  now?: () => Date;
}

export class FindingsApi {
  private readonly limiter: RateLimiter;
  private readonly now: () => Date;
  // Refusal log lines, at most one a minute per key id and reason (unknown ids share one).
  private readonly refused = new Map<string, { at: number; quiet: number }>();

  constructor(
    readonly keys: ApiKeys,
    readonly feed: FindingsFeed,
    private readonly o: FindingsApiOptions,
  ) {
    this.limiter = new RateLimiter(o.rate?.burst ?? 10, o.rate?.perMinute ?? 30);
    this.now = o.now ?? (() => new Date());
  }

  // The user behind a key, if they still have access: removed means the key
  // is dead too, also when someone is added again under that name or email.
  ownerActive(k: ApiKey): boolean {
    const u = this.o.users.list().find((x) => x.name === k.owner);
    return !!u && (u.email ?? null) === k.owner_email && u.added_at === k.owner_since;
  }

  private logRefusal(reason: Refusal | 'owner removed', id: string | undefined, now: number): void {
    const bucket = `${reason}:${reason === 'unknown' ? '*' : (id ?? '-')}`;
    const r = this.refused.get(bucket);
    if (r && now - r.at < 60_000) {
      r.quiet++;
      return;
    }
    this.refused.set(bucket, { at: now, quiet: 0 });
    if (this.refused.size > 1000) for (const [k, v] of this.refused) if (now - v.at > 60_000) this.refused.delete(k);
    this.o.log?.(`api: refused ${id ? `key ${id}` : 'request'} (${reason})${r?.quiet ? `; ${r.quiet} more since the last line` : ''}`);
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const send = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
      res.end(JSON.stringify(body));
    };
    const fail = (code: number, error: string, headers: Record<string, string> = {}) => send(code, { error }, headers);
    const challenge = (extra = '') => ({ 'www-authenticate': `Bearer realm="${REALM}"${extra}` });

    if (req.method !== 'GET') return fail(405, 'GET only', { allow: 'GET' });
    const now = this.now();
    const auth = req.headers.authorization ?? '';
    const token = /^Bearer /i.test(auth) ? auth.slice(7).trim() : undefined;
    let v;
    try {
      v = this.keys.verify(token, now);
    } catch (e) {
      this.o.log?.(`api: keys unavailable: ${(e as Error).message}`);
      return fail(503, 'the feed is unavailable right now; try again', { 'retry-after': '30' });
    }
    if (!v.ok) {
      this.logRefusal(v.reason, v.id, now.getTime());
      if (v.reason === 'missing') return fail(401, 'an API key is required: Authorization: Bearer ae_…', challenge());
      const why = v.reason === 'revoked' ? 'this key was revoked' : v.reason === 'expired' ? 'this key has expired' : 'invalid API key';
      return fail(401, why, challenge(', error="invalid_token"'));
    }
    const key = v.key;
    if (!this.ownerActive(key)) {
      this.logRefusal('owner removed', key.id, now.getTime());
      return fail(401, 'this key was revoked: the user who made it no longer has access', challenge(', error="invalid_token"'));
    }
    if (!key.scopes.includes(NEEDS)) return fail(403, `this key lacks the ${NEEDS} scope`, challenge(`, error="insufficient_scope", scope="${NEEDS}"`));
    const wait = this.limiter.take(key.id, now.getTime());
    if (wait) return fail(429, `rate limited: ${this.limiter.perMinute} requests a minute per key`, { 'retry-after': String(wait) });
    try {
      this.keys.touch(key.id, now);
    } catch (e) {
      this.o.log?.(`api: last_used_at for key ${key.id} not recorded: ${(e as Error).message}`);
    }

    const q = parseQuery(url.searchParams);
    if (typeof q === 'string') return fail(400, q);
    let page;
    try {
      page = this.feed.page(q, now);
    } catch (e) {
      this.o.log?.(`api: findings unavailable: ${(e as Error).message}`);
      return fail(503, 'the feed is unavailable right now; try again', { 'retry-after': '30' });
    }
    const findings: Finding[] = [];
    for (const { finding, thread } of page.findings) {
      if (thread && this.o.slackLink) finding.url = (await this.o.slackLink(thread)) ?? null;
      findings.push(finding);
    }
    return send(200, { findings, next: encodeCursor(page.next), more: page.more });
  }
}

// The query string, or what is wrong with it.
export function parseQuery(p: URLSearchParams): FeedQuery | string {
  for (const k of p.keys()) if (!PARAMS.has(k)) return `unknown parameter ${JSON.stringify(k.slice(0, 40))}; use ${[...PARAMS].join(', ')}`;
  for (const k of PARAMS) if (p.getAll(k).length > 1) return `${k} given twice`;
  const cursor = p.get('cursor');
  const since = p.get('since');
  if (cursor !== null && since !== null) return 'use since on the first call only, then the cursor';
  let after = { e: 0, t: 0 };
  if (cursor !== null) {
    const n = decodeCursor(cursor);
    if (n === undefined) return 'cursor: not one this feed returned';
    after = n;
  }
  let sinceIso: string | undefined;
  if (since !== null) {
    const t = ISO.test(since) ? Date.parse(since) : NaN;
    if (!Number.isFinite(t)) return 'since: an ISO 8601 time with a zone, e.g. 2026-11-05T08:00:00Z';
    sinceIso = new Date(t).toISOString();
  }
  const minLevel = p.get('min_level') ?? 'major';
  if (minLevel !== 'critical' && minLevel !== 'major') return 'min_level: critical or major (findings are only ever those two)';
  const status = p.get('status') ?? 'all';
  if (status !== 'open' && status !== 'resolved' && status !== 'all') return 'status: open, resolved or all';
  const limitRaw = p.get('limit') ?? '50';
  const limit = /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : NaN;
  if (!(limit >= 1 && limit <= 200)) return 'limit: 1 to 200';
  return { after, since: sinceIso, minLevel, status, limit };
}
