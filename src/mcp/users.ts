import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

// People who may use the engine over MCP. Only a SHA-256 of each token is
// stored; the token itself is shown once, when it is issued. Tokens expire
// (90 days at most); a Google login issues or renews a member's token.
const User = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9._-]{1,40}$/),
    role: z.enum(['member', 'admin']), // admin: stop/resume and approving lessons
    token_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    slack_id: z.string().regex(/^[UW][A-Z0-9]{5,20}$/).optional(), // for the "run finished" mention
    usd_per_day: z.number().positive().max(200).optional(), // overrides ENGINE_USER_DAILY_CAP_USD
    email: z.string().optional(), // set when the token came from a Google login
    added_at: z.string(),
    expires_at: z.string().optional(), // absent (older files): added_at + 90 days
  })
  .strict();
export type User = z.infer<typeof User>;
const UsersFile = z.object({ users: z.array(User) }).strict();

const sha = (s: string) => createHash('sha256').update(s).digest();
export const MAX_TOKEN_DAYS = 90;
const DAY = 86_400_000;
export const expiresAt = (u: User): number => (u.expires_at ? Date.parse(u.expires_at) : Date.parse(u.added_at) + MAX_TOKEN_DAYS * DAY);

export class Users {
  private stamp = '';
  private constructor(
    readonly file: string,
    private users: User[],
  ) {
    this.stamp = Users.stampOf(file);
  }

  private static stampOf(file: string): string {
    try {
      const s = statSync(file);
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return 'missing';
    }
  }

  private static read(file: string): User[] {
    return existsSync(file) ? UsersFile.parse(JSON.parse(readFileSync(file, 'utf8'))).users : [];
  }

  static load(file: string): Users {
    return new Users(file, Users.read(file));
  }

  // A running server picks up `user add`/`user remove` from another process:
  // a removed token stops working on the next request. A file that fails to
  // parse keeps the last good list.
  private refresh(): void {
    const now = Users.stampOf(this.file);
    if (now === this.stamp) return;
    try {
      this.users = Users.read(this.file);
      this.stamp = now;
    } catch {
      /* keep the last good list */
    }
  }

  list(): User[] {
    this.refresh();
    return [...this.users];
  }

  // Constant-time over every user, so timing doesn't reveal near matches.
  // An expired token is the same as an unknown one.
  authenticate(token: string | undefined, now = new Date()): User | undefined {
    if (!token || token.length > 200) return undefined;
    this.refresh();
    const h = sha(token);
    let found: User | undefined;
    for (const u of this.users) if (timingSafeEqual(h, Buffer.from(u.token_sha256, 'hex')) && !found) found = u;
    return found && expiresAt(found) > now.getTime() ? found : undefined;
  }

  add(name: string, opts: { admin?: boolean; slackId?: string; usdPerDay?: number; days?: number; email?: string } = {}): string {
    this.refresh();
    if (this.users.some((u) => u.name === name)) throw new Error(`user ${name} exists; remove it first to issue a new token`);
    const { token, fields } = Users.fresh(opts.days);
    this.users.push(
      User.parse({
        name,
        role: opts.admin ? 'admin' : 'member',
        ...fields,
        ...(opts.slackId ? { slack_id: opts.slackId } : {}),
        ...(opts.usdPerDay ? { usd_per_day: opts.usdPerDay } : {}),
        ...(opts.email ? { email: opts.email } : {}),
      }),
    );
    this.save();
    return token;
  }

  // After a verified Google login: a new token for that person, replacing any
  // old one. New people become members. An existing user is renewed only if
  // bound to this same email: a login must never adopt a CLI-made user (an
  // admin named `lead` would otherwise go to whoever owns lead@<domain>).
  issue(name: string, email: string, now = new Date()): { token: string; user: User } {
    this.refresh();
    const existing = this.users.find((u) => u.name === name);
    if (existing && existing.email !== email) throw new Error(`the name ${name} is taken by another account; ask an admin`);
    const { token, fields } = Users.fresh(undefined, now);
    const user = User.parse({ ...(existing ?? { name, role: 'member' }), ...fields, email, ...(existing ? { added_at: existing.added_at } : {}) });
    this.users = [...this.users.filter((u) => u.name !== name), user];
    this.save();
    return { token, user };
  }

  private static fresh(days = MAX_TOKEN_DAYS, now = new Date()): { token: string; fields: { token_sha256: string; added_at: string; expires_at: string } } {
    if (!(days > 0) || days > MAX_TOKEN_DAYS) throw new Error(`tokens last 1 to ${MAX_TOKEN_DAYS} days`);
    const token = `eng_${randomBytes(32).toString('base64url')}`;
    return { token, fields: { token_sha256: sha(token).toString('hex'), added_at: now.toISOString(), expires_at: new Date(now.getTime() + days * DAY).toISOString() } };
  }

  remove(name: string): boolean {
    this.refresh();
    const before = this.users.length;
    this.users = this.users.filter((u) => u.name !== name);
    if (this.users.length === before) return false;
    this.save();
    return true;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ users: this.users }, null, 1) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
    this.stamp = Users.stampOf(this.file);
  }
}
