import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Root } from '../engine/run.js';

// Repos the codebase agent may read on the engine host. Callers name a repo;
// they never pass a path, so a remote user can't point the agent anywhere else.
// A repo is read at one commit: `ref` (default origin/HEAD, else HEAD), never
// the working tree, so a clone on a feature branch doesn't leak into answers.
const Entry = z.union([z.string().min(1), z.object({ path: z.string().min(1), ref: z.string().regex(/^(?!-)[A-Za-z0-9._/@^~-]{1,200}$/).optional() }).strict()]);
const ReposFile = z.object({ repos: z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i), Entry) }).strict();

export function loadRepos(file: string): Map<string, Root> {
  if (!existsSync(file)) return new Map();
  const { repos } = ReposFile.parse(parse(readFileSync(file, 'utf8')) ?? { repos: {} });
  return new Map(
    Object.entries(repos).map(([name, e]) => {
      const { path: p, ref } = typeof e === 'string' ? { path: e, ref: undefined } : e;
      const abs = p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p;
      if (!isAbsolute(abs)) throw new Error(`repo ${name}: path must be absolute or start with ~/`);
      return [name, { path: abs, ...(ref ? { ref } : {}) }];
    }),
  );
}
