import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// Files that hold credentials by name. Exact names, not substrings: a source
// file called token.service.ts is code, a file called .env is a secret.
const SECRET_FILE = /^(\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?|\.npmrc|\.yarnrc\.yml|\.netrc|\.pgpass|\.git-credentials|\.htpasswd|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|ppk|tfstate|tfstate\.backup|tfvars)|credentials(\.json)?|service-account.*\.json|kubeconfig|.*\.kubeconfig)$/i;
const MAX_FILE = 2_000_000;
const MAX_FILES = 50_000;

export const isSecretFile = (path: string) => SECRET_FILE.test(basename(path));

// Read-only agents work on a copy: the git-tracked files of the folder, minus
// secret files and symlinks. Gitignored files (.env, build output) are never
// copied, so no search pattern can reach them. The guarantee comes from what is
// on disk, not from checking each tool call.
export function snapshot(root: string): { dir: string; files: number; skipped: number } {
  let list: string[];
  try {
    list = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\0')
      .filter(Boolean);
  } catch {
    throw new Error(`${root} is not a git folder: the codebase agent only reads git-tracked files`);
  }
  if (list.length > MAX_FILES) throw new Error(`${root} has ${list.length} tracked files (limit ${MAX_FILES}); point --path at a subfolder`);
  const dir = mkdtempSync(join(tmpdir(), 'engine-snapshot-'));
  let files = 0;
  let skipped = 0;
  for (const rel of list) {
    const src = join(root, rel);
    let st;
    try {
      st = lstatSync(src);
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (!st.isFile() || st.size > MAX_FILE || isSecretFile(rel)) {
      skipped++;
      continue;
    }
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    copyFileSync(src, join(dir, rel));
    files++;
  }
  return { dir, files, skipped };
}
