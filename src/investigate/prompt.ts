import type { Issue } from '../patrol/issues.js';
import { fence, redact } from '../engine/text.js';

// The monitor's system prompt lives in agents/monitor/CLAUDE.md. This is the
// per-run task; the patrol summary goes alongside it as fenced data.
export function monitorTask(rowKeys: string[], issues?: { issues: Issue[]; more: number }): string {
  return [
    'Explain the rows this patrol flagged. The patrol summary below was computed by code (values are counts in the window).',
    '',
    'Row keys to cover (copy exactly into reports):',
    ...rowKeys.map((k) => `- ${k}`),
    ...(issues ? ['', ...issueList(issues.issues, issues.more)] : []),
  ].join('\n');
}

const ROWS_SHOWN = 12;
const minute = (iso: string) => `${iso.slice(0, 16)}Z`;

// Issues already reported, as data: titles and causes were written by an
// earlier run from production text, so they are fenced like the summary.
export function issueList(issues: Issue[], more = 0): string[] {
  if (!issues.length) return ['Issues already reported: none open or resolved in the last 24 h, so every report is "issue": "new".'];
  const body = issues.flatMap((i) => [
    `- ${i.id} · ${i.status === 'open' ? 'open' : `RESOLVED at ${minute(i.resolved_at ?? '')}`} · ${i.severity} · ${i.title}`,
    `  first seen ${minute(i.opened_at)} · last report ${minute(i.last_at)}`,
    `  rows: ${i.rows.slice(0, ROWS_SHOWN).join(', ')}${i.rows.length > ROWS_SHOWN ? `, +${i.rows.length - ROWS_SHOWN} more` : ''}`,
    ...(i.hypothesis ? [`  latest cause: ${i.hypothesis}`] : []),
  ]);
  return [
    'Issues already reported (open, or resolved in the last 24 h). Set "issue" on each report: the id when it has the same cause as one of these, even if its rows differ; "new" otherwise.',
    fence('issues', redact([...body, ...(more ? [`(${more} older issue(s) not shown)`] : [])].join('\n'))),
  ];
}
