import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Severity } from './issues.js';

// Who owns a service: patrol cards mention the owner on lines to look at.
// Only these strings reach Slack unescaped, so only a user or a user-group
// mention is accepted: never <!channel>, <!here> or a link.
const MENTION = /^(?:<@[UW][A-Z0-9]{2,20}>|<!subteam\^S[A-Z0-9]{2,20}>)$/;
const Mention = z.string().regex(MENTION, 'must be <@U…> (a person) or <!subteam^S…> (a user group)');
// A runbook link reaches Slack unescaped too: https, on a host runbook_hosts
// lists, and nothing that could end the link or start another (checked below).
const LINK = /^https:\/\/[^\s<>|`"'\\]+$/;
const OwnersFile = z
  .object({
    mentions: z.boolean().default(true),
    // service name → a mention, or { primary, backup, runbook }. Keys: exact name, `prefix*`, or `/regex/` (anchored, case-insensitive).
    owners: z.record(z.string().min(1), z.union([Mention, z.strictObject({ primary: Mention, backup: Mention.optional(), runbook: z.string().optional() })])).default({}),
    // The hosts a runbook link may point at (exact, case-insensitive). Empty: no runbook links.
    runbook_hosts: z.array(z.string().regex(/^[a-z0-9.-]+$/i, 'must be a host name, e.g. wiki.example.com')).default([]),
    // The backup is asked in the issue's thread when nobody clicks On it. Absent: off.
    escalation: z.strictObject({ after_minutes: z.number().int().min(1), severities: z.array(z.enum(['critical', 'major'])).min(1) }).optional(),
  })
  .superRefine((f, ctx) => {
    const hosts = new Set(f.runbook_hosts.map((h) => h.toLowerCase()));
    for (const [key, v] of Object.entries(f.owners)) {
      if (typeof v === 'string' || v.runbook === undefined) continue;
      let host: string | undefined;
      try {
        const u = new URL(v.runbook);
        host = LINK.test(v.runbook) && !u.username && !u.password ? u.hostname.toLowerCase() : undefined;
      } catch {
        host = undefined;
      }
      if (!host || !hosts.has(host))
        ctx.addIssue({
          code: 'custom',
          path: ['owners', key, 'runbook'],
          message: `runbook ${JSON.stringify(v.runbook)} is not allowed: it must be a plain https link on a host listed in runbook_hosts (${[...hosts].join(', ') || 'none listed'})`,
        });
    }
  });

// A service's owner: the primary is mentioned on cards, the backup only when
// escalation asks for one (see runner), the runbook is linked on cards.
export interface Owner {
  primary: string;
  backup?: string | undefined;
  runbook?: string | undefined;
}

export interface Escalation {
  afterMinutes: number;
  severities: ReadonlySet<Severity>;
}

type Matcher = { kind: 'exact' | 'prefix' | 'regex'; key: string; re?: RegExp; owner: Owner };

function compile(key: string, owner: Owner): Matcher {
  if (key.length > 2 && key.startsWith('/') && key.endsWith('/')) return { kind: 'regex', key, re: new RegExp(`^(?:${key.slice(1, -1)})$`, 'i'), owner };
  if (key.endsWith('*')) return { kind: 'prefix', key: key.slice(0, -1).toLowerCase(), owner };
  return { kind: 'exact', key: key.toLowerCase(), owner };
}

export class Owners {
  readonly mentions: boolean;
  readonly escalation: Escalation | undefined;
  private readonly m: Matcher[];

  constructor(raw: unknown) {
    const f = OwnersFile.parse(raw ?? {});
    this.mentions = f.mentions;
    this.escalation = f.escalation && { afterMinutes: f.escalation.after_minutes, severities: new Set(f.escalation.severities) };
    this.m = Object.entries(f.owners).map(([k, v]) => compile(k, typeof v === 'string' ? { primary: v } : v));
  }

  static load(file: string): Owners {
    return new Owners(existsSync(file) ? parse(readFileSync(file, 'utf8')) : {});
  }

  // Most specific wins: an exact name, then the longest prefix, then the first
  // regex in file order. Unknown services (or mentions off) get no one.
  ownerOf(service: string): Owner | undefined {
    if (!this.mentions) return undefined;
    const s = service.toLowerCase();
    const exact = this.m.find((x) => x.kind === 'exact' && x.key === s);
    if (exact) return exact.owner;
    const prefix = this.m.filter((x) => x.kind === 'prefix' && s.startsWith(x.key)).sort((a, b) => b.key.length - a.key.length)[0];
    if (prefix) return prefix.owner;
    return this.m.find((x) => x.kind === 'regex' && x.re!.test(service))?.owner;
  }
}
