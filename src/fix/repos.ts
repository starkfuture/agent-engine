import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

// Which repo a "Draft a fix" click works on, from the issue's rows. Only these
// repos, in the starkfuture org, whatever config/fixes.yaml says: the fix App
// is installed on them alone, and the engine checks again before every token,
// push and pull request.
export const OWNER = 'starkfuture';
export const FIX_REPOS = ['frontend-next', 'admin-next', 'web-admin', 'web-admin-cms', 'backend', 'backend-nest', 'argo-cd'] as const;
export type FixRepo = (typeof FIX_REPOS)[number];
export const allowedRepo = (repo: string): repo is FixRepo => (FIX_REPOS as readonly string[]).includes(repo);

// A rule matches a row like a noise.yaml entry: regexes, anchored, case-insensitive.
const Rule = z
  .object({
    repo: z.enum(FIX_REPOS), // nothing else
    section: z.string().optional(),
    service: z.string().optional(),
    route: z.string().optional(), // matches the row's subject
    status: z.string().optional(),
  })
  .strict()
  .refine((r) => r.section || r.service || r.route || r.status, 'a rule needs section, service, route or status');
const FixesFile = z.object({ repos: z.array(Rule).default([]) }).strict();

type Compiled = { repo: FixRepo } & { [K in 'section' | 'service' | 'route' | 'status']?: RegExp };

// A row key is section|service|subject|status; the subject may hold "|" itself.
export function parseRowKey(key: string): { section: string; service: string; subject: string; status: string } {
  const parts = key.split('|');
  return { section: parts[0] ?? '', service: parts[1] ?? '', subject: parts.slice(2, -1).join('|'), status: parts.length > 3 ? parts.at(-1)! : '' };
}

export class FixMap {
  private readonly rules: Compiled[];

  constructor(raw: unknown) {
    const f = FixesFile.parse(raw ?? {});
    this.rules = f.repos.map((r) => {
      const c: Compiled = { repo: r.repo };
      for (const k of ['section', 'service', 'route', 'status'] as const) if (r[k] !== undefined) c[k] = new RegExp(`^(?:${r[k]})$`, 'i');
      return c;
    });
  }

  static load(file: string): FixMap {
    return new FixMap(existsSync(file) ? parse(readFileSync(file, 'utf8')) : {});
  }

  // The first rule that matches a row names its repo.
  repoOf(key: string): FixRepo | undefined {
    const r = parseRowKey(key);
    return this.rules.find((c) => (!c.section || c.section.test(r.section)) && (!c.service || c.service.test(r.service)) && (!c.route || c.route.test(r.subject)) && (!c.status || c.status.test(r.status)))?.repo;
  }

  // The issue's repo: the one most of its rows map to; a tie goes to the rule
  // listed first. Undefined when no row maps.
  repoFor(rows: string[]): FixRepo | undefined {
    const n = new Map<FixRepo, number>();
    for (const k of rows) {
      const repo = this.repoOf(k);
      if (repo) n.set(repo, (n.get(repo) ?? 0) + 1);
    }
    const order = [...new Set(this.rules.map((r) => r.repo))];
    return [...n].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))[0]?.[0];
  }
}
