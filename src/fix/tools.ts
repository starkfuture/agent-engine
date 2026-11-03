import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { pathAllowed } from '../engine/guard.js';
import type { OutputSpec, ToolFactory } from '../engine/run.js';
import { isSecretFile } from '../engine/snapshot.js';

// The codebase agent's hands for a draft fix: two in-process tools that write
// into the run's snapshot (so Read and Grep see the edits) and remember each
// file's new content. The engine, not the model, later writes those files
// into a checkout, commits and pushes them (src/fix/draft.ts). The tools take
// paths inside the repo only, and refuse secret files, git internals and CI
// workflows (the fix App can't push workflows anyway).

export const MAX_FILES = 20;
const MAX_BYTES = 300_000;
// A repo path: letters, digits and . _ - / @ + [ ] ( ) (Next.js route folders
// use @, [ ] and ( )). No spaces, newlines, control characters, backticks, <
// or &: a file name goes into the PR body, and must not break out of it.
const PATH = /^[A-Za-z0-9._@+\-/[\]()]+$/;

// Where a path the model gave lands, relative to the repo root, or why it can't.
export function fixPath(root: string, p: string): { rel: string } | { error: string } {
  if (!p || p.length > 300) return { error: 'a path to a file is needed, 300 characters at most' };
  let rel = p;
  if (isAbsolute(p)) {
    const r = relative(root, p);
    if (r.startsWith('..') || isAbsolute(r)) return { error: `path is outside the repo: ${p}` };
    rel = r;
  }
  if (p.startsWith('~') || rel.split('/').includes('..')) return { error: `path is outside the repo: ${p}` };
  rel = normalize(rel).split(sep).join('/').replace(/^\.\//, '');
  if (!rel || rel === '.') return { error: 'a path to a file is needed' };
  if (!PATH.test(rel)) return { error: `not a plain repo path (letters, digits and . _ - / @ + [ ] ( ) only): ${JSON.stringify(rel.slice(0, 80))}` };
  const parts = rel.toLowerCase().split('/');
  if (parts.includes('.git')) return { error: `git internals are off limits: ${rel}` };
  if (rel.toLowerCase().startsWith('.github/workflows/')) return { error: `CI workflows are off limits: ${rel}` };
  if (isSecretFile(rel)) return { error: `a credential file: ${rel}` };
  const why = pathAllowed(join(root, rel), [root], root);
  if (why) return { error: why };
  return { rel };
}

// Write one file the model changed into a checkout: the same checks, and
// never through a symlink, so nothing lands outside the checkout.
export function writeInto(root: string, rel: string, content: string): void {
  const t = fixPath(root, rel);
  if ('error' in t || t.rel !== rel) throw new Error(`refusing to write ${rel}: ${'error' in t ? t.error : 'not a plain repo path'}`);
  const abs = join(root, rel);
  try {
    if (lstatSync(abs).isSymbolicLink()) throw new Error(`refusing to write ${rel}: it is a symlink`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  mkdirSync(dirname(abs), { recursive: true });
  const outside = pathAllowed(abs, [root], root); // again, now that its folders exist
  if (outside) throw new Error(`refusing to write ${rel}: ${outside}`);
  writeFileSync(abs, content);
}

// `changes` collects repo path → new content. The challenger (never on for a
// fix) gets no hands.
export function fixTools(changes: Map<string, string>): ToolFactory {
  return (_ev, by, roots) => {
    const root = roots?.[0];
    if (by !== 'author' || !root) return [];
    const done = (text: string) => ({ content: [{ type: 'text' as const, text }] });
    const fail = (text: string) => ({ content: [{ type: 'text' as const, text: `error: ${text}` }], isError: true });
    const put = (rel: string, content: string) => {
      if (Buffer.byteLength(content) > MAX_BYTES) return `too large: at most ${MAX_BYTES} bytes per file`;
      if (!changes.has(rel) && changes.size >= MAX_FILES) return `at most ${MAX_FILES} files per fix`;
      writeInto(root, rel, content);
      changes.set(rel, content);
      return undefined;
    };
    return [
      tool(
        'write_file',
        'Create or replace one file of the repo with this content. Path relative to the repo root. Read and Grep see the new content. The engine commits your files to a draft pull request; you never push.',
        { path: z.string().min(1).max(300), content: z.string().max(MAX_BYTES) },
        async ({ path, content }) => {
          const t = fixPath(root, path);
          if ('error' in t) return fail(t.error);
          const why = put(t.rel, content);
          return why ? fail(why) : done(`wrote ${t.rel} (${content.split('\n').length} lines)`);
        },
      ),
      tool(
        'edit_file',
        'Replace one exact piece of text in a file of the repo. old_string must appear exactly once; include enough surrounding lines to make it unique. Path relative to the repo root.',
        { path: z.string().min(1).max(300), old_string: z.string().min(1).max(MAX_BYTES), new_string: z.string().max(MAX_BYTES) },
        async ({ path, old_string, new_string }) => {
          const t = fixPath(root, path);
          if ('error' in t) return fail(t.error);
          let text: string;
          try {
            text = readFileSync(join(root, t.rel), 'utf8');
          } catch {
            return fail(`no file ${t.rel}; create it with write_file`);
          }
          const n = text.split(old_string).length - 1;
          if (n !== 1) return fail(n ? `old_string appears ${n} times in ${t.rel}; add surrounding lines to make it unique` : `old_string is not in ${t.rel}`);
          const why = put(t.rel, text.replace(old_string, () => new_string));
          return why ? fail(why) : done(`edited ${t.rel}`);
        },
      ),
    ] as SdkMcpToolDefinition<any>[];
  };
}

// The fix's account, for the pull request and get_run. The files are what
// the tools recorded, not what the model says it changed.
export const FixShape = {
  summary: z.string().min(10).max(1500).describe('What you changed and why, bottom line first.'),
  cause: z.string().min(10).max(900).describe('The cause in the code, in one or two sentences.'),
  evidence: z
    .array(z.object({ id: z.string(), quote: z.string().min(3).max(300).describe('Exact text copied from that tool result') }))
    .min(1)
    .max(10)
    .describe('The code you read that shows the cause: evidence_id plus an exact quote from each result'),
  test: z.string().min(5).max(600).describe('The test you added or changed, what it checks, and the command a reviewer runs.'),
  notes: z.array(z.string().max(400)).max(8).default([]).describe('For the reviewer: risks, what you did not check, anything unsure.'),
};
const Fix = z.object(FixShape);
export type Fix = z.infer<typeof Fix>;

export function fixOutput(changes: Map<string, string>): OutputSpec<Fix> {
  return {
    tool: 'submit_fix',
    description: 'Submit the fix once, after writing its files with write_file or edit_file. Cite the code that shows the cause: the evidence_id and an exact quote copied from that tool result. Invalid submissions come back with the reason; fix and resubmit.',
    shape: FixShape,
    evidenceOf: (f) => f.evidence,
    check: () => (changes.size ? [] : ['no files changed: write the fix and its test with write_file or edit_file first']),
    max: 1,
  };
}
