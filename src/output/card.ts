import { finished, HOLDS, type ChallengeResult, type ItemVerdict } from '../engine/challenge.js';
import type { Report } from '../investigate/report.js';
import { recentDeploys } from '../patrol/deploys.js';
import { DEFAULT_FLOOR, digest, shortSubject, type DigestOptions, type Line } from '../patrol/digest.js';
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
// `item`: its verdict on this report, when it gave one per report. A challenge
// that didn't finish verifies nothing; its objections still show.
function challengeLines(c: ChallengeResult | undefined, item?: ItemVerdict): string[] {
  if (!c) return [];
  const head = !finished(c) ? `Not verified: the challenge did not complete (${c.note ?? 'unknown'}).` : c.verdict === 'upheld' ? `Challenge: upheld. ${c.overall}` : `⚠️ Challenge: ESCALATE, needs a human decision. ${c.overall}`;
  return [
    head,
    ...(item ? [`On this report: ${HOLDS[item.holds]}. ${item.reason}${item.evidence.length ? ` (${item.evidence.join(', ')})` : ''}${item.downgraded ? ` (${item.downgraded})` : ''}`] : []),
    ...c.blocking.map((o) => `• Objection: ${o.claim} (if acted on: ${o.failure_scenario}; check: ${o.settling_check}; ${o.evidence.join(', ')})`),
    ...(c.notes.length ? [`${c.notes.length} non-blocking note(s) in the run folder.`] : []),
  ];
}

// Every model-written string is redacted and cleaned on its own before it goes
// into the card. (Redacting the serialised blocks broke JSON on `KEY="…"`.)
const m = (s: string) => cleanModelText(redact(s));

// The issue a report belongs to, and what the report changed about it.
export interface IssueRef {
  id: string;
  title: string; // the issue's own title (from its first report)
  change: 'new' | 'update' | 'raised' | 'reopened';
  from?: Report['severity']; // with 'raised': the severity before
}

// Runbook links from the owners file: https on an allowed host, checked where
// it is loaded, so they go to Slack as links. `&` is Slack's one entity in them.
const runbookLabel = (urls: string[]) => (urls.length > 1 ? 'Runbooks' : 'Runbook');
const runbookSlack = (urls: string[]) => `${runbookLabel(urls)}: ${urls.map((u) => `<${u.replaceAll('&', '&amp;')}>`).join(' · ')}`;
const runbookMd = (urls: string[]) => `**${runbookLabel(urls)}:** ${urls.join(' · ')}`;

// `cc`: the on-call (SLACK_ONCALL) and owner mentions from the owners file
// (each validated where it is loaded), the only text that reaches Slack
// unescaped. `issue`: a new issue shows its id; an update on an existing one
// is headed by that issue, not by this report's title. `deploys`: one line of
// recent deploys (code's), on a card that is posted anyway. `item`: the
// challenger's verdict on this report. `runbooks`: its owners' runbook links.
export function reportCard(raw: Report, patrolAt: string, footer: string, challenge?: ChallengeResult, cc: string[] = [], issue?: IssueRef, deploys?: string, item?: ItemVerdict, runbooks: string[] = []): Card {
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
  const ch = challengeLines(challenge, item).map(m);
  const update = issue && issue.change !== 'new';
  const what = issue && { new: 'new issue', update: 'same cause', raised: `severity raised from ${issue.from}`, reopened: 'back after it recovered: reopened' }[issue.change];
  const md = [
    `## ${SEV[r.severity]} ${update ? `Update on ${issue.id}: ${m(issue.title)}` : r.title}`,
    ...(issue ? [`**Issue:** ${issue.id} (${what})${update ? ` · **This report:** ${r.title}` : ''}`] : []),
    `**Status:** ${r.status} · **Since:** ${r.started_at} · **Severity:** ${r.severity} · **Confidence:** ${r.cause.confidence}${cc.length ? ` · cc ${cc.join(' ')}` : ''}`,
    '',
    `**What broke:** ${r.what_broke}`,
    '',
    `**Impact:** ${r.impact}`,
    '',
    `**Likely cause:** ${r.cause.hypothesis}`,
    '',
    `**Suggested fix:** ${r.suggested_fix}`,
    ...(runbooks.length ? ['', runbookMd(runbooks)] : []),
    '',
    '**Evidence**',
    ...r.evidence.map((e) => `- ${e.id}: ${e.claim} (“${e.quote}”)`),
    ...(r.not_checked.length ? ['', '**Not checked**', ...r.not_checked.map((x) => `- ${x}`)] : []),
    ...(r.noise_rule ? ['', '**Proposed noise rule (needs review)**', '```yaml', m(JSON.stringify(r.noise_rule, null, 2)), '```'] : []),
    ...(ch.length ? ['', '**Challenge**', ...ch] : []),
    ...(deploys ? ['', `_${redact(deploys)}_`] : []),
    '',
    `_Rows: ${r.rows.join(', ')} · patrol ${patrolAt} · ${footer}_`,
  ].join('\n');

  // Slack: what someone reads in the channel. Two short paragraphs, no evidence
  // ids; the card's file and the run keep everything. Model and production text
  // is escaped so <!channel>, <@U…> or <url|label> can't act.
  const head = update ? `${SEV[r.severity]} Update on ${issue.id}: ${m(issue.title)}` : `${SEV[r.severity]} ${LEVEL[r.severity]}: ${r.title}`;
  // Before the status: what this post is to the issue.
  const lead = !issue ? '' : issue.change === 'new' ? `New issue ${issue.id}` : issue.change === 'raised' ? `Now ${LEVEL[r.severity]} (was ${LEVEL[issue.from ?? 'major']})` : issue.change === 'reopened' ? `Back again · ${LEVEL[r.severity]}` : LEVEL[r.severity];
  const pair = (a: string, x: string, b: string, y: string) => ({ type: 'section', text: { type: 'mrkdwn', text: clip(`*${a}:* ${esc(brief(x, 400))}\n*${b}:* ${esc(brief(y, 400))}`) } });
  // The challenger reviews the whole patrol. Only objections about THIS report
  // (they cite its evidence or name one of its routes) go on its card.
  const own = new Set(r.evidence.map((e) => e.id));
  const subjects = r.rows.map((k) => k.split('|')[2]).filter((x): x is string => !!x && x.length > 3);
  const against = challenge?.verdict === 'escalate' ? challenge.blocking.filter((o) => o.evidence.some((id) => own.has(id)) || subjects.some((s) => o.claim.includes(s))) : [];
  const verified = !!challenge && finished(challenge);
  const elsewhere = verified && challenge?.verdict === 'escalate' && !against.length;
  // Its own verdict on this report, when it gave one, says more than the objections.
  const doubt =
    item?.holds === 'no'
      ? { says: 'says this does not hold up', why: [item.reason, ...against.map((o) => o.claim)] }
      : against.length
        ? { says: 'disputes this', why: against.map((o) => o.claim) }
        : item?.holds === 'partly'
          ? { says: 'disputes this', why: [item.reason] }
          : undefined;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: clip(head, 150) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${lead ? `${esc(lead)} · ` : ''}*${r.status}* ${esc(`since ${when(r.started_at, patrolAt)} · confidence ${r.cause.confidence}`)}${cc.length ? ` · cc ${cc.join(' ')}` : ''}` }] },
    pair("What's wrong", r.what_broke, 'Impact', r.impact),
    pair('Likely cause', r.cause.hypothesis, 'Suggested fix', r.suggested_fix),
    ...(runbooks.length ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: clip(runbookSlack(runbooks)) }] }] : []),
    ...(doubt ? [{ type: 'section', text: { type: 'mrkdwn', text: clip(`⚠️ *A second AI check ${doubt.says}, a human decides:* ${esc(brief(noIds(m(doubt.why.join(' '))), 400))}`) } }] : []),
    ...(deploys ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: clip(esc(redact(deploys)), 600) }] }] : []),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: clip(
            esc(
              [
                `${r.evidence.length} evidence ${r.evidence.length === 1 ? 'item' : 'items'}`,
                r.not_checked.length ? `${r.not_checked.length} not checked` : '',
                challenge && !verified ? 'not verified by a second check' : doubt ? '' : item?.holds === 'yes' || challenge?.verdict === 'upheld' ? 'second check agrees' : elsewhere ? 'second check disputes another finding' : '',
                `patrol ${when(patrolAt, patrolAt)}`,
                footer,
              ]
                .filter(Boolean)
                .join(' · '),
            ),
            300,
          ),
        },
      ],
    },
  ];
  return { text: `${esc(head)}${cc.length ? ` · cc ${cc.join(' ')}` : ''}`, blocks, markdown: md };
}

const LEVEL = { critical: 'Critical', major: 'Major', minor: 'Minor', noise: 'Noise' } as const;

// Evidence ids mean nothing in Slack; the card's file keeps them.
const noIds = (s: string) => s.replace(/\s*\(?\bE-[0-9a-f]{4}-\d+\)?/g, '');

// A time as HH:MMZ, with the date only when it isn't the patrol's day.
function when(iso: string, patrolAt: string): string {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(iso)) return iso.slice(0, 40);
  const t = `${iso.slice(11, 16)}Z`;
  return iso.slice(0, 10) === patrolAt.slice(0, 10) ? t : `${iso.slice(5, 10)} ${t}`;
}

// At most `n` characters, ending at a sentence when one ends past a third of it.
export function brief(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return end > n / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, n - 1).trimEnd()}…`;
}

// ---- the patrol card ------------------------------------------------------------
// Code's own card, posted before (or without) the LLM: one summary line, then
// what to look at by severity, what is still going on, and what is too small to
// page anyone. Only the on-call and owners-file mentions reach Slack unescaped.
export interface PatrolCardOptions extends DigestOptions {
  owners?: Owners | undefined;
  oncall?: string | undefined; // the on-call mention (SLACK_ONCALL), first in cc; the caller decides when
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
  const deploy = [...rs].sort((a, b) => a.firstSeen.localeCompare(b.firstSeen)).find((r) => r.afterDeploy)?.afterDeploy;
  return [`${f.dot} ${head(f, l)}${v}${l.variants ? ' ·' : ' —'} ${stats}`, tags.join(', '), since(l, s), deploy && f.t(deploy)].filter(Boolean).join(' · ') + (owner ? ` ${owner}` : '');
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
  const owner = (l: Line) => o.owners?.ownerOf(l.service)?.primary;
  const mentions = (ls: Line[]) => uniq(ls.map(owner).filter((x): x is string => !!x));
  // The runbooks of the lines to look at, after them.
  const runbooks = uniq(d.look.map((l) => o.owners?.ownerOf(l.service)?.runbook).filter((x): x is string => !!x));
  const cc = uniq([...(o.oncall ? [o.oncall] : []), ...mentions(d.look)]);
  const n = d.counts;
  const title = `Patrol ${minute(s.at)}: ${[n.look ? `${n.look} to look at` : 'nothing new to look at', n.ongoing ? `${n.ongoing} still ongoing` : '', n.quiet ? `${n.quiet} quiet` : ''].filter(Boolean).join(' · ')}`;
  const down = s.sources.filter((x) => !x.ok).map((x) => x.source);
  const footer = (f: Fmt, cut: boolean) => [f.t(why), down.length ? `blind spots: ${f.t(down.join(', '))}` : '', cut && o.ref ? `full list: ${f.t(o.ref)}` : ''].filter(Boolean).join(' · ');
  const deploys = recentDeploys(s.deploys);
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
    ...(runbooks.length ? [context(runbookSlack(runbooks))] : []),
    ...(d.ongoing.length ? [section([`*${ongoingHead}*`, ...ongoing.shown, ...more(ongoing.hidden)].join('\n'))] : []),
    ...(d.quiet.length ? [context(`_${quietHead}:_ ${[...quiet.shown, ...more(quiet.hidden)].join(' · ')}`)] : []),
    ...(deploys ? [context(SLACK.t(deploys))] : []),
    context(footer(SLACK, cut)),
  ];

  // Disk: the whole list, redacted, not escaped.
  const md = [
    `## ${title}${cc.length ? ` · cc ${cc.join(' ')}` : ''}`,
    ...(d.look.length ? ['', '**To look at**', ...d.look.map((l) => lookLine(MD, l, s, owner(l)))] : []),
    ...(runbooks.length ? ['', runbookMd(runbooks)] : []),
    ...(d.ongoing.length ? ['', `**${ongoingHead}**`, ...d.ongoing.map((l) => ongoingLine(MD, l, s))] : []),
    ...(d.quiet.length ? ['', `**${quietHead}**`, ...d.quiet.map((l) => `- ${quietItem(MD, l)}`)] : []),
    ...(deploys ? ['', `_${MD.t(deploys)}_`] : []),
    '',
    `_${footer(MD, false)}_`,
  ].join('\n');
  return { text: `${esc(title)}${cc.length ? ` · cc ${cc.join(' ')}` : ''}`, blocks, markdown: md };
}

// ---- recovered ------------------------------------------------------------------
// A short reply in the thread where the rows were posted. Row keys are
// section|service|subject|status; the subject may itself contain '|'. With an
// issue id: every row of that issue is back, and the issue is resolved. quiet:
// how long the rows went without firing before they counted as back.
const rowName = (k: string) => {
  const parts = k.split('|');
  const [section, service] = parts;
  const status = parts.length > 3 ? parts[parts.length - 1] : '';
  const subject = parts.slice(2, parts.length > 3 ? -1 : undefined).join('|');
  return `${service} · ${shortSubject({ section: section as FlaggedRow['section'], subject })}${status ? ` ${status}` : ''}`;
};

export function recoveredCard(keys: string[], at: string, issue?: string, quiet?: number): Card {
  // A stalled rollout back to normal is a rollout that completed.
  const lines = keys.map((k) => (/^rollout\|[^|]+\|stalled\|/.test(k) ? `${k.split('|')[1]} · rollout complete` : rowName(k)));
  const stallsOnly = keys.every((k) => /^rollout\|[^|]+\|stalled\|/.test(k));
  const calm = quiet && !stallsOnly ? ` · quiet for ${quiet % 60 ? `${quiet} min` : `${quiet / 60} h`}` : '';
  const head = `✅ Back to normal at ${minute(at).slice(11)}${calm}${issue ? ` · ${issue} resolved` : ''}`;
  const text = `${head}: ${lines.length === 1 ? lines[0] : `${lines.length} signals`}`;
  const blocks = [{ type: 'context', elements: [{ type: 'mrkdwn', text: clip(esc(redact(`${head}\n${lines.map((l) => `• ${l}`).join('\n')}`)), 2900) }] }];
  return { text: esc(redact(text)), blocks, markdown: `**${head}**\n${lines.map((l) => `- ${l}`).join('\n')}` };
}

// ---- worse, on an issue someone is on ---------------------------------------------
// Code's line in the issue's thread when rows of it got worse after someone
// clicked On it: no AI run, not shown in the channel. It mentions who is on it
// (a Slack user id from the click, checked here too).
export function worseCard(rows: Array<{ key: string; now: number; was?: number | undefined }>, at: string, issue: string, by: string): Card {
  const lines = rows.map((r) => `${rowName(r.key)} now ${r.now}${r.was !== undefined ? ` (was ${r.was})` : ''}`);
  const head = `📈 Worse at ${minute(at).slice(11)} on ${issue}`;
  const who = /^[UW][A-Z0-9]{2,30}$/.test(by) ? ` · On it: <@${by}>` : '';
  const text = `${head}: ${lines.length === 1 ? lines[0] : `${lines.length} signals`}`;
  const blocks = [{ type: 'context', elements: [{ type: 'mrkdwn', text: clip(`${esc(redact(`${head}\n${lines.map((l) => `• ${l}`).join('\n')}`))}${who}`, 2900) }] }];
  return { text: `${esc(redact(text))}${who}`, blocks, markdown: `**${head}** (On it: ${by}, no AI run)\n${lines.map((l) => `- ${l}`).join('\n')}` };
}

// ---- escalation: nobody is on an issue --------------------------------------------
// Code's line in the issue's thread when nobody clicked On it within the owners
// file's escalation window: it asks the backups (mentions validated where they
// are loaded). Not shown in the channel; the mention notifies them.
export function escalationCard(issue: string, minutes: number, backups: string[]): Card {
  const head = `⏰ Nobody is on ${issue} after ${span(minutes * 60_000)}:`;
  const text = `${esc(head)} ${backups.join(' ')}, can you take a look?`;
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }], markdown: `**${head}** ${backups.join(' ')}, can you take a look?` };
}

// ---- notices: the AI paused, sources the patrol can't read ------------------------
// Code's own top-level messages, each said once when it starts and once when it
// ends (output/notices.ts). Without them a quiet channel looks the same as a
// watch that stopped.

// A hold that pauses the AI, as the channel reads it: a spend cap or the kill
// switch. Others are not announced (undefined): another run still going or a
// shutdown pass by themselves, and a nearly full volume has its own alert (its
// note changes every patrol, so each would read as a new hold).
export function pauseText(reason: string): string | undefined {
  const cap = (what: string) => new RegExp(`^${what} cap \\$(\\S+) reached`).exec(reason)?.[1];
  let usd: string | undefined;
  if ((usd = cap('agent monthly'))) return `the monitor's monthly AI budget ($${usd}) is used up`;
  if ((usd = cap('agent daily'))) return `the monitor's daily AI budget ($${usd}) is used up until 00:00 UTC`;
  if ((usd = cap('global daily'))) return `the daily AI budget across all agents ($${usd}) is used up until 00:00 UTC`;
  if ((usd = cap('monthly'))) return `the monthly AI budget across all agents ($${usd}) is used up`;
  if (/^kill switch is on/.test(reason)) return `the ${reason}`; // who set it and why, as stop_all wrote it
  return undefined;
}

// How long, in the largest unit that reads well.
function span(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
  return `${Math.round(min / 1440)} d`;
}

// A bold first line and a few plain ones. Everything is code's text or
// production's (a source's error, who set the kill switch): escaped.
function notice(head: string, lines: string[]): Card {
  const slack = (s: string) => esc(redact(s));
  return {
    text: slack(head),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: clip(`*${slack(head)}*\n${slack(lines.join('\n'))}`) } }],
    markdown: `**${redact(head)}**\n${lines.map(redact).join('\n')}`,
  };
}

export function pausedCard(why: string, since: string, at: string): Card {
  return notice(`⏸️ AI paused: ${why}`, [`Since ${when(since, at)}. Urgent rows are still posted; other rows wait until it lifts.`]);
}

export function resumedCard(why: string, since: string, at: string): Card {
  return notice('▶️ AI investigations resumed', [`Paused since ${when(since, at)} (${span(Date.parse(at) - Date.parse(since))}): ${why}.`]);
}

// The kind of failure, in a few words. The patrol file has the whole error.
export function errorClass(error: string): string {
  const m = /^(prometheus|loki|tempo): ([\s\S]*)$/.exec(error);
  const rest = (m?.[2] ?? error).replace(/\s+/g, ' ').trim();
  const http = /^HTTP (\d{3})\b/.exec(rest);
  const kind = http
    ? `HTTP ${http[1]}`
    : /timeout|timed out|aborted/i.test(rest)
      ? 'timeout'
      : /^no .*\bseries\b/.test(rest)
        ? 'no series (missing data)'
        : /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(rest)
          ? 'unreachable'
          : /^non-JSON/.test(rest)
            ? 'not JSON'
            : rest.length > 60
              ? `${rest.slice(0, 59)}…`
              : rest || 'unknown error';
  return redact(m ? `${m[1]} ${kind}` : kind);
}

// Sources the patrol couldn't read this patrol, by kind of failure. `also`:
// others were already blind, and the channel was told.
export function blindCard(down: Array<{ source: string; error: string }>, at: string, also = false): Card {
  const by = new Map<string, string[]>();
  for (const d of down) by.set(errorClass(d.error), [...(by.get(errorClass(d.error)) ?? []), d.source]);
  const what = down.length === 1 ? down[0]!.source : `${down.length} sources`;
  return notice(`⚠️ ${also ? 'Also blind' : 'Blind'} at ${minute(at).slice(11)}: the patrol could not read ${what}`, [
    ...[...by].map(([kind, sources]) => `• ${sources.join(', ')}: ${kind}`),
    'Problems there go unseen, and their issues stay open, until they read again.',
  ]);
}

// Every source the channel was told is blind reads again: each with how long
// it was blind (since the first patrol that couldn't read it).
export function sightCard(back: Array<{ source: string; since: string }>, at: string): Card {
  const by = new Map<string, string[]>();
  for (const b of back) {
    const d = span(Date.parse(at) - Date.parse(b.since));
    by.set(d, [...(by.get(d) ?? []), b.source]);
  }
  const what = back.length === 1 ? back[0]!.source : `${back.length} sources`;
  const one = by.size === 1 ? [...by.keys()][0] : undefined;
  const lines = one ? [`• ${back.map((b) => b.source).join(', ')}`] : [...by].map(([d, sources]) => `• ${sources.join(', ')}: blind for ${d}`);
  return notice(`✅ The patrol reads ${what} again at ${minute(at).slice(11)}${one ? `, after ${one} blind` : ''}`, lines);
}
