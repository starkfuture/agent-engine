import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { LoadedAgent } from './agent.js';
import { FindingsShape, renderFindings, type Findings } from './output.js';
import type { RunResult } from './run.js';
import { redact, stripImages } from './text.js';
import { Report } from '../investigate/report.js';
import { reportCard } from '../output/card.js';
import type { RunRow } from './store.js';
import { z } from 'zod';

// Older scheduled monitor runs contain output.json, but never wrote answer.md.
// Read the validated reports in place: retention and get_run's visibility rules
// still apply. A report being stored does not prove that Slack delivered it.
export function storedMonitorAnswer(dir: string, row: RunRow): string | undefined {
  if (!existsSync(join(dir, 'output.json'))) return undefined;
  let outputs: unknown;
  try {
    outputs = JSON.parse(readFileSync(join(dir, 'output.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const reports = z.array(Report).safeParse(outputs);
  const findings = z.array(z.object(FindingsShape)).safeParse(outputs);
  if ((!reports.success || !reports.data.length) && (!findings.success || !findings.data.length)) return undefined;
  const objection = z.object({
    claim: z.string(),
    failure_scenario: z.string(),
    settling_check: z.string(),
    evidence: z.array(z.string()),
    blocking: z.boolean(),
  });
  const schema = z.object({
    verdict: z.enum(['upheld', 'escalate', 'error']),
    overall: z.string(),
    blocking: z.array(objection),
    notes: z.array(objection),
    cost: z.number(),
    turns: z.number(),
    toolCalls: z.number(),
    note: z.string().optional(),
  });
  let challenge: z.infer<typeof schema> | undefined;
  let uncertainty = '';
  try {
    if (existsSync(join(dir, 'challenge.json'))) challenge = schema.parse(JSON.parse(readFileSync(join(dir, 'challenge.json'), 'utf8')));
  } catch {
    uncertainty = '\nChallenge record could not be read; do not treat this report as upheld.\n';
  }
  const footer = `run ${row.id} · delivery status unknown`;
  const dissent = challenge?.blocking.map(o=>`- ${o.claim}\n  - if acted on: ${o.failure_scenario}\n  - check: ${o.settling_check} (${o.evidence.join(', ')})`) ?? [];
  const md = reports.success ? reports.data.map(r=>reportCard(r,row.started_at,footer,challenge).markdown).join('\n\n') : findings.success ? findings.data.map(f=>renderFindings(f,`${footer} · challenge ${challenge?.verdict??'not recorded'}`,dissent)).join('\n\n') : '';
  return stripImages(redact(md + uncertainty));
}

// The human-readable answer of a findings run, with the challenger's blocking
// objections as dissent. Written to answer.md in the run folder. Images are
// removed (they load by themselves); links stay, since research answers cite
// sources, and a requester asked for this answer.
export function writeAnswer(agent: LoadedAgent, r: RunResult<Findings>): string | undefined {
  const f = r.outputs[0];
  if (!f) return undefined;
  const dissent = (r.challenge?.blocking ?? []).map((o) => `- ${o.claim}\n  - if acted on: ${o.failure_scenario}\n  - check: ${o.settling_check} (${o.evidence.join(', ')})`);
  const verdict = r.challenge ? ` · challenge ${r.challenge.verdict}${r.challenge.note ? ` (${r.challenge.note})` : ''}` : '';
  const read = (r.sources ?? []).map((s) => ` · read ${basename(s.path)} at ${s.ref} ${s.commit.slice(0, 10)} (${s.date.slice(0, 10)})`).join('');
  const md = stripImages(redact(renderFindings(f, `${agent.spec.name}@${agent.version} · run ${r.runId} · $${r.cost.toFixed(2)}${verdict}${read}`, dissent)));
  if (r.dir) writeFileSync(join(r.dir, 'answer.md'), md + '\n');
  return md;
}
