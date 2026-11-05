import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// API keys for local tools (Lookout and the like) that read the findings feed
// (GET /api/v1/findings) and nothing else: no MCP tool, no admin action. An
// admin makes one with the MCP tool create_api_key; the key is shown once and
// only its SHA-256 is kept. They live in the engine's SQLite file next to the
// issue record (a retained volume), so a restart keeps them. An older image
// ignores these tables, so a rollback is safe.
//
// A key is `ae_<id>_<secret>`: a 12-hex id (shown in lists and logs, not a
// secret) and 32 random bytes as base64url (43 characters, which can hold `_`,
// so it is parsed with an anchored pattern). The stored hash is a SHA-256 of
// the whole key. The secret is 256 bits from the OS, so that is enough: a
// pepper or a slow hash only helps guessable secrets, and would cost a secret
// and a restart, or CPU on every request.

export const SCOPES = ['findings:read'] as const;
export type Scope = (typeof SCOPES)[number];
export const KEY_FORMAT = /^ae_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
export const KEY_ID = /^[0-9a-f]{12}$/;
export const KEY_NAME = /^[a-z0-9][a-z0-9._-]{1,40}$/;
export const MAX_KEY_DAYS = 365;
const DAY = 86_400_000;
const TOUCH_MS = 60_000; // last_used_at moves at most once a minute per key

export interface ApiKey {
  id: string;
  name: string;
  owner: string; // the engine user who made it
  owner_email: string | null; // that user's sign-in email,
  owner_since: string; // and when that user was added: a later user under the same name or email is not its owner
  scopes: Scope[];
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

// Why a key was refused. `unknown` covers a wrong secret too, and is all a
// caller learns unless it holds the real key (then: revoked or expired).
export type Refusal = 'missing' | 'malformed' | 'unknown' | 'revoked' | 'expired';
export type Verified = { ok: true; key: ApiKey } | { ok: false; reason: Refusal; id?: string };

export type KeyEventType = 'created' | 'revoked';

const sha = (s: string) => createHash('sha256').update(s).digest();
const ZERO = Buffer.alloc(32);

interface Row extends Omit<ApiKey, 'scopes'> {
  scopes: string;
  secret_sha256: string;
}

export class ApiKeys {
  private readonly db: DatabaseSync;
  private readonly touched = new Map<string, number>();

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // Additive: new tables only. api_key_events is append-only.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, owner_email TEXT, owner_since TEXT NOT NULL,
        scopes TEXT NOT NULL, secret_sha256 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, revoked_by TEXT
      );
      CREATE INDEX IF NOT EXISTS api_keys_owner ON api_keys (owner);
      CREATE TABLE IF NOT EXISTS api_key_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key_id TEXT NOT NULL REFERENCES api_keys (id),
        type TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TRIGGER IF NOT EXISTS api_key_events_no_update BEFORE UPDATE ON api_key_events BEGIN SELECT RAISE(ABORT, 'api_key_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS api_key_events_no_delete BEFORE DELETE ON api_key_events BEGIN SELECT RAISE(ABORT, 'api_key_events is append-only'); END;
    `);
  }

  static memory(): ApiKeys {
    return new ApiKeys(':memory:');
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private event(id: string, type: KeyEventType, at: Date, by: string, data: Record<string, unknown> = {}): void {
    this.db.prepare(`INSERT INTO api_key_events (key_id, type, at, by, data) VALUES (?, ?, ?, ?, ?)`).run(id, type, at.toISOString(), by, JSON.stringify(data));
  }

  // A new key. `secret` is the whole key: hand it to the person once and drop
  // it; nothing here keeps it.
  create(o: { name: string; owner: string; ownerEmail?: string | undefined; ownerSince: string; scopes: readonly Scope[]; days: number }, now = new Date()): { key: ApiKey; secret: string } {
    if (!KEY_NAME.test(o.name)) throw new Error('name: 2 to 41 of a-z, 0-9, . _ -, starting with a letter or digit');
    if (!Number.isInteger(o.days) || o.days < 1 || o.days > MAX_KEY_DAYS) throw new Error(`keys last 1 to ${MAX_KEY_DAYS} days`);
    const scopes = [...new Set(o.scopes)].sort();
    if (!scopes.length || scopes.some((s) => !(SCOPES as readonly string[]).includes(s))) throw new Error(`scopes: ${SCOPES.join(', ')}`);
    const { id, secret } = this.tx(() => {
      for (;;) {
        const id = randomBytes(6).toString('hex');
        if (this.db.prepare(`SELECT 1 FROM api_keys WHERE id = ?`).get(id)) continue;
        const secret = `ae_${id}_${randomBytes(32).toString('base64url')}`;
        const expires = new Date(now.getTime() + o.days * DAY).toISOString();
        this.db
          .prepare(`INSERT INTO api_keys (id, name, owner, owner_email, owner_since, scopes, secret_sha256, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, o.name, o.owner, o.ownerEmail?.toLowerCase() ?? null, o.ownerSince, JSON.stringify(scopes), sha(secret).toString('hex'), now.toISOString(), expires);
        this.event(id, 'created', now, o.owner, { name: o.name, scopes, expires_at: expires });
        return { id, secret };
      }
    });
    return { key: this.get(id)!, secret };
  }

  private static key(r: Row): ApiKey {
    const { id, name, owner, owner_email, owner_since, created_at, expires_at, last_used_at, revoked_at, revoked_by } = r;
    return { id, name, owner, owner_email, owner_since, scopes: JSON.parse(r.scopes) as Scope[], created_at, expires_at, last_used_at, revoked_at, revoked_by };
  }

  get(id: string): ApiKey | undefined {
    const r = this.db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(id) as unknown as Row | undefined;
    return r && ApiKeys.key(r);
  }

  // Metadata only, newest first: the hash never leaves this class.
  list(): ApiKey[] {
    return (this.db.prepare(`SELECT * FROM api_keys ORDER BY created_at DESC, id`).all() as unknown as Row[]).map(ApiKeys.key);
  }

  // Revoked keys stay listed (and in api_key_events) as a record.
  revoke(id: string, by: string, now = new Date(), reason?: string): 'revoked' | 'already' | 'unknown' {
    return this.tx(() => {
      const r = this.get(id);
      if (!r) return 'unknown';
      if (r.revoked_at) return 'already';
      this.db.prepare(`UPDATE api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ?`).run(now.toISOString(), by, id);
      this.event(id, 'revoked', now, by, reason ? { reason } : {});
      return 'revoked';
    });
  }

  // Every live key a user made: when they are removed, their keys go too.
  revokeOwnedBy(owner: string, by: string, now = new Date()): string[] {
    const ids = (this.db.prepare(`SELECT id FROM api_keys WHERE owner = ? AND revoked_at IS NULL ORDER BY id`).all(owner) as Array<{ id: string }>).map((r) => r.id);
    return ids.filter((id) => this.revoke(id, by, now, `owner ${owner} removed`) === 'revoked');
  }

  // The key behind a bearer token. The secret is compared in constant time
  // against the stored hash; an id that doesn't exist still costs a compare.
  verify(token: string | undefined, now = new Date()): Verified {
    if (!token) return { ok: false, reason: 'missing' };
    const m = token.length <= 80 ? KEY_FORMAT.exec(token) : null;
    if (!m) return { ok: false, reason: 'malformed' };
    const id = m[1]!;
    const r = this.db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(id) as unknown as Row | undefined;
    const match = timingSafeEqual(sha(token), r ? Buffer.from(r.secret_sha256, 'hex') : ZERO);
    if (!r || !match) return { ok: false, reason: 'unknown', id };
    if (r.revoked_at) return { ok: false, reason: 'revoked', id };
    if (Date.parse(r.expires_at) <= now.getTime()) return { ok: false, reason: 'expired', id };
    return { ok: true, key: ApiKeys.key(r) };
  }

  // A key was used: last_used_at, at most once a minute per key.
  touch(id: string, now = new Date()): void {
    const t = now.getTime();
    if (t - (this.touched.get(id) ?? 0) < TOUCH_MS) return;
    this.touched.set(id, t);
    this.db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`).run(now.toISOString(), id, new Date(t - TOUCH_MS).toISOString());
  }

  events(id: string): Array<{ id: number; key_id: string; type: KeyEventType; at: string; by: string; data: Record<string, unknown> }> {
    return (this.db.prepare(`SELECT * FROM api_key_events WHERE key_id = ? ORDER BY id`).all(id) as Array<{ id: number; key_id: string; type: KeyEventType; at: string; by: string; data: string }>).map((e) => ({
      ...e,
      id: Number(e.id),
      data: JSON.parse(e.data) as Record<string, unknown>,
    }));
  }
}
