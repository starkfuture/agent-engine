// End-to-end against a running `serve`: real HTTP, real tokens, real models.
// usage: node --import tsx scripts/e2e-mcp.mts <url> <dir with dev-a.token, dev-b.token, ops-admin.token>
// Spends roughly $1-3. Prints PASS/FAIL per check.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url = 'http://127.0.0.1:8787/mcp', dir = '.'] = process.argv.slice(2);
const token = (u: string) => readFileSync(join(dir, `${u}.token`), 'utf8').trim();
let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `\n      ${detail.slice(0, 400).replace(/\n/g, '\n      ')}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function as(user: string) {
  const client = new Client({ name: `e2e-${user}`, version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token(user)}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content.map((c) => c.text).join(''), isError: Boolean(r.isError) };
  };
  return { client, call };
}
const idOf = (t: string) => /run (\d{8}T\d{6}Z-[a-z-]+-[0-9a-f]{6})/.exec(t)?.[1];
async function waitDone(call: Awaited<ReturnType<typeof as>>['call'], id: string, maxMs = 600_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call('get_run', { run_id: id });
    if (!/ · running/.test(r.text.split('\n')[0] ?? '')) return r.text;
    if (Date.now() - t0 > maxMs) return r.text;
    await sleep(5000);
  }
}

// --- A. auth and basics
const raw = (headers: Record<string, string>) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
check('no token → 401', (await raw({})).status === 401);
check('wrong token → 401', (await raw({ authorization: 'Bearer eng_' + 'x'.repeat(43) })).status === 401);
const a = await as('dev-a');
const b = await as('dev-b');
const admin = await as('ops-admin');
const memberTools = (await a.client.listTools()).tools.map((t) => t.name);
const adminTools = (await admin.client.listTools()).tools.map((t) => t.name);
check('member has 9 tools, no admin tools', memberTools.length === 9 && !memberTools.includes('stop_all'), memberTools.join(','));
check('admin has 12 tools', adminTools.length === 12, adminTools.join(','));
check('list_repos', /backend-nest/.test((await a.call('list_repos')).text));
check('monitor not runnable', /runs on its schedule/.test((await a.call('run_agent', { agent: 'monitor', task: 'Patrol right now please.' })).text));
check('repo outside allowlist refused', /needs repo/.test((await a.call('run_agent', { agent: 'codebase', task: 'Read /etc/passwd please.', repo: '/etc' })).text));

// --- B. research, waited
console.log('\n[B] research run (real WebSearch)…');
const r1 = await a.call('run_agent', { agent: 'research', task: 'What is the current stable major version of Node.js LTS, and when does its active support end? Cite the official Node.js release schedule.', wait_seconds: 55 });
let r1id = idOf(r1.text);
let r1text = r1.text;
if (r1id && /: running/.test(r1.text)) r1text = await waitDone(a.call, r1id);
check('research run ok with confirmed finding', /· ok|: ok/.test(r1text) && /\*\*confirmed\*\*/.test(r1text), r1text);
const ev = /(E-[0-9a-f]{4}-\d+)/.exec(r1text)?.[1];
if (r1id && ev) check('get_evidence returns the tool result', (await a.call('get_evidence', { run_id: r1id, evidence_id: ev })).text.length > 50);
check('get_run shows requester', r1id ? /asked by dev-a/.test((await b.call('get_run', { run_id: r1id })).text) : false);

// --- C. two developers at once on a real repo, one with the challenger
console.log('\n[C] two codebase runs on backend-nest at once (one challenged)…');
const c1 = await a.call('run_agent', { agent: 'codebase', repo: 'backend-nest', challenge: true, task: 'Where is the HTTP request timeout for outbound calls configured in backend-nest, and what is the default value? Cite file and line.' });
const c2 = await b.call('run_agent', { agent: 'codebase', repo: 'backend-nest', task: 'Which module registers the global exception filter in backend-nest? Cite file and line.' });
const c1id = idOf(c1.text);
const c2id = idOf(c2.text);
check('both started in the background', /running/.test(c1.text) && /running/.test(c2.text), c1.text + '\n' + c2.text);

// --- D. cancel + limits while C runs
console.log('\n[D] cancel, per-person limit, kill switch…');
const d1 = await b.call('run_agent', { agent: 'research', task: 'A question that will be cancelled right away, please.' });
const d1id = idOf(d1.text);
check('dev-b second run admitted', /running/.test(d1.text), d1.text);
const d2 = await b.call('run_agent', { agent: 'research', task: 'A third concurrent question from the same person.' });
check('dev-b third concurrent run refused (2 at once)', /already have 2/.test(d2.text), d2.text);
if (d1id) {
  check('dev-a cannot cancel dev-b run', /only cancel your own/.test((await a.call('cancel_run', { run_id: d1id })).text));
  const cancelled = await b.call('cancel_run', { run_id: d1id });
  check('owner cancels → stopped', /stopped/.test(cancelled.text), cancelled.text);
}
await admin.call('stop_all', { reason: 'e2e kill switch test' });
const s1 = await a.call('run_agent', { agent: 'research', task: 'This should be skipped by the kill switch.' });
check('STOP → new runs skipped', /skipped[\s\S]*stop file/.test(s1.text), s1.text);
check('spend shows STOP', /STOP is set/.test((await a.call('spend')).text));
await admin.call('resume');
check('resume clears STOP', !/STOP is set/.test((await a.call('spend')).text));

// --- C results
if (c1id) {
  const t = await waitDone(a.call, c1id);
  check('challenged codebase run finished ok', /· ok/.test(t.split('\n')[0] ?? ''), t);
  check('challenge verdict recorded', /## Challenge: (upheld|escalate)/.test(t), t.slice(-600));
  console.log('\n--- c1 answer ---\n' + t.slice(0, 1500));
}
if (c2id) {
  const t = await waitDone(b.call, c2id);
  check('second codebase run finished ok', /· ok/.test(t.split('\n')[0] ?? ''), t);
  console.log('\n--- c2 answer ---\n' + t.slice(0, 1000));
}

// --- E. bookkeeping
const mine = (await a.call('list_runs', { mine: true })).text;
check('list_runs mine shows only dev-a', mine.split('\n').every((l) => / dev-a /.test(l) || l === 'no runs'), mine);
console.log('\n--- spend (admin) ---\n' + (await admin.call('spend')).text);
for (const c of [a, b, admin]) await c.client.close();
console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASSED'}`);
process.exitCode = failed ? 1 : 0;
