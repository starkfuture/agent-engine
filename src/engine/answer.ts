import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { Report } from '../investigate/report.js';
import { reportCard } from '../output/card.js';
import type { LoadedAgent } from './agent.js';
import { finished, itemDissent, verdictOn, type ChallengeResult } from './challenge.js';
import { renderFindings, type Findings } from './output.js';
import type { RunResult } from './run.js';
import type { RunRow } from './store.js';
import { redact, stripImages } from './text.js';

// The human-readable answer of a findings run, with the challenger's blocking
// objections and its "no" or "partly" on the answer as dissent. Written to
// answer.md in the run folder. Images are
// removed (they load by themselves); links stay, since research answers cite
// sources, and a requester asked for this answer.
export function writeAnswer(agent: LoadedAgent, r: RunResult<Findings>): string | undefined {
  const f = r.outputs[0];
  if (!f) return undefined;
  const dissent = [...(r.challenge?.blocking ?? []).map((o) => `- ${o.claim}\n  - if acted on: ${o.failure_scenario}\n  - check: ${o.settling_check} (${o.evidence.join(', ')})`), ...itemDissent(r.challenge?.items)];
  const verdict = r.challenge ? ` · challenge ${r.challenge.verdict}${r.challenge.note ? ` (${r.challenge.note})` : ''}` : '';
  const read = (r.sources ?? []).map((s) => ` · read ${basename(s.path)} at ${s.ref} ${s.commit.slice(0, 10)} (${s.date.slice(0, 10)})`).join('');
  const c = r.challenge;
  const head = c && !finished(c) ? '⚠️ Challenge did not finish: not verified. Its objections so far' : c?.verdict === 'upheld' ? 'Challenge: upheld, with objections' : undefined;
  const md = stripImages(redact(renderFindings(f, `${agent.spec.name}@${agent.version} · run ${r.runId} · $${r.cost.toFixed(2)}${verdict}${read}`, dissent, head)));
  if (r.dir) writeFileSync(join(r.dir, 'answer.md'), md + '\n');
  return md;
}

// A monitor run's reports, from its output.json; undefined for any other run.
// Reports from before the issue record have no `issue`.
const StoredReports = z.array(Report.partial({ issue: true })).min(1);
export type StoredReport = z.infer<typeof StoredReports>[number];

export function monitorReports(dir: string): StoredReport[] | undefined {
  try {
    return StoredReports.parse(JSON.parse(readFileSync(join(dir, 'output.json'), 'utf8')));
  } catch {
    return undefined;
  }
}

const Objection = z.object({ claim: z.string(), failure_scenario: z.string(), settling_check: z.string(), evidence: z.array(z.string()), blocking: z.boolean() });
const StoredChallenge = z.object({
  verdict: z.enum(['upheld', 'escalate', 'error']),
  overall: z.string(),
  blocking: z.array(Objection),
  notes: z.array(Objection),
  // Per report; challenges from before per-report verdicts have none.
  items: z.array(z.object({ item: z.number(), holds: z.enum(['yes', 'partly', 'no']), reason: z.string(), evidence: z.array(z.string()).default([]), downgraded: z.string().optional() })).default([]),
  cost: z.number(),
  turns: z.number(),
  toolCalls: z.number(),
  note: z.string().optional(),
});

// A run's challenge.json; undefined when there is none or it can't be read.
export function storedChallenge(dir: string): ChallengeResult | undefined {
  try {
    return StoredChallenge.parse(JSON.parse(readFileSync(join(dir, 'challenge.json'), 'utf8')));
  } catch {
    return undefined;
  }
}

// get_run's answer for a monitor run from before answer.md was written: its
// reports, rendered as their cards were. A challenge.json that can't be read
// leaves the cards unchallenged; get_run says so separately.
export function storedMonitorAnswer(dir: string, row: RunRow, reports: StoredReport[]): string {
  const challenge = storedChallenge(dir);
  const cards = reports.flatMap((r, i) => [`### Report ${i + 1}`, '', reportCard({ ...r, issue: r.issue ?? 'new' }, row.started_at, `run ${row.id}`, challenge, [], undefined, undefined, verdictOn(challenge, i + 1)).markdown, '']);
  return stripImages(redact([`# Monitor reports · run started ${row.started_at}`, '', ...cards].join('\n')));
}
