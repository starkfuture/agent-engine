// Runs the real investigator (real model, fake telemetry) on the synthetic
// 29 Sep incident. Checks the LLM path end to end without VPN or Grafana:
//   ANTHROPIC_API_KEY=... node --import tsx scripts/smoke-investigator.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { CardSink } from '../src/output/sink.js';
import { Noise } from '../src/patrol/noise.js';
import { State } from '../src/patrol/state.js';
import { patrolOnce } from '../src/runner.js';
import { FakeTelemetry, world } from '../test/fake.js';

loadDotEnv();
const cfg = { ...loadConfig(), outDir: mkdtempSync(join(tmpdir(), 'sre-smoke-')) };
if (!cfg.llm.available) {
  console.error('No LLM credentials: set ANTHROPIC_API_KEY, or CLAUDE_CODE_USE_BEDROCK=1 with AWS credentials.');
  process.exit(2);
}
const r = await patrolOnce(new FakeTelemetry(world), cfg, new Noise({}), State.memory(), new CardSink(cfg.outDir), new Date('2026-09-29T12:15:00Z'), {
  llm: true,
  post: false,
  log: (s) => console.error(s),
});
console.log(JSON.stringify({ outcome: r.investigation?.outcome, note: r.investigation?.note, reports: r.investigation?.reports, cards: r.cards }, null, 2));
