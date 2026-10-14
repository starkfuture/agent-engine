import type { ChallengeResult } from '../engine/challenge.js';
import type { Report } from '../investigate/report.js';
import { rowLine, type Summary } from '../patrol/summary.js';
import { cleanModelText, redact } from '../engine/text.js';

const SEV = { critical: '🔴', major: '🟠', minor: '🟡', noise: '⚪' } as const;
const clip = (s: string, n = 2900) => (s.length > n ? `${s.slice(0, n - 1)}…` : s); // Slack section text limit is 3000

export interface Card {
  text: string; // notification fallback
  blocks: unknown[];
  markdown: string;
}

// What the challenger concluded, in one block. Escalate = a human decides.
function challengeLines(c: ChallengeResult | undefined): string[] {
  if (!c) return [];
  if (c.verdict === 'error') return [`Challenge did not complete (${c.note ?? 'unknown'}); this report is unchallenged.`];
  const head = c.verdict === 'upheld' ? `Challenge: upheld. ${c.overall}` : `⚠️ Challenge: ESCALATE, needs a human decision. ${c.overall}`;
  return [head, ...c.blocking.map((o) => `• Objection: ${o.claim} (if acted on: ${o.failure_scenario}; check: ${o.settling_check}; ${o.evidence.join(', ')})`), ...(c.notes.length ? [`${c.notes.length} non-blocking note(s) in the run folder.`] : [])];
}

// Every model-written string is redacted and cleaned on its own before it goes
// into the card. (Redacting the serialised blocks broke JSON on `KEY="…"`.)
const m = (s: string) => cleanModelText(redact(s));

export function reportCard(raw: Report, patrolAt: string, footer: string, challenge?: ChallengeResult): Card {
  const r: Report = {
    ...raw,
    title: m(raw.title),
    started_at: m(raw.started_at),
    what_broke: m(raw.what_broke),
    impact: m(raw.impact),
    cause: { ...raw.cause, hypothesis: m(raw.cause.hypothesis) },
    evidence: raw.evidence.map((e) => ({ ...e, quote: m(e.quote), claim: m(e.claim) })),
    suggested_fix: m(raw.suggested_fix),
    not_checked: raw.not_checked.map(m),
    rows: raw.rows.map(m),
  };
  const ch = challengeLines(challenge).map(m);
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
    ...r.evidence.map((e) => `- ${e.id}: ${e.claim} (“${e.quote}”)`),
    ...(r.not_checked.length ? ['', '**Not checked**', ...r.not_checked.map((x) => `- ${x}`)] : []),
    ...(r.noise_rule ? ['', '**Proposed noise rule (needs review)**', '```yaml', m(JSON.stringify(r.noise_rule, null, 2)), '```'] : []),
    ...(ch.length ? ['', '**Challenge**', ...ch] : []),
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
    ...(ch.length ? [section('Challenge', ch.join('\n'))] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: clip(`patrol ${patrolAt} · ${footer}`, 300) }] },
  ];
  return { text: `${SEV[r.severity]} ${r.title}`, blocks, markdown: md };
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
