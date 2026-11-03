import { z } from 'zod';

// The monitor's only way to answer. Bedrock has no forced tool choice or
// structured output for these models, so the schema is enforced in code, and
// evidence must point at tool results that actually happened in this run.
export const ReportShape = {
  title: z.string().min(5).max(140).describe('One line: what is wrong, where. No severity words.'),
  severity: z
    .enum(['critical', 'major', 'minor', 'noise'])
    .describe('Decides what is posted: critical and major go to the team channel; minor and noise are only recorded. Protected journeys and big spikes are posted by code regardless.'),
  status: z.enum(['active', 'recovering', 'resolved', 'unclear']),
  started_at: z.string().describe('ISO time of the first bad event you found, or "unknown".'),
  what_broke: z.string().min(10).max(700).describe('Observable symptom: endpoint/flow, status codes, error text (redacted).'),
  impact: z.string().min(5).max(700).describe('Who is affected and how many, from evidence. Say "unknown" if you could not measure it.'),
  cause: z.object({
    hypothesis: z.string().min(5).max(900),
    confidence: z.enum(['high', 'medium', 'low']),
  }),
  evidence: z
    .array(z.object({ id: z.string().regex(/^E-[0-9a-f]{4}-\d+$/), quote: z.string().min(3).max(300).describe('Exact text copied from that tool result'), claim: z.string().min(5).max(300) }))
    .min(1)
    .max(12)
    .describe('Each claim cites the evidence_id printed at the top of a tool result (like E-1a2b-3) and an exact quote copied from that result.'),
  suggested_fix: z.string().min(5).max(700).describe('A recommendation for a human. You cannot act.'),
  not_checked: z.array(z.string().max(200)).max(10).describe('What you could not or did not verify.'),
  rows: z.array(z.string()).min(1).describe('The patrol row keys this report explains, copied exactly.'),
  issue: z
    .string()
    .regex(/^(new|I-[0-9a-f]{4,6})$/, 'an issue id from the list (like I-7f3a) or "new"')
    .describe('The id of the listed issue with the same cause (even if its rows differ), or "new". Linking keeps one Slack thread per cause.'),
  noise_rule: z
    .object({
      section: z.string(),
      service: z.string(),
      route: z.string().optional(),
      status: z.string().optional(),
      reason: z.string().min(10),
    })
    .optional()
    .describe('Only with severity "noise": a proposed noise.yaml entry for a human to review.'),
};
export const Report = z.object(ReportShape);
export type Report = z.infer<typeof Report>;

// Beyond the schema. Evidence ids are checked by the engine against the run's
// registry. `issues`: the ids the investigator was shown; nothing else links.
export function checkReport(r: Report, knownRows: Set<string>, issues: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  for (const k of r.rows) if (!knownRows.has(k)) problems.push(`row key not in this patrol: ${k}`);
  if (r.issue !== 'new' && !issues.has(r.issue)) problems.push(`issue ${r.issue} is not in the issue list; use an id from the list, or "new"`);
  if (r.noise_rule && r.severity !== 'noise') problems.push('noise_rule is only allowed with severity "noise"');
  if (r.severity === 'critical' && /^unknown$/i.test(r.impact.trim())) problems.push('critical needs measured impact; use major if impact is unknown');
  return problems;
}
