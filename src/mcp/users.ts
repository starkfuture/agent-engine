import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

// People who may use the engine over MCP. Only a SHA-256 of each token is
// stored; the token itself is shown once, when the user is added.
const User = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9._-]{1,40}$/),
    role: z.enum(['member', 'admin']), // admin: stop/resume and approving lessons
    token_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    slack_id: z.string().regex(/^[UW][A-Z0-9]{5,20}$/).optional(), // for the "run finished" mention
    usd_per_day: z.number().positive().max(200).optional(), // overrides ENGINE_USER_DAILY_CAP_USD
    added_at: z.string(),
  })
  .strict();
export type User = z.infer<typeof User>;
const UsersFile = z.object({ users: z.array(User) }).strict();

const sha = (s: string) => createHash('sha256').update(s).digest();

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
  authenticate(token: string | undefined): User | undefined {
    if (!token || token.length > 200) return undefined;
    this.refresh();
    const h = sha(token);
    let found: User | undefined;
    for (const u of this.users) if (timingSafeEqual(h, Buffer.from(u.token_sha256, 'hex')) && !found) found = u;
    return found;
  }

  add(name: string, opts: { admin?: boolean; slackId?: string; usdPerDay?: number } = {}): string {
    this.refresh();
    if (this.users.some((u) => u.name === name)) throw new Error(`user ${name} exists; remove it first to issue a new token`);
    const token = `eng_${randomBytes(32).toString('base64url')}`;
    const user = User.parse({
      name,
      role: opts.admin ? 'admin' : 'member',
      token_sha256: sha(token).toString('hex'),
      ...(opts.slackId ? { slack_id: opts.slackId } : {}),
      ...(opts.usdPerDay ? { usd_per_day: opts.usdPerDay } : {}),
      added_at: new Date().toISOString(),
    });
    this.users.push(user);
    this.save();
    return token;
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
