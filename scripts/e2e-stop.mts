// Stop paths against a running `serve` with real models: cancel mid-run, kill switch mid-run.
// usage: node --import tsx scripts/e2e-stop.mts <url> <token dir>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url = 'http://127.0.0.1:8787/mcp', dir = '.'] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function as(user: string) {
  const client = new Client({ name: `e2e-${user}`, version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${readFileSync(join(dir, `${user}.token`), 'utf8').trim()}` } } }));
  return async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as { content: Array<{ text: string }> }).content.map((c) => c.text).join('');
}
const idOf = (t: string) => /run (\d{8}T\d{6}Z-[a-z-]+-[0-9a-f]{6})/.exec(t)?.[1]!;
const head = async (call: Awaited<ReturnType<typeof as>>, id: string) => (await call('get_run', { run_id: id })).split('\n').slice(0, 3).join(' | ');

const a = await as('dev-a');
const b = await as('dev-b');
const admin = await as('ops-admin');

const r1 = idOf(await a('run_agent', { agent: 'research', task: 'Compare the release cadence and LTS policies of Node.js, Deno and Bun in detail, with official sources for each.' }));
await sleep(25_000);
console.log('before cancel:', await head(a, r1));
let t0 = Date.now();
console.log('cancel →', (await a('cancel_run', { run_id: r1 })).replace(/\n/g, ' | '), `(${Date.now() - t0} ms)`);
console.log('after cancel:', await head(a, r1));

const r2 = idOf(await b('run_agent', { agent: 'codebase', repo: 'backend-nest', task: 'Map every place backend-nest reads environment variables for database connection pools and list each pool size default with file and line.' }));
await sleep(20_000);
t0 = Date.now();
console.log('\nstop_all →', await admin('stop_all', { reason: 'e2e kill switch mid-run' }));
for (let i = 0; i < 30; i++) {
  const h = await head(b, r2);
  if (!/· running/.test(h)) {
    console.log(`stopped after ${Date.now() - t0} ms:`, h);
    break;
  }
  await sleep(500);
}
console.log('resume →', await admin('resume'));
console.log('\n' + (await admin('spend')));
