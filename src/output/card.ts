import type { ChallengeResult } from '../engine/challenge.js';
import type { Report } from '../investigate/report.js';
import { DEFAULT_FLOOR, digest, type DigestOptions, type Line } from '../patrol/digest.js';
import type { Owners } from '../patrol/owners.js';
import type { FlaggedRow, Summary } from '../patrol/summary.js';
import { cleanModelText, redact, slackEscape as esc } from '../engine/text.js';

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

// `cc`: owner mentions from the owners file (validated there), the only text
// that reaches Slack unescaped.
export function reportCard(raw: Report, patrolAt: string, footer: string, challenge?: ChallengeResult, cc: string[] = []): Card {
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
    `**Status:** ${r.status} · **Since:** ${r.started_at} · **Severity:** ${r.severity} · **Confidence:** ${r.cause.confidence}${cc.length ? ` · cc ${cc.join(' ')}` : ''}`,
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

  // mrkdwn: model and production text is escaped so <!channel>, <@U…> or <url|label> can't act.
  const section = (label: string, body: string) => ({ type: 'section', text: { type: 'mrkdwn', text: clip(`*${label}*\n${esc(body)}`) } });
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: clip(`${SEV[r.severity]} ${r.title}`, 150) } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*${r.status}* · ${esc(`since ${r.started_at} · severity ${r.severity} · confidence ${r.cause.confidence}`)}${cc.length ? ` · cc ${cc.join(' ')}` : ''}` }],
    },
    section('What broke', r.what_broke),
    section('Impact', r.impact),
    section('Likely cause', r.cause.hypothesis),
    section('Suggested fix', r.suggested_fix),
    section('Evidence', r.evidence.map((e) => `• ${e.id}: ${e.claim}`).join('\n')),
    ...(r.not_checked.length ? [section('Not checked', r.not_checked.map((x) => `• ${x}`).join('\n'))] : []),
    ...(ch.length ? [section('Challenge', ch.join('\n'))] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: clip(esc(`patrol ${patrolAt} · ${footer}`), 300) }] },
  ];
  return { text: `${esc(`${SEV[r.severity]} ${r.title}`)}${cc.length ? ` · cc ${cc.join(' ')}` : ''}`, blocks, markdown: md };
}

// ---- the patrol card ------------------------------------------------------------
// Code's own card, posted before (or without) the LLM: one summary line, then
// what to look at by severity, what is still going on, and what is too small to
// page anyone. Only owner mentions from the owners file reach Slack unescaped.
export interface PatrolCardOptions extends DigestOptions {
  owners?: Owners | undefined;
  ref?: string | undefined; // where the full list is, shown when lines were cut
}

// Slack caps a section's text at 3000 characters. Lines are cut whole, with a
// margin, so Slack never cuts one.
const CAP = { look: 10, ongoing: 6, quiet: 8, variants: 6, section: 2600, context: 1500 };

type Fmt = { t: (s: string) => string; b: (s: string) => string; dot: string };
const SLACK: Fmt = { t: (s) => esc(redact(s)), b: (s) => `*${s}*`, dot: '•' };
const MD: Fmt = { t: redact, b: (s) => `**${s}**`, dot: '-' };

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const sum = (rows: FlaggedRow[], f: (r: FlaggedRow) => number) => rows.reduce((a, r) => a + f(r), 0);
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const minute = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')}Z`;
const TREND = { started: 'started', ongoing: 'for 1h+' } as const;

// The subject goes in code: production text can't become bold, italics or a link.
const head = (f: Fmt, l: Line) => `${f.b(f.t(l.service.replace(/[*`]/g, '')))} · ${l.section} \`${f.t(l.text.replaceAll('`', "'"))}\``;

function variants(f: Fmt, l: Line, counts: boolean): string {
  if (!l.variants) return l.rows.length > 1 ? ` (${l.rows.length} signals)` : '';
  const vs = l.variants.values;
  const shown = vs.slice(0, CAP.variants).map((v) => f.t(v.value) + (counts ? ` ${sum(v.rows, (r) => r.counts.now)}` : ''));
  return ` — ${vs.length} ${l.variants.label}: ${shown.join(', ')}${vs.length > CAP.variants ? `, +${vs.length - CAP.variants} more` : ''}`;
}

// "since" only when the signal is older than this patrol's window.
function since(l: Line, s: Summary): string | undefined {
  const first = l.rows.map((r) => r.firstSeen).sort()[0];
  return first && Date.parse(first) < Date.parse(s.at) - s.windowMinutes * 60_000 ? `since ${minute(first).slice(5)}` : undefined;
}

function lookLine(f: Fmt, l: Line, s: Summary, owner: string | undefined): string {
  const rs = l.rows;
  const totals = rs.length === 1 && rs[0]!.totals ? ` of ${rs[0]!.totals.now} requests` : '';
  const stats = `now ${rs.some((r) => r.truncated) ? '≥' : ''}${sum(rs, (r) => r.counts.now)}${totals} (1h ago ${sum(rs, (r) => r.counts.h1)}) vs expected ${num(sum(rs, (r) => r.score.expected))}`;
  const tags = [...uniq(rs.map((r) => r.score.verdict)), ...(rs.some((r) => r.novelty === 'worse') ? ['worse'] : []), ...uniq(rs.map((r) => TREND[r.score.trend])), ...(l.protected ? ['protected journey'] : [])];
  const v = variants(f, l, true);
  return [`${f.dot} ${head(f, l)}${v}${l.variants ? ' ·' : ' —'} ${stats}`, tags.join(', '), since(l, s)].filter(Boolean).join(' · ') + (owner ? ` ${owner}` : '');
}

const ongoingLine = (f: Fmt, l: Line, s: Summary) => [`${f.dot} ${head(f, l)}${variants(f, l, false)}`, `now ${sum(l.rows, (r) => r.counts.now)}`, since(l, s)].filter(Boolean).join(' · ');
const quietItem = (f: Fmt, l: Line) => `${head(f, l)}${variants(f, l, false)} (${sum(l.rows, (r) => r.counts.now)})`;

// Whole lines only: at most `max` lines (one more rather than "…and 1 more")
// and `chars` characters.
function fit<T>(items: T[], render: (x: T) => string, max: number, chars: number): { shown: string[]; hidden: T[] } {
  const shown: string[] = [];
  const cap = items.length === max + 1 ? max + 1 : max;
  let used = 0;
  for (const x of items) {
    const line = render(x);
    if (shown.length >= cap || used + line.length + 1 > chars) break;
    shown.push(line);
    used += line.length + 1;
  }
  return { shown, hidden: items.slice(shown.length) };
}

export function patrolCard(s: Summary, why: string, o: PatrolCardOptions = {}): Card {
  const d = digest(s.send, o);
  const floor = o.floor ?? DEFAULT_FLOOR;
  const owner = (l: Line) => o.owners?.ownerOf(l.service);
  const mentions = (ls: Line[]) => uniq(ls.map(owner).filter((x): x is string => !!x));
  const cc = mentions(d.look);
  const n = d.counts;
  const title = `Patrol ${minute(s.at)}: ${[n.look ? `${n.look} to look at` : 'nothing new to look at', n.ongoing ? `${n.ongoing} still ongoing` : '', n.quiet ? `${n.quiet} quiet` : ''].filter(Boolean).join(' · ')}`;
  const down = s.sources.filter((x) => !x.ok).map((x) => x.source);
  const footer = (f: Fmt, cut: boolean) => [f.t(why), down.length ? `blind spots: ${f.t(down.join(', '))}` : '', cut && o.ref ? `full list: ${f.t(o.ref)}` : ''].filter(Boolean).join(' · ');
  const ongoingHead = 'Still ongoing (reported before, not worse)';
  const quietHead = `Quiet (new, fewer than ${floor} events)`;

  // Slack: escaped, capped.
  const look = fit(d.look, (l) => lookLine(SLACK, l, s, owner(l)), CAP.look, CAP.section);
  const ongoing = fit(d.ongoing, (l) => ongoingLine(SLACK, l, s), CAP.ongoing, CAP.section);
  const quiet = fit(d.quiet, (l) => quietItem(SLACK, l), CAP.quiet, CAP.context);
  // Owners of lines to look at that didn't fit are mentioned on the "…and N more"
  // line, as far as 250 characters go (the summary line names them all anyway).
  const more = (hidden: Line[], what = '', m: string[] = []) => {
    const some = m.filter((_, i) => m.slice(0, i + 1).join(' ').length <= 250);
    return hidden.length ? [`…and ${hidden.length} more${what}${some.length ? ` ${some.join(' ')}` : ''}`] : [];
  };
  const cut = look.hidden.length + ongoing.hidden.length + quiet.hidden.length > 0;
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text: clip(text) } });
  const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(text) }] });
  const head1 = `${SLACK.b(esc(title))}${cc.length ? ` · cc ${cc.join(' ')}` : ''}`;
  const blocks = [
    section(head1),
    ...(d.look.length ? [section(['*To look at*', ...look.shown, ...more(look.hidden, ' to look at', mentions(look.hidden))].join('\n'))] : []),
    ...(d.ongoing.length ? [section([`*${ongoingHead}*`, ...ongoing.shown, ...more(ongoing.hidden)].join('\n'))] : []),
    ...(d.quiet.length ? [context(`_${quietHead}:_ ${[...quiet.shown, ...more(quiet.hidden)].join(' · ')}`)] : []),
    context(footer(SLACK, cut)),
  ];

  // Disk: the whole list, redacted, not escaped.
  const md = [
    `## ${title}${cc.length ? ` · cc ${cc.join(' ')}` : ''}`,
    ...(d.look.length ? ['', '**To look at**', ...d.look.map((l) => lookLine(MD, l, s, owner(l)))] : []),
    ...(d.ongoing.length ? ['', `**${ongoingHead}**`, ...d.ongoing.map((l) => ongoingLine(MD, l, s))] : []),
    ...(d.quiet.length ? ['', `**${quietHead}**`, ...d.quiet.map((l) => `- ${quietItem(MD, l)}`)] : []),
    '',
    `_${footer(MD, false)}_`,
  ].join('\n');
  return { text: `${esc(title)}${cc.length ? ` · cc ${cc.join(' ')}` : ''}`, blocks, markdown: md };
}
