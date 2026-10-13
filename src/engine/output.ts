import { z } from 'zod';
import type { OutputSpec } from './run.js';

// The generic answer shape for task agents (research, codebase). Agents with
// richer needs (the monitor) bring their own OutputSpec.
export const FindingsShape = {
  title: z.string().min(5).max(160),
  summary: z.string().min(10).max(2000).describe('The answer, bottom line first.'),
  findings: z
    .array(
      z.object({
        claim: z.string().min(5).max(600),
        status: z.enum(['confirmed', 'ruled_out', 'inconclusive']),
        evidence: z.array(z.string()).max(10).describe('evidence_ids of the tool results that show it'),
      }),
    )
    .max(30),
  next_steps: z.array(z.string().max(400)).max(10),
  not_checked: z.array(z.string().max(300)).max(10).describe('What you could not or did not verify.'),
  lessons: z.array(z.string().max(300)).max(5).default([]).describe('Optional: reusable lessons for future runs of this agent. A human reviews them.'),
};
const Findings = z.object(FindingsShape);
export type Findings = z.infer<typeof Findings>;

export const findingsOutput: OutputSpec<Findings> = {
  tool: 'submit_findings',
  description: 'Submit your answer once, when done. Every confirmed or ruled-out finding must cite evidence ids. Invalid submissions come back with the reason; fix and resubmit.',
  shape: FindingsShape,
  evidenceOf: (f) => f.findings.flatMap((x) => x.evidence),
  check: (f) => f.findings.filter((x) => x.status !== 'inconclusive' && !x.evidence.length).map((x) => `finding "${x.claim.slice(0, 60)}" is ${x.status} but cites no evidence`),
  lessonsOf: (f) => f.lessons,
  max: 1,
};

export function renderFindings(f: Findings, footer: string): string {
  return [
    `# ${f.title}`,
    '',
    f.summary,
    '',
    '## Findings',
    ...f.findings.map((x) => `- **${x.status}**: ${x.claim}${x.evidence.length ? ` (${x.evidence.join(', ')})` : ''}`),
    ...(f.next_steps.length ? ['', '## Next steps', ...f.next_steps.map((s) => `- ${s}`)] : []),
    ...(f.not_checked.length ? ['', '## Not checked', ...f.not_checked.map((s) => `- ${s}`)] : []),
    '',
    `_${footer}_`,
  ].join('\n');
}
