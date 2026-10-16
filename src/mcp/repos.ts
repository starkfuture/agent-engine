import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Root } from '../engine/run.js';

// Repos the codebase agent may read on the engine host. Callers name a repo;
// they never pass a path, so a remote user can't point the agent anywhere else.
// A repo is read at one commit: `ref` (default origin/HEAD, else HEAD), never
// the working tree, so a clone on a feature branch doesn't leak into answers.
// Hosted, an entry names a GitHub repo instead (`github: owner/name`): the
// engine clones it into ENGINE_REPOS_DIR/<name> and keeps it fetched.
const REF = z.string().regex(/^(?!-)[A-Za-z0-9._/@^~-]{1,200}$/);
const Entry = z.union([
  z.string().min(1),
  z
    .object({
      path: z.string().min(1).optional(),
      github: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional(),
      ref: REF.optional(),
    })
    .strict()
    .refine((e) => e.path || e.github, 'a repo needs path or github'),
]);
const ReposFile = z.object({ repos: z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i), Entry) }).strict();

export interface RepoEntry extends Root {
  github?: string; // owner/name, synced by the engine
}

export function loadRepos(file: string, reposDir?: string): Map<string, RepoEntry> {
  if (!existsSync(file)) return new Map();
  const { repos } = ReposFile.parse(parse(readFileSync(file, 'utf8')) ?? { repos: {} });
  return new Map(
    Object.entries(repos).map(([name, e]) => {
      const { path: p, ref, github } = typeof e === 'string' ? { path: e, ref: undefined, github: undefined } : e;
      let abs: string;
      if (p) abs = p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p;
      else if (reposDir) abs = join(reposDir, name);
      else throw new Error(`repo ${name}: github repos need ENGINE_REPOS_DIR (where clones live) or a path`);
      if (!isAbsolute(abs)) throw new Error(`repo ${name}: path must be absolute or start with ~/`);
      return [name, { path: abs, ...(ref ? { ref } : {}), ...(github ? { github } : {}) }];
    }),
  );
}
