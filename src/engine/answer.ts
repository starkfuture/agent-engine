import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedAgent } from './agent.js';
import { renderFindings, type Findings } from './output.js';
import type { RunResult } from './run.js';
import { redact } from './text.js';

// The human-readable answer of a findings run, with the challenger's blocking
// objections as dissent. Written to answer.md in the run folder.
export function writeAnswer(agent: LoadedAgent, r: RunResult<Findings>): string | undefined {
  const f = r.outputs[0];
  if (!f) return undefined;
  const dissent = (r.challenge?.blocking ?? []).map((o) => `- ${o.claim}\n  - if acted on: ${o.failure_scenario}\n  - check: ${o.settling_check} (${o.evidence.join(', ')})`);
  const verdict = r.challenge ? ` · challenge ${r.challenge.verdict}${r.challenge.note ? ` (${r.challenge.note})` : ''}` : '';
  const md = redact(renderFindings(f, `${agent.spec.name}@${agent.version} · run ${r.runId} · $${r.cost.toFixed(2)}${verdict}`, dissent));
  if (r.dir) writeFileSync(join(r.dir, 'answer.md'), md + '\n');
  return md;
}
