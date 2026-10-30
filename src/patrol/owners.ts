import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

// Who owns a service: patrol cards mention the owner on lines to look at.
// Only these strings reach Slack unescaped, so only a user or a user-group
// mention is accepted: never <!channel>, <!here> or a link.
const MENTION = /^(?:<@[UW][A-Z0-9]{2,20}>|<!subteam\^S[A-Z0-9]{2,20}>)$/;
const OwnersFile = z.object({
  mentions: z.boolean().default(true),
  // service name → mention. Keys: exact name, `prefix*`, or `/regex/` (anchored, case-insensitive).
  owners: z.record(z.string().min(1), z.string().regex(MENTION, 'must be <@U…> (a person) or <!subteam^S…> (a user group)')).default({}),
});

type Matcher = { kind: 'exact' | 'prefix' | 'regex'; key: string; re?: RegExp; mention: string };

function compile(key: string, mention: string): Matcher {
  if (key.length > 2 && key.startsWith('/') && key.endsWith('/')) return { kind: 'regex', key, re: new RegExp(`^(?:${key.slice(1, -1)})$`, 'i'), mention };
  if (key.endsWith('*')) return { kind: 'prefix', key: key.slice(0, -1).toLowerCase(), mention };
  return { kind: 'exact', key: key.toLowerCase(), mention };
}

export class Owners {
  readonly mentions: boolean;
  private readonly m: Matcher[];

  constructor(raw: unknown) {
    const f = OwnersFile.parse(raw ?? {});
    this.mentions = f.mentions;
    this.m = Object.entries(f.owners).map(([k, v]) => compile(k, v));
  }

  static load(file: string): Owners {
    return new Owners(existsSync(file) ? parse(readFileSync(file, 'utf8')) : {});
  }

  // Most specific wins: an exact name, then the longest prefix, then the first
  // regex in file order. Unknown services (or mentions off) get no one.
  ownerOf(service: string): string | undefined {
    if (!this.mentions) return undefined;
    const s = service.toLowerCase();
    const exact = this.m.find((x) => x.kind === 'exact' && x.key === s);
    if (exact) return exact.mention;
    const prefix = this.m.filter((x) => x.kind === 'prefix' && s.startsWith(x.key)).sort((a, b) => b.key.length - a.key.length)[0];
    if (prefix) return prefix.mention;
    return this.m.find((x) => x.kind === 'regex' && x.re!.test(service))?.mention;
  }
}
