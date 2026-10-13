import type { Report } from '../investigate/report.js';
import { rowLine, type Summary } from '../patrol/summary.js';
import { redact } from '../patrol/text.js';

const SEV = { critical: '🔴', major: '🟠', minor: '🟡', noise: '⚪' } as const;
const clip = (s: string, n = 2900) => (s.length > n ? `${s.slice(0, n - 1)}…` : s); // Slack section text limit is 3000

export interface Card {
  text: string; // notification fallback
  blocks: unknown[];
  markdown: string;
}

export function reportCard(r: Report, patrolAt: string, footer: string): Card {
  const md = [
    `## ${SEV[r.severity]} ${r.title}`,
    `**Status:** ${r.status} · **Since:** ${r.started_at} · **Severity (advisory):** ${r.severity} · **Confidence:** ${r.cause.confidence}`,
    '',
    `**What broke:** ${r.what_broke}`,
    '',
    `**Impact:** ${r.impact}`,
    '',
    `**Likely cause:** ${r.cause.hypothesis}`,
    '',
    `**Suggested fix:** ${r.suggested_fix}`,
    '',
    '**Evidence**',
    ...r.evidence.map((e) => `- ${e.id}: ${e.claim}`),
    ...(r.not_checked.length ? ['', '**Not checked**', ...r.not_checked.map((x) => `- ${x}`)] : []),
    ...(r.noise_rule ? ['', '**Proposed noise rule (needs review)**', '```yaml', JSON.stringify(r.noise_rule, null, 2), '```'] : []),
    '',
    `_Rows: ${r.rows.join(', ')} · patrol ${patrolAt} · ${footer}_`,
  ].join('\n');

  const section = (label: string, body: string) => ({ type: 'section', text: { type: 'mrkdwn', text: clip(`*${label}*\n${body}`) } });
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: clip(`${SEV[r.severity]} ${r.title}`, 150) } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*${r.status}* · since ${r.started_at} · severity ${r.severity} (advisory) · confidence ${r.cause.confidence}` }],
    },
    section('What broke', r.what_broke),
    section('Impact', r.impact),
    section('Likely cause', r.cause.hypothesis),
    section('Suggested fix', r.suggested_fix),
    section('Evidence', r.evidence.map((e) => `• ${e.id}: ${e.claim}`).join('\n')),
    ...(r.not_checked.length ? [section('Not checked', r.not_checked.map((x) => `• ${x}`).join('\n'))] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: clip(`patrol ${patrolAt} · ${footer}`, 300) }] },
  ];
  return { text: redact(`${SEV[r.severity]} ${r.title}`), blocks: JSON.parse(redact(JSON.stringify(blocks))), markdown: redact(md) };
}

// Without the LLM (no credentials, budget cap hit, or the investigator failed),
// the patrol still reports what it found.
export function patrolCard(s: Summary, why: string): Card {
  const lines = s.send.slice(0, 15).map((r) => `• ${rowLine(r)}`);
  const more = s.send.length > 15 ? `\n…and ${s.send.length - 15} more` : '';
  const down = s.sources.filter((x) => !x.ok).map((x) => x.source);
  const body = `${lines.join('\n')}${more}${down.length ? `\n\nBlind spots: ${down.join(', ')}` : ''}`;
  const title = `Patrol ${s.at}: ${s.send.length} new or worse signal(s), not investigated (${why})`;
  return {
    text: title,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: clip(`*${title}*`) } },
      { type: 'section', text: { type: 'mrkdwn', text: clip(redact(body)) } },
    ],
    markdown: redact(`## ${title}\n\n${body}`),
  };
}
