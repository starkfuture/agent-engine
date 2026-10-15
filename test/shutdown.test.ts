import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadAgent } from '../src/engine/agent.js';
import { findingsOutput } from '../src/engine/output.js';
import { runAgent, stopAllRuns, type Engine } from '../src/engine/run.js';
import { Store } from '../src/engine/store.js';
import { fakeSession, ok } from './fake-session.js';

// Its own file: stopAllRuns closes the engine for the rest of the process.
test('shutdown stops and settles running runs, then refuses new ones', async () => {
  const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
  const dir = join(tmp('agents-'), 'demo');
  mkdirSync(dir);
  writeFileSync(join(dir, 'agent.yaml'), 'name: demo\nbuiltin_tools: [WebFetch]\nlimits: { deadline_min: 5 }');
  writeFileSync(join(dir, 'CLAUDE.md'), '# Demo');
  const runsDir = tmp('runs-');
  const hang = async function* (sim: import('./fake-session.js').Sim) {
    await sim.sleep(60_000);
    yield ok();
  };
  const e: Engine = { store: new Store(join(runsDir, 'engine.db')), runsDir, stopFile: join(runsDir, 'STOP'), session: fakeSession(hang, hang), dailyCapUsd: 20, llmAvailable: true };
  let admitted!: (id: string) => void;
  const started = new Promise<string>((res) => (admitted = res));
  const run = runAgent(e, { agent: loadAgent(dir), trigger: 't', task: 'q', output: findingsOutput, onAdmitted: admitted });
  const id = await started;
  assert.equal(e.store.get(id)?.status, 'running');

  assert.equal(await stopAllRuns('SIGTERM: engine shutting down', 5_000), 1);
  assert.equal(e.store.get(id)?.status, 'stopped', 'settled before stopAllRuns returns');
  assert.equal((await run).status, 'stopped');
  const next = await runAgent(e, { agent: loadAgent(dir), trigger: 't', task: 'q', output: findingsOutput });
  assert.equal(next.status, 'skipped');
  assert.match(next.note!, /shutting down/);
});
