import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadAgent } from '../src/engine/agent.js';
import { findingsOutput } from '../src/engine/output.js';
import { sweep } from '../src/engine/retention.js';
import { runAgent, type Engine } from '../src/engine/run.js';
import { Store } from '../src/engine/store.js';
import { fakeSession, ok } from './fake-session.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test('retention deletes run folders and cards older than N days, keeps newer ones and the ledger', () => {
  const runsDir = tmp('runs-');
  const outDir = tmp('out-');
  const now = new Date('2026-10-16T12:00:00Z');
  for (const id of ['20260901T100000Z-codebase-aaaaaa', '20261010T100000Z-codebase-bbbbbb']) mkdirSync(join(runsDir, 'codebase', id), { recursive: true });
  writeFileSync(join(runsDir, 'engine.db'), 'ledger');
  mkdirSync(join(outDir, 'cards'));
  writeFileSync(join(outDir, 'cards', 'old.md'), 'x');
  writeFileSync(join(outDir, 'cards', 'new.md'), 'x');
  utimesSync(join(outDir, 'cards', 'old.md'), new Date('2026-09-01'), new Date('2026-09-01'));
  assert.deepEqual(sweep({ runsDir, outDir, days: 30, now }), { runs: 1, cards: 1, patrols: 0 });
  assert.ok(!existsSync(join(runsDir, 'codebase', '20260901T100000Z-codebase-aaaaaa')));
  assert.ok(existsSync(join(runsDir, 'codebase', '20261010T100000Z-codebase-bbbbbb')));
  assert.ok(existsSync(join(runsDir, 'engine.db')), 'the ledger stays');
  assert.ok(existsSync(join(outDir, 'cards', 'new.md')));
});

test('retention also deletes patrol files older than N days and keeps recent ones', () => {
  const outDir = tmp('out-');
  const now = new Date('2026-10-16T12:00:00Z');
  mkdirSync(join(outDir, 'patrols'));
  for (const f of ['old.md', 'old.json', 'new.md', 'new.json']) writeFileSync(join(outDir, 'patrols', f), 'x');
  for (const f of ['old.md', 'old.json']) utimesSync(join(outDir, 'patrols', f), new Date('2026-09-01'), new Date('2026-09-01'));
  const r = sweep({ runsDir: tmp('runs-'), outDir, days: 30, now });
  assert.equal(r.patrols, 2);
  assert.ok(!existsSync(join(outDir, 'patrols', 'old.md')) && !existsSync(join(outDir, 'patrols', 'old.json')));
  assert.ok(existsSync(join(outDir, 'patrols', 'new.md')) && existsSync(join(outDir, 'patrols', 'new.json')));
});

test('new runs are refused when the runs volume is nearly full', async () => {
  const dir = join(tmp('agents-'), 'demo');
  mkdirSync(dir);
  writeFileSync(join(dir, 'agent.yaml'), 'name: demo\nbuiltin_tools: [WebFetch]');
  writeFileSync(join(dir, 'CLAUDE.md'), '# Demo');
  const runsDir = tmp('runs-');
  const e: Engine = { store: new Store(join(runsDir, 'engine.db')), runsDir, stopFile: join(runsDir, 'STOP'), session: fakeSession(async function* () { yield ok(); }), dailyCapUsd: 20, llmAvailable: true, minFreeBytes: Number.MAX_SAFE_INTEGER };
  const r = await runAgent(e, { agent: loadAgent(dir), trigger: 't', task: 'q', output: findingsOutput });
  assert.equal(r.status, 'skipped');
  assert.match(r.note!, /nearly full/);
});
