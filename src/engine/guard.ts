import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

// Paths that hold credentials or keys. Denied even inside an allowed root.
const SECRET_PATH = /(^|[/\\])(\.env(\.[^/\\]*)?|\.aws|\.ssh|\.gnupg|\.kube|\.docker|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.config[/\\](gh|golive|gcloud)|[^/\\]*\.(pem|key|p12|pfx|jks)|id_(rsa|ed25519|ecdsa|dsa)[^/\\]*|credentials[^/\\]*|[^/\\]*token[^/\\]*|[^/\\]*secret[^/\\]*)([/\\]|$)/i;

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p); // not there yet: judge the lexical path
  }
}

export function pathAllowed(p: string, roots: string[], cwd: string): string | undefined {
  const abs = real(isAbsolute(p) ? p : resolve(cwd, p));
  if (SECRET_PATH.test(abs)) return `path looks like a credential or key: ${p}`;
  const inside = roots.some((r) => {
    const rel = relative(real(r), abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
  });
  return inside ? undefined : `path is outside the allowed folders: ${p}`;
}

// File tools may only touch the given roots. Patterns are checked too, since
// Glob("/Users/**") or Grep(glob: "../../**") would otherwise walk anywhere.
export function pathGuard(roots: string[], cwd: string): HookCallbackMatcher {
  return {
    matcher: 'Read|Grep|Glob',
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        const a = (input.tool_input ?? {}) as Record<string, unknown>;
        const candidates = [a.file_path, a.path, a.pattern, a.glob].filter((v): v is string => typeof v === 'string');
        let reason: string | undefined;
        for (const c of candidates) {
          if (c === a.pattern && input.tool_name === 'Grep') continue; // Grep's pattern is a regex, not a path
          if (c.includes('..')) reason = `".." is not allowed in paths: ${c}`;
          else if (c === a.file_path || c === a.path || isAbsolute(c)) reason = pathAllowed(c, roots, cwd);
          else if (SECRET_PATH.test(c)) reason = `pattern targets credential-like files: ${c}`;
          if (reason) break;
        }
        if (!a.path && input.tool_name !== 'Read') reason ??= pathAllowed(cwd, roots, cwd);
        return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
      },
    ],
  };
}
