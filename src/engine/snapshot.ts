import { execFile, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, normalize } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Files that hold credentials by name. Exact names, not substrings: a source
// file called token.service.ts is code, a file called .env is a secret.
const SECRET_FILE = /^(\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?|\.npmrc|\.yarnrc\.yml|\.netrc|\.pgpass|\.git-credentials|\.htpasswd|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|ppk|tfstate|tfstate\.backup|tfvars)|credentials(\.json)?|service-account.*\.json|kubeconfig|.*\.kubeconfig)$/i;
const MAX_FILE = 2_000_000;
const MAX_FILES = 50_000;
const REF = /^(?!-)[A-Za-z0-9._/@^~-]{1,200}$/;

export const isSecretFile = (path: string) => SECRET_FILE.test(basename(path));

export interface Snapshot {
  dir: string;
  files: number;
  skipped: number;
  ref: string; // what was asked for (origin/HEAD, HEAD, a branch)
  commit: string; // what was read
  date: string; // commit date, ISO
}

// The ref a repo is read at when none is given: the remote's default branch if
// the clone has one, else what is checked out. Never the working tree.
async function defaultRef(root: string): Promise<string> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', 'origin/HEAD^{commit}']);
    return 'origin/HEAD';
  } catch {
    return 'HEAD';
  }
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

// Read-only agents work on a copy of one commit: its files, minus secret files,
// symlinks and submodules. Uncommitted edits and gitignored files (.env, build
// output) are never copied, so no search pattern can reach them, and the answer
// names the commit it read. Async throughout: a large repo must not stall the
// server (git does the reading; we only write files).
export async function snapshot(root: string, ref?: string): Promise<Snapshot> {
  if (ref !== undefined && !REF.test(ref)) throw new Error(`bad git ref: ${ref}`);
  let commit: string, date: string, want: string;
  try {
    want = ref ?? (await defaultRef(root));
    [commit, date] = (await git(root, ['log', '-1', '--format=%H%x00%cI', `${want}^{commit}`, '--'])).trim().split('\0') as [string, string];
  } catch (e) {
    const msg = (e as { stderr?: string }).stderr ?? (e as Error).message;
    if (/not a git repository|cannot change to/i.test(msg)) throw new Error(`${root} is not a git folder: the codebase agent only reads committed files`);
    throw new Error(`${root}: can't read ref ${ref ?? 'origin/HEAD or HEAD'}: ${msg.trim().slice(0, 200)}`);
  }

  // mode type oid size\tpath, NUL-separated.
  const entries = (await git(root, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit]))
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, oid, size] = line.slice(0, tab).split(/\s+/) as [string, string, string, string];
      return { mode, type, oid, size: Number(size), path: line.slice(tab + 1) };
    });
  if (entries.length > MAX_FILES) throw new Error(`${root} has ${entries.length} files at ${want} (limit ${MAX_FILES}); point --path at a smaller repo`);
  const keep = entries.filter((e) => e.type === 'blob' && e.mode !== '120000' && e.size <= MAX_FILE && !isSecretFile(e.path) && !normalize(e.path).startsWith('..'));

  const dir = mkdtempSync(join(tmpdir(), 'engine-snapshot-'));
  await catFiles(root, keep, dir);
  return { dir, files: keep.length, skipped: entries.length - keep.length, ref: want, commit, date };
}

// One `git cat-file --batch` streams every blob; responses come back in order:
// "<oid> blob <size>\n<bytes>\n".
async function catFiles(root: string, files: Array<{ oid: string; path: string }>, dir: string): Promise<void> {
  if (!files.length) return;
  const child = spawn('git', ['-C', root, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()).length > 2000 && (stderr = stderr.slice(-2000)));
  const exited = new Promise<number | null>((res, rej) => {
    child.on('error', rej);
    child.on('close', res);
  });
  child.stdin.on('error', () => {}); // reported through the exit code
  child.stdin.end(files.map((f) => `${f.oid}\n`).join(''));

  let buf: Buffer = Buffer.alloc(0);
  let i = 0;
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) break;
      const [, type, size] = buf.subarray(0, nl).toString('utf8').split(' ');
      if (type === 'missing' || size === undefined) {
        buf = buf.subarray(nl + 1);
        i++;
        continue;
      }
      const n = Number(size);
      if (buf.length < nl + 1 + n + 1) break; // wait for the whole object
      const f = files[i++]!;
      const out = join(dir, f.path);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, buf.subarray(nl + 1, nl + 1 + n));
      buf = buf.subarray(nl + 1 + n + 1);
    }
  }
  const code = await exited;
  if (code !== 0) throw new Error(`git cat-file failed (${code}): ${stderr.trim().slice(0, 200)}`);
  if (i !== files.length) throw new Error(`git cat-file returned ${i} of ${files.length} files`);
}
