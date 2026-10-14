import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

// Repos the codebase agent may read on the engine host. Callers name a repo;
// they never pass a path, so a remote user can't point the agent anywhere else.
const ReposFile = z.object({ repos: z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i), z.string().min(1)) }).strict();

export function loadRepos(file: string): Map<string, string> {
  if (!existsSync(file)) return new Map();
  const { repos } = ReposFile.parse(parse(readFileSync(file, 'utf8')) ?? { repos: {} });
  return new Map(
    Object.entries(repos).map(([name, p]) => {
      const abs = p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p;
      if (!isAbsolute(abs)) throw new Error(`repo ${name}: path must be absolute or start with ~/`);
      return [name, abs];
    }),
  );
}
