// Runs the real monitor agent (real model, fake telemetry) on the synthetic
// 29 Sep incident. Checks the LLM path end to end without VPN or Grafana:
//   ANTHROPIC_API_KEY=... npm run smoke:llm
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { loadAgent } from '../src/engine/agent.js';
import { Store } from '../src/engine/store.js';
import { sdkSession } from '../src/engine/session.js';
import { CardSink } from '../src/output/sink.js';
import { Noise } from '../src/patrol/noise.js';
import { State } from '../src/patrol/state.js';
import { patrolOnce } from '../src/runner.js';
import { FakeTelemetry, world } from '../test/fake.js';

loadDotEnv();
const base = loadConfig();
const tmp = mkdtempSync(join(tmpdir(), 'engine-smoke-'));
const cfg = { ...base, outDir: join(tmp, 'out'), runsDir: join(tmp, 'runs') };
if (!cfg.llm.available) {
  console.error('No LLM credentials: set ANTHROPIC_API_KEY, or CLAUDE_CODE_USE_BEDROCK=1 with AWS credentials.');
  process.exit(2);
}
const engine = { store: new Store(join(cfg.runsDir, 'engine.db')), runsDir: cfg.runsDir, stopFile: join(cfg.runsDir, 'STOP'), session: sdkSession, dailyCapUsd: 5, llmAvailable: true };
// The signup/reset rows are protected journeys, so the challenger runs too.
const noise = Noise.load(cfg.noiseFile);
const r = await patrolOnce(new FakeTelemetry(world), cfg, noise, State.memory(), new CardSink(cfg.outDir), new Date('2026-09-29T12:15:00Z'), { llm: true, post: false, log: (s) => console.error(s) }, { engine, agent: loadAgent(join(cfg.agentsDir, 'monitor')) });
const inv = r.investigation;
console.log(JSON.stringify({ status: inv?.status, note: inv?.note, cost: inv?.cost, reports: inv?.outputs, challenge: inv?.challenge, cards: r.cards, runDir: inv?.dir }, null, 2));
