// Counterfactual "AI on" gating over a recording, per patrol: the patrol's own
// code (buildSummary, State, Noise) and the gate of patrolOnce as
// src/detect.ts keeps it (gateOf, simulate), with no buttons and an empty issue
// record. The model run is replaced by an assumption about which pending rows
// a run's reports cover:
//   all   every pending row is covered (fewest runs)
//   none  no row is covered (attempts, given up after ATTEMPTS: most runs)
// No model, no Slack, no writes: one JSON line per patrol on stdout. The
// summed form (runs per day, detection latency) is `replay --expect`.
// Ported from the 11-04 replay lane (research replay/tools/gate-sim.mts). With
// that day's patrol settings (PATROL_CONFIRM_PATROLS=1, PATROL_URGENT_CLIENT_ERRORS=1,
// PATROL_RECOVER_AFTER_MINUTES=15) it gives the original's saved output for
// comparison-1029 field for field, all 96 patrols, cover all and none, but for
// the `truncated` mark main has since put on capped trace rows.
// Usage: SRE_SOURCES_FILE=... node --import tsx scripts/gate-sim.mts <recording dir> <from ISO> <to ISO> <all|none> [step min]
import { loadConfig } from '../src/config.js';
import { ReplayTelemetry } from '../src/clients/telemetry.js';
import { simulate, type Cover } from '../src/detect.js';
import { Noise } from '../src/patrol/noise.js';
import type { FlaggedRow } from '../src/patrol/summary.js';

const [rec, fromS, toS, cover, stepS] = process.argv.slice(2);
if (!rec || !fromS || !toS || (cover !== 'all' && cover !== 'none')) {
  console.error('usage: node --import tsx scripts/gate-sim.mts <recording dir> <from ISO> <to ISO> <all|none> [step min]');
  process.exit(2);
}
const cfg = loadConfig();
const tel = new ReplayTelemetry(rec);
const noise = Noise.load(cfg.noiseFile);
const brief = (r: FlaggedRow) => ({
  key: r.key,
  novelty: r.novelty,
  trend: r.score.trend,
  verdict: r.score.verdict,
  now: r.counts.now,
  h1: r.counts.h1,
  d1: r.counts.d1,
  d7: r.counts.d7,
  expected: Math.round(r.score.expected * 10) / 10,
  z: Math.round(r.score.z * 10) / 10,
  ...(r.truncated ? { truncated: true } : {}),
});
for await (const { summary, gate } of simulate(tel, cfg, noise, new Date(fromS), new Date(toS), Number(stepS ?? cfg.windowMinutes), cover as Cover)) {
  console.log(
    JSON.stringify({
      at: summary.at,
      send: summary.send.length,
      known: summary.known.length,
      waiting: summary.waiting.length,
      recovered: summary.recovered.length,
      down: summary.sources.filter((s) => !s.ok).map((s) => `${s.source}: ${s.error}`),
      deploys: summary.deploys.error ?? `${summary.deploys.deploys.length} deploy(s)`,
      urgent: gate.urgentRows.map((r) => ({ ...brief(r), protected: noise.protected(r) })),
      pending: gate.pending.length,
      owedKnown: gate.owedKnown.length,
      run: gate.run,
      challenger: gate.challenger,
      look: gate.look.map(brief),
      sendRows: summary.send.map(brief),
    }),
  );
}
console.error(`${tel.misses} query(ies) not in the recording`);
