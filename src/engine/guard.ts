import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { isSecretFile } from './snapshot.js';

// Defense in depth only. The boundary for file tools is the snapshot (secret
// files are not on disk) plus the CLI's own blockReadsOutsideWorkingDirectories
// and deny rules (see session.ts), which judge every file a search touches.
// This hook catches the obvious escapes early, with a clear reason.

// Resolve symlinks; for a path that doesn't exist, resolve its nearest existing
// parent (on macOS /tmp is itself a symlink to /private/tmp).
function real(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(real(parent), basename(abs));
  }
}

export function pathAllowed(p: string, roots: string[], cwd: string): string | undefined {
  if (p.startsWith('~')) return `home-relative paths are not allowed: ${p}`;
  if (p.split(/[/\\]/).includes('..')) return `".." is not allowed in paths: ${p}`;
  const abs = real(isAbsolute(p) ? p : resolve(cwd, p));
  if (isSecretFile(abs)) return `path is a credential file: ${p}`;
  const inside = roots.some((r) => {
    const rel = relative(real(r), abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  return inside ? undefined : `path is outside the allowed folders: ${p}`;
}

export function pathGuard(roots: string[], cwd: string): HookCallbackMatcher {
  return {
    matcher: 'Read|Grep|Glob',
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        const a = (input.tool_input ?? {}) as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
        let reason: string | undefined;
        const path = str(a.file_path) ?? str(a.path);
        if (path) reason = pathAllowed(path, roots, cwd);
        // Glob patterns and Grep globs: the CLI splits Grep globs on spaces and commas.
        const patterns = [str(a.glob), input.tool_name === 'Glob' ? str(a.pattern) : undefined].filter((v): v is string => !!v).flatMap((g) => (g.includes('{') ? [g] : g.split(/[\s,]+/)));
        for (const g of patterns) {
          if (reason) break;
          if (g.startsWith('~') || isAbsolute(g) || g.split('/').includes('..')) reason = pathAllowed(g.replace(/[*?[{].*$/, '') || '/', roots, cwd);
        }
        return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
      },
    ],
  };
}
