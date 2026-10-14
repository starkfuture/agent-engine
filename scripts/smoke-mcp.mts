// End-to-end over MCP stdio with a real model: list agents, run research, read it back.
// usage: node --import tsx scripts/smoke-mcp.mts <user>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const user = process.argv[2] ?? 'smoke';
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', 'mcp-stdio', '--as', user],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY ?? '', NO_PROXY: process.env.NO_PROXY ?? '' } : {}) },
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke', version: '1' });
await client.connect(transport);
const call = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content.map((c) => c.text).join('');
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
console.log((await call('list_repos')).split('\n').join(', '));
const r = await call('run_agent', { agent: 'codebase', repo: 'sre-agent', task: 'Which file defines the Store class, and what SQLite journal mode does it set? One finding.', wait_seconds: 55 });
console.log(r.slice(0, 900));
const id = /run (\S+):/.exec(r)?.[1];
if (id) console.log('\n--- get_run ---\n' + (await call('get_run', { run_id: id })).slice(0, 400));
console.log('\n--- spend ---\n' + (await call('spend')));
await client.close();
