import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadAgent } from '../src/engine/agent.js';
import { Evidence, type EvidenceItem } from '../src/engine/evidence.js';
import type { Engine } from '../src/engine/run.js';
import type { Session } from '../src/engine/session.js';
import { Store } from '../src/engine/store.js';
import { fence } from '../src/engine/text.js';
import {
  classifyMiss,
  costPerDay,
  evalEpisode,
  evalExitCode,
  evalLine,
  evalTotals,
  Label,
  parseLabel,
  problemLines,
  problemsOf,
  promptOf,
  recordedTools,
  scoreLabel,
  wouldPost,
  type EvalReport,
  type EvalResult,
  type Tally,
} from '../src/eval.js';
import { monitorTask, taskRows } from '../src/investigate/prompt.js';
import type { Report } from '../src/investigate/report.js';
import { monitorTools } from '../src/investigate/tools.js';
import type { Issue } from '../src/patrol/issues.js';
import { Noise } from '../src/patrol/noise.js';
import { fakeSession, ok, say, type Script } from './fake-session.js';
import { FakeTelemetry, testConfig } from './fake.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const lastId = (t: string) => [...t.matchAll(/evidence_id: (E-[0-9a-f]{4}-\d+)/g)].at(-1)?.[1] ?? 'none';
const monitor = () => loadAgent(join(import.meta.dirname, '..', 'agents', 'monitor'));

function engine(session: Session): Engine {
  const runsDir = tmp('runs-');
  return { store: new Store(join(runsDir, 'engine.db')), runsDir, stopFile: join(runsDir, 'STOP'), session, dailyCapUsd: 20, llmAvailable: true };
}

// input.md as runAgent writes it.
const inputMd = (prompt: string) => `# monitor @ 0123456789ab\n\nengine: 7f27897\ntrigger: patrol\nchallenge: if the outputs need it\n\n${prompt}\n`;

const LOGIN = 'http|auth|/login|500';
const report = (over: Partial<Report>): Report => ({
  title: 'Login returns 500 for most users',
  severity: 'major',
  status: 'active',
  started_at: '2026-11-04T11:50:00Z',
  what_broke: 'POST /login returns 500',
  impact: '420 failed logins in 15 min',
  reach: 'many',
  cause: { hypothesis: 'the session store is down', confidence: 'medium' },
  evidence: [],
  suggested_fix: 'check the session store',
  not_checked: [],
  rows: [LOGIN],
  issue: 'new',
  ...over,
});

test('recorded tools: the recorded (tool, redacted args) gets its recorded text as new evidence; anything else is a counted miss', async () => {
  const cfg = testConfig();
  // As production stored them: args redacted, with the schema's defaults; text redacted and cut to size.
  const search = { service: 'auth', contains: '<email>', errors_only: true, minutes: 30, end_minutes_ago: 0, limit: 300 };
  const cut = `${'x'.repeat(9000)}\n… [truncated 5000 chars]`;
  const items: EvidenceItem[] = [
    { id: 'E-0a0a-1', by: 'author', tool: 'log_search', args: search, text: '3× auth login failed for <email>' },
    { id: 'E-0a0a-2', by: 'challenger', tool: 'log_search', args: search, text: '4× auth login failed for <email> (a minute later)' },
    { id: 'E-0a0a-3', by: 'author', tool: 'service_overview', args: { service: 'auth', minutes: 60 }, text: 'route status | now\n/login 500 | 420' },
    { id: 'E-0a0a-4', by: 'author', tool: 'recent_changes', args: { hours: 24 }, text: cut },
    // The same call twice with the same result: still one answer.
    { id: 'E-0a0a-5', by: 'author', tool: 'service_overview', args: { service: 'auth', minutes: 60 }, text: 'route status | now\n/login 500 | 420' },
    // Two searches for two customers' emails: the same once redacted, with different results.
    { id: 'E-0a0a-6', by: 'author', tool: 'log_search', args: { ...search, service: 'billing' }, text: 'refund failed for <email> (the first customer)' },
    { id: 'E-0a0a-7', by: 'author', tool: 'log_search', args: { ...search, service: 'billing' }, text: 'refund failed for <email> (the second customer)' },
  ];
  const tally: Tally = { hits: { author: 0, challenger: 0 }, misses: [], ambiguous: [] };
  const ev = new Evidence();
  const author = recordedTools(items, cfg, tally)(ev, 'author');
  const challenger = recordedTools(items, cfg, tally)(ev, 'challenger');
  // The live tools' names, descriptions and schemas.
  const live = monitorTools(new FakeTelemetry(() => []), cfg, new Date())(new Evidence(), 'author');
  const face = (ts: typeof live) => ts.map((t) => [t.name, t.description, Object.keys(t.inputSchema)]);
  assert.deepEqual(face(author), face(live));
  const call = async (tools: typeof live, name: string, args: Record<string, unknown>) => {
    const r = await tools.find((t) => t.name === name)!.handler(args, {});
    return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), isError: Boolean(r.isError) };
  };

  // The live call has the raw email, its keys in another order and one the schema drops: canonicalized, it is the recorded one.
  const hit = await call(author, 'log_search', { limit: 300, end_minutes_ago: 0, minutes: 30, errors_only: true, contains: 'someone@example.com', service: 'auth', extra: 'dropped' });
  assert.equal(hit.isError, false);
  const id = lastId(hit.text);
  assert.equal(id, `E-${ev.nonce}-1`);
  assert.match(hit.text, /3× auth login failed for <email>/);
  assert.equal(ev.quoteProblem(id, 'login failed for <email>'), undefined);
  assert.deepEqual(ev.items.get(id)!.args, search);
  // A cut result keeps its own "[truncated N chars]".
  assert.equal(ev.items.get(lastId((await call(author, 'recent_changes', {})).text))!.text, cut);
  // The challenger gets the challenger's recording, else the author's (defaults filled in by the schema).
  assert.match((await call(challenger, 'log_search', { ...search, contains: 'someone@example.com' })).text, /a minute later/);
  assert.match((await call(challenger, 'service_overview', { service: 'auth' })).text, /\/login 500 \| 420/);
  assert.match((await call(author, 'service_overview', { service: 'auth' })).text, /\/login 500 \| 420/);

  // Other args, another tool: an error for the model, counted, not evidence.
  const miss = await call(author, 'service_overview', { service: 'auth', minutes: 120 });
  assert.equal(miss.isError, true);
  assert.match(miss.text, /^error: not in this episode's recording/);
  assert.equal((await call(challenger, 'promql', { query: 'sum(up{job="auth"})' })).isError, true);
  // A call recorded twice with different results can't be told apart: neither answer, no guessed order.
  const twice = await call(author, 'log_search', { ...search, service: 'billing', contains: 'a@example.com' });
  assert.equal(twice.isError, true);
  assert.match(twice.text, /^error: ambiguous in this episode's recording/);
  assert.doesNotMatch(twice.text, /customer/);
  assert.equal((await call(challenger, 'log_search', { ...search, service: 'billing', contains: 'b@example.com' })).isError, true);
  assert.deepEqual(tally.hits, { author: 3, challenger: 2 });
  assert.deepEqual(tally.misses, [
    { by: 'author', tool: 'service_overview', args: { service: 'auth', minutes: 120 } },
    { by: 'challenger', tool: 'promql', args: { query: 'sum(up{job="auth"})' } },
  ]);
  const billing = { ...search, service: 'billing' };
  assert.deepEqual(tally.ambiguous, [
    { by: 'author', tool: 'log_search', args: billing },
    { by: 'challenger', tool: 'log_search', args: billing },
  ]);
  assert.equal(ev.items.size, 5);
});

test('an episode prompt is the production prompt: the run header off, the task and the fenced context apart', () => {
  const issue: Issue = { id: 'I-7f3a', opened_at: '2026-11-03T10:00:00.000Z', last_at: '2026-11-04T09:00:00.000Z', resolved_at: null, status: 'open', severity: 'major', title: 'Sign-up returns 400', rows: ['http|auth|/signup|400'], hypothesis: 'a validation change' };
  const task = monitorTask([LOGIN, 'logs|auth|login failed for <email>|'], { issues: [issue], more: 0 });
  const prompt = [task, '', fence('context', 'Patrol at 2026-11-04T12:00:00.000Z\n- a log line with <<<planted>>> fences')].join('\n');
  const p = promptOf(inputMd(prompt));
  assert.equal(p.agent, 'monitor');
  assert.equal(p.task, task);
  assert.equal([p.task, '', fence('context', p.data!)].join('\n'), prompt);
  assert.deepEqual(taskRows(p.task), { rows: [LOGIN, 'logs|auth|login failed for <email>|'], issues: ['I-7f3a'] });
  assert.throws(() => promptOf(prompt), /run header/);
});

test('eval: a past run again on its own prompt, tools from its recording, the challenger as in a patrol; the result next to prod and the label', async () => {
  const dir = tmp('episode-');
  const prompt = [monitorTask([LOGIN], { issues: [], more: 0 }), '', fence('context', `Patrol at 2026-11-04T12:00:00.000Z, window 15 min.\n\n## New or worse (1)\n- ${LOGIN} now 420`)].join('\n');
  writeFileSync(join(dir, 'input.md'), inputMd(prompt));
  const overview: EvidenceItem = { id: 'E-0b0b-1', by: 'author', tool: 'service_overview', args: { service: 'auth', minutes: 60 }, text: 'route status | now | 1d ago | 7d ago\n/login 500 | 420 | 3 | 2' };
  writeFileSync(join(dir, 'evidence.jsonl'), `${JSON.stringify(overview)}\n`);
  writeFileSync(join(dir, 'output.json'), JSON.stringify([report({ evidence: [{ id: 'E-0b0b-1', quote: '/login 500 | 420', claim: '420 logins failed' }] })], null, 1));
  writeFileSync(join(dir, 'challenge.json'), JSON.stringify({ verdict: 'upheld', blocking: [], notes: [], items: [{ item: 1, holds: 'yes', reason: 'Counts match.', evidence: [] }], overall: 'Holds up.', cost: 0.1, turns: 2, toolCalls: 1 }));
  writeFileSync(join(dir, 'label.json'), JSON.stringify({ expect: 'post', severity: 'major', note: 'real outage' }));

  const author: Script = async function* (sim) {
    const r = await sim.mcp('service_overview', { service: 'auth', minutes: 60 });
    await sim.mcp('promql', { query: 'sum(rate(session_store_errors_total[5m]))' }); // not in the recording
    yield say();
    await sim.mcp('submit_report', report({ evidence: [{ id: lastId(r.text), quote: '/login 500 | 420', claim: '420 logins failed' }] }));
    yield ok(0.3, 5);
  };
  const challenger: Script = async function* (sim) {
    const r = await sim.mcp('service_overview', { service: 'auth' }); // the author's recording, defaults filled in
    await sim.mcp('submit_challenge', { objections: [], items: [{ item: 1, holds: 'yes', reason: 'The counts match.', evidence: [lastId(r.text)] }], overall: 'Holds up.' });
    yield ok(0.1, 2);
  };
  const session = fakeSession(author, challenger);
  const e = engine(session);
  const res = await evalEpisode(e, monitor(), testConfig(), new Noise({}), dir);

  // Byte for byte the production prompt, with the live tools' names (and submit_report).
  assert.equal(session.requests[0]!.prompt, prompt);
  assert.deepEqual(
    session.requests[0]!.tools.map((t) => t.name),
    [...monitorTools(new FakeTelemetry(() => []), testConfig(), new Date())(new Evidence(), 'author').map((t) => t.name), 'submit_report'],
  );
  assert.equal(session.requests.length, 2); // a major report: challenged before it would post
  assert.equal(res.run.status, 'ok');
  assert.ok(res.run.dir?.startsWith(join(dir, 'runs', 'monitor')));
  assert.equal(res.cost, 0.4);
  assert.equal(res.turns, 5);
  assert.deepEqual(res.challenge, { verdict: 'upheld', cost: 0.1, turns: 2 });
  assert.deepEqual(res.hits, { author: 1, challenger: 1 });
  assert.deepEqual(res.misses, [{ by: 'author', tool: 'promql', args: { query: 'sum(rate(session_store_errors_total[5m]))' } }]);
  assert.deepEqual(res.ambiguous, []);
  // The recording never had promql: a new tool, listed, not material.
  assert.deepEqual(res.newTools, ['promql']);
  assert.deepEqual(res.material, []);
  assert.deepEqual(res.reports, [{ title: 'Login returns 500 for most users', severity: 'major', rows: [LOGIN], issue: 'new', holds: 'yes', posts: true }]);
  assert.deepEqual(res.prod, { reports: [{ title: 'Login returns 500 for most users', severity: 'major', rows: [LOGIN], issue: 'new', holds: 'yes', posts: true }], challenge: 'upheld' });
  assert.equal(res.inconclusive, undefined);
  assert.equal(res.outcome, 'match');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'eval-result.json'), 'utf8')), JSON.parse(JSON.stringify(res)));
  assert.match(evalLine(res), /: ok · reports major \(posts\) · prod major \(posts\) · 2 hit\(s\), 1 miss\(es\), 0 ambiguous: 1 of 3 call\(s\) unanswered · new tool, not in recording: promql · 5 turns · \$0\.40 · label post major: match$/);
  // The old label form: one implicit problem over the task's rows.
  assert.deepEqual(problemLines(res), ['  label (actionable, post major): 1 report(s), 1 posted, top major · ok']);
  assert.equal(evalExitCode([res]), 0);
  assert.equal(e.store.get(res.run.id)!.trigger, 'eval');

  // Without the challenger, a major report is not posted; the challenge was due, so it says nothing either way.
  const quick = await evalEpisode(engine(fakeSession(author)), monitor(), testConfig(), new Noise({}), dir, { challenge: false });
  assert.equal(quick.challenge, undefined);
  assert.equal(quick.reports[0]!.posts, false);
  assert.equal(quick.inconclusive, 'a challenge was due and was skipped');
  assert.equal(quick.outcome, 'inconclusive');
  assert.equal(evalExitCode([res, quick]), 1);
  // ...unless one of its rows is a protected journey, which posts regardless.
  assert.equal(wouldPost(quick.reports[0]!, 1, undefined, new Noise({ never_suppress: [{ section: 'http', service: 'auth', route: '/login' }] })), true);

  // The kill switch holds for an eval like any run: skipped, no model call.
  const stopped = fakeSession();
  const s = engine(stopped);
  writeFileSync(s.stopFile, 'now');
  const held = await evalEpisode(s, monitor(), testConfig(), new Noise({}), dir);
  assert.equal(held.run.status, 'skipped');
  assert.equal(stopped.requests.length, 0);
  assert.equal(held.outcome, 'inconclusive'); // never ran: judged neither way
  assert.match(evalLine(held), /label post major: inconclusive · inconclusive: the run ended skipped \(kill switch is on/);
  assert.equal(evalTotals([res, quick, held]), '3 episode(s) · labels: 1 match, 0 mismatch, 2 inconclusive · problems: 1 judged, all as labelled · 3 hit(s), 2 miss(es), 0 ambiguous: 2 of 5 call(s) unanswered · $0.70');
});

// ---------- what an eval can't judge, and the patrol's challenge gate ----------

const OVERVIEW: EvidenceItem = { id: 'E-0c0c-1', by: 'author', tool: 'service_overview', args: { service: 'auth', minutes: 60 }, text: 'route status | now | 1d ago | 7d ago\n/login 500 | 420 | 3 | 2' };
function episode(rows: string[], items: EvidenceItem[], label: object): string {
  const dir = tmp('episode-');
  writeFileSync(join(dir, 'input.md'), inputMd([monitorTask(rows, { issues: [], more: 0 }), '', fence('context', 'Patrol at 2026-11-04T12:00:00.000Z, window 15 min.')].join('\n')));
  writeFileSync(join(dir, 'evidence.jsonl'), items.map((e) => `${JSON.stringify(e)}\n`).join(''));
  writeFileSync(join(dir, 'label.json'), JSON.stringify(label));
  return dir;
}
const reporting = (severity: Report['severity'], rows: string[]): Script =>
  async function* (sim) {
    const r = await sim.mcp('service_overview', { service: 'auth', minutes: 60 });
    await sim.mcp('submit_report', report({ severity, ...(severity === 'minor' ? { reach: 'few' as const } : {}), rows, evidence: [{ id: lastId(r.text), quote: '/login 500 | 420', claim: '420 logins failed' }] }));
    yield ok(0.2, 3);
  };
const upholds: Script = async function* (sim) {
  const r = await sim.mcp('service_overview', { service: 'auth' });
  await sim.mcp('submit_challenge', { objections: [], items: [{ item: 1, holds: 'yes', reason: 'The counts match.', evidence: [lastId(r.text)] }], overall: 'Holds up.' });
  yield ok(0.1, 2);
};

test('eval: a run whose author got no recorded result, or whose due challenge did not finish, is inconclusive, never a pass', async () => {
  const noPost = { expect: 'no-post' };
  // Every call missed and nothing was filed: that says nothing about the AI.
  const blind: Script = async function* (sim) {
    await sim.mcp('promql', { query: 'sum(up{job="auth"})' });
    yield say('nothing to go on');
    yield ok(0.1, 2);
  };
  const a = await evalEpisode(engine(fakeSession(blind)), monitor(), testConfig(), new Noise({}), episode([LOGIN], [OVERVIEW], noPost));
  assert.equal(a.run.status, 'no_output');
  assert.equal(a.inconclusive, 'the author got no recorded result');
  assert.equal(a.outcome, 'inconclusive');
  assert.match(evalLine(a), /0 hit\(s\), 1 miss\(es\), 0 ambiguous: 1 of 1 call\(s\) unanswered/);

  // A major report the challenger never judged is not posted, but that is no "no-post".
  const gaveUp: Script = async function* () {
    yield say('out of time');
    yield ok(0.05, 1);
  };
  const b = await evalEpisode(engine(fakeSession(reporting('major', [LOGIN]), gaveUp)), monitor(), testConfig(), new Noise({}), episode([LOGIN], [OVERVIEW], noPost));
  assert.equal(b.run.status, 'ok');
  assert.equal(b.reports[0]!.posts, false);
  assert.equal(b.inconclusive, 'a challenge was due and did not finish (challenger submitted nothing)');
  assert.equal(b.outcome, 'inconclusive');

  // Looked and found nothing worth filing, from recorded results: judged.
  const quiet: Script = async function* (sim) {
    await sim.mcp('service_overview', { service: 'auth', minutes: 60 });
    yield ok(0.1, 2);
  };
  const c = await evalEpisode(engine(fakeSession(quiet)), monitor(), testConfig(), new Noise({}), episode([LOGIN], [OVERVIEW], noPost));
  assert.equal(c.run.status, 'no_output');
  assert.equal(c.outcome, 'match');
});

test('eval: the challenger runs on what the patrol would challenge, as far as row keys tell: rollout rows and protected journeys, even for a minor report', async () => {
  const noPost = { expect: 'no-post', severity: 'minor' };
  const run = async (rows: string[], noise: Noise) => {
    const session = fakeSession(reporting('minor', rows), upholds);
    const r = await evalEpisode(engine(session), monitor(), testConfig(), noise, episode(rows, [OVERVIEW], noPost));
    return { r, sessions: session.requests.length };
  };
  const rollout = 'rollout|ecom-service|ecom-service|stalled';
  const ro = await run([rollout], new Noise({}));
  assert.equal(ro.sessions, 2);
  assert.equal(ro.r.challenge?.verdict, 'upheld');
  assert.equal(ro.r.outcome, 'match');
  const journey = await run([LOGIN], new Noise({ never_suppress: [{ section: 'http', service: 'auth', route: '/login' }] }));
  assert.equal(journey.sessions, 2);
  assert.equal(journey.r.outcome, 'match');
  // Any other row with only a minor report: no challenge, as in a patrol (unless it was a big jump, which a key doesn't tell).
  const plain = await run([LOGIN], new Noise({}));
  assert.equal(plain.sessions, 1);
  assert.equal(plain.r.challenge, undefined);
  assert.equal(plain.r.outcome, 'match');
});

// ---------- label v2: problems, scored one by one ----------

const PAY = 'http|payments|/charge|502';
const CRAWLER = 'logs|crawler|bot hit on /sitemap|';
const OTHER = 'http|search|/query|504';
const R = (severity: Report['severity'], rows: string[], posts: boolean, title = `${severity} on ${rows.join(', ')}`): EvalReport => ({ title, severity, rows, posts });

test('label: v2 lists problems (row keys or /regexes/); the old {expect, severity, note} form still parses, as one implicit problem; contradictions are refused', () => {
  const v1 = parseLabel({ expect: 'post', severity: 'major', note: 'real outage' });
  assert.deepEqual(v1, { expect: 'post', severity: 'major', note: 'real outage' });
  assert.deepEqual(Label.parse({ expect: 'no-post' }), { expect: 'no-post' });
  assert.deepEqual(problemsOf(v1, [LOGIN, CRAWLER]), [{ id: 'label', rows: [LOGIN, CRAWLER], actionable: true, expect: 'post', severity: 'major', implicit: true }]);
  assert.deepEqual(problemsOf(parseLabel({ expect: 'no-post' }), [LOGIN]), [{ id: 'label', rows: [LOGIN], actionable: false, expect: 'no-post', implicit: true }]);

  const v2 = { problems: [{ id: 'payments', rows: [PAY, '/^http\\|payments\\|/'], actionable: true, severity: 'critical', expect: 'post' }], note: 'checkout down' };
  assert.deepEqual(parseLabel(v2), v2);
  assert.deepEqual(Label.parse(v2), v2);
  const bad = (problem: object) => ({ problems: [{ id: 'p', rows: [LOGIN], actionable: true, expect: 'post', ...problem }] });
  assert.throws(() => parseLabel(bad({ actionable: false })), /not actionable cannot expect a post/);
  assert.throws(() => parseLabel(bad({ rows: ['/(unclosed/'] })), /neither a row key nor a valid \/regex\//);
  // A pattern starting with a slash that is no /regex/ would match nothing as a row key (they start with their section): refused.
  for (const rows of [['/^http\\|auth\\|/i'], ['/'], ['//'], ['/http|auth|/login|500']]) assert.throws(() => parseLabel(bad({ rows })), /neither a row key nor a valid \/regex\//, rows[0]);
  // A v1 expect or severity beside problems would say nothing any more: refused, not dropped.
  assert.throws(() => parseLabel({ ...bad({}), severity: 'critical' }), /with problems, expect and severity go on each problem/);
  assert.throws(() => parseLabel({ ...bad({}), expect: 'no-post' }), /with problems, expect and severity go on each problem/);
  assert.throws(() => Label.parse({ ...bad({}), expect: 'no-post' }));
  assert.throws(() => parseLabel(bad({ rows: [] })));
  assert.throws(() => parseLabel({ problems: [bad({}).problems[0], bad({}).problems[0]] }), /problem ids must be unique/);
  // A v2 label never falls back to the v1 form, even with v1 keys beside it.
  assert.throws(() => parseLabel({ expect: 'post', ...bad({ actionable: false }) }), /not actionable/);
  assert.throws(() => Label.parse({ expect: 'post', ...bad({ actionable: false }) }));
  assert.throws(() => parseLabel({ problems: [] }));
});

test('score: a missed problem, a false post, a duplicate and a severity miss are each a mismatch; regex rows match', () => {
  const label = parseLabel({
    problems: [
      { id: 'login', rows: [LOGIN], actionable: true, severity: 'major', expect: 'post' },
      { id: 'payments', rows: ['/^http\\|payments\\|/'], actionable: true, severity: 'critical', expect: 'post' },
      { id: 'crawler', rows: [CRAWLER], actionable: false, severity: 'noise', expect: 'no-post' },
    ],
  });
  const rows = [LOGIN, PAY, CRAWLER, OTHER];
  const score = (reports: EvalReport[]) => scoreLabel(label, rows, reports);
  const counts = (s: ReturnType<typeof score>) => ({ missed: s.missed, severity: s.severity, falsePosts: s.falsePosts, duplicates: s.duplicates, match: s.match });

  // As labelled: both actionable problems posted once at their severity, the crawler filed as noise.
  const good = score([R('major', [LOGIN], true), R('critical', [PAY], true), R('noise', [CRAWLER], false)]);
  assert.deepEqual(counts(good), { missed: 0, severity: 0, falsePosts: 0, duplicates: 0, match: true });
  assert.deepEqual(good.problems.map((p) => [p.id, p.reports, p.posted, p.top]), [['login', 1, 1, 'major'], ['payments', 1, 1, 'critical'], ['crawler', 1, 0, 'noise']]);
  assert.deepEqual(good.unlabelled, []);
  assert.deepEqual(good.notInRun, []);

  // Missed: login filed major but not posted (the challenger disagreed); its severity is not judged on top.
  const missed = score([R('major', [LOGIN], false), R('critical', [PAY], true), R('noise', [CRAWLER], false)]);
  assert.deepEqual(counts(missed), { missed: 1, severity: 0, falsePosts: 0, duplicates: 0, match: false });
  assert.equal(missed.problems[0]!.missed, true);
  assert.equal(missed.problems[0]!.severityMiss, undefined);

  // False posts: one on the no-post crawler problem, one on rows no problem has.
  const falsePost = score([R('major', [LOGIN], true), R('critical', [PAY], true), R('major', [CRAWLER], true), R('major', [OTHER], true, 'Search times out')]);
  assert.deepEqual(counts(falsePost), { missed: 0, severity: 0, falsePosts: 2, duplicates: 0, match: false });
  assert.equal(falsePost.problems[2]!.falsePosts, 1);
  assert.equal(falsePost.problems[2]!.severityMiss, undefined); // already a false post
  assert.deepEqual(falsePost.unlabelled, [4]);
  // A posted report that bundles a no-post problem's row with a real one: the real one is caught, the post is still false.
  const bundled = score([R('major', [LOGIN, CRAWLER], true), R('critical', [PAY], true)]);
  assert.deepEqual(counts(bundled), { missed: 0, severity: 0, falsePosts: 1, duplicates: 0, match: false });

  // Duplicate: two posted reports on login.
  const dup = score([R('major', [LOGIN], true), R('major', [LOGIN], true), R('critical', [PAY], true), R('noise', [CRAWLER], false)]);
  assert.deepEqual(counts(dup), { missed: 0, severity: 0, falsePosts: 0, duplicates: 1, match: false });
  assert.equal(dup.problems[0]!.duplicate, true);

  // Severity miss: payments posted as major, labelled critical; an unposted critical on it does not count over the post.
  const sev = score([R('major', [LOGIN], true), R('major', [PAY], true), R('critical', [PAY], false), R('noise', [CRAWLER], false)]);
  assert.deepEqual(counts(sev), { missed: 0, severity: 1, falsePosts: 0, duplicates: 0, match: false });
  assert.deepEqual([sev.problems[1]!.top, sev.problems[1]!.severityMiss], ['major', true]);
  // A no-post problem labelled noise wants a noise report: a minor one, or none, misses its severity.
  assert.equal(score([R('major', [LOGIN], true), R('critical', [PAY], true), R('minor', [CRAWLER], false)]).severity, 1);
  assert.equal(score([R('major', [LOGIN], true), R('critical', [PAY], true)]).problems[2]!.severityMiss, true);

  // Lines per problem, and the posts on no problem.
  const r = { score: falsePost, reports: [R('major', [LOGIN], true), R('critical', [PAY], true), R('major', [CRAWLER], true), R('major', [OTHER], true, 'Search times out')] } as EvalResult;
  assert.deepEqual(problemLines(r), [
    '  login (actionable, post major): 1 report(s), 1 posted, top major · ok',
    '  payments (actionable, post critical): 1 report(s), 1 posted, top critical · ok',
    '  crawler (not actionable, no-post noise): 1 report(s), 1 posted, top major · FALSE POST ×1',
    '  on no problem: major "Search times out" · FALSE POST ×1',
  ]);
  assert.deepEqual(problemLines({ ...r, score: dup }).slice(0, 1), ['  login (actionable, post major): 2 report(s), 2 posted, top major · DUPLICATE ×2']);
  assert.deepEqual(problemLines({ ...r, score: sev })[1], '  payments (actionable, post critical): 2 report(s), 1 posted, top major · SEVERITY major, label critical');
  assert.deepEqual(problemLines({ ...r, score: missed })[0], '  login (actionable, post major): 1 report(s), 0 posted, top major · MISSED');

  // A problem to post that no row of the task is: the label is wrong (inconclusive), not a miss to count.
  const elsewhere = scoreLabel(label, [LOGIN, CRAWLER], [R('major', [LOGIN], true), R('noise', [CRAWLER], false)]);
  assert.deepEqual(elsewhere.notInRun, ['payments']);
  assert.equal(elsewhere.problems[1]!.missed, undefined);
  assert.deepEqual(counts(elsewhere), { missed: 0, severity: 0, falsePosts: 0, duplicates: 0, match: false });
  assert.match(problemLines({ ...r, score: elsewhere })[1]!, /payments .*: no row of it in this run · LABEL ERROR/);

  // A row under both a problem to post and one not to (a broad no-post regex over a real problem's row): no report on it
  // can be right, so the label is wrong, not the run.
  const broad = parseLabel({
    problems: [
      { id: 'login', rows: [LOGIN], actionable: true, expect: 'post' },
      { id: 'other-http', rows: ['/^http\\|/'], actionable: false, expect: 'no-post' },
    ],
  });
  const clash = scoreLabel(broad, [LOGIN, OTHER, CRAWLER], [R('major', [LOGIN], true)]);
  assert.deepEqual(clash.conflicts, [LOGIN]);
  assert.equal(clash.match, false);
  assert.deepEqual(problemLines({ ...r, reports: [R('major', [LOGIN], true)], score: clash }).at(-1), `  under a problem to post and one not to: ${LOGIN} · LABEL ERROR (inconclusive)`);
  assert.deepEqual(good.conflicts, []);

  // The v1 form as before: one problem over the whole run, so two posts are no duplicate; a post on "no-post" is false.
  assert.equal(scoreLabel(parseLabel({ expect: 'post' }), rows, [R('major', [LOGIN], true), R('critical', [PAY], true)]).match, true);
  assert.deepEqual(counts(scoreLabel(parseLabel({ expect: 'no-post' }), rows, [R('major', [OTHER], true)])), { missed: 0, severity: 0, falsePosts: 1, duplicates: 0, match: false });
  assert.equal(scoreLabel(parseLabel({ expect: 'no-post', severity: 'minor' }), rows, [R('minor', [OTHER], false)]).match, true);
});

test('material misses: an author miss on a recorded tool or any ambiguous call is material; a new tool is not', () => {
  const recorded = new Set(['service_overview', 'log_search']);
  const call = (by: 'author' | 'challenger', tool: string) => ({ by, tool, args: {} });
  assert.equal(classifyMiss(call('author', 'service_overview'), 'miss', recorded), 'material');
  assert.equal(classifyMiss(call('challenger', 'service_overview'), 'miss', recorded), 'not material');
  assert.equal(classifyMiss(call('author', 'firing_alerts'), 'miss', recorded), 'new tool, not in recording');
  assert.equal(classifyMiss(call('challenger', 'pod_status'), 'miss', recorded), 'new tool, not in recording');
  assert.equal(classifyMiss(call('author', 'log_search'), 'ambiguous', recorded), 'material');
  assert.equal(classifyMiss(call('challenger', 'log_search'), 'ambiguous', recorded), 'material');
});

test('eval: an author miss on a tool the recording had, or an ambiguous call, makes the episode inconclusive; a new tool does not', async () => {
  const post = { expect: 'post', severity: 'major' };
  // The author asks service_overview for another window than the recorded run did.
  const elsewhere: Script = async function* (sim) {
    await sim.mcp('service_overview', { service: 'auth', minutes: 120 });
    yield* reporting('major', [LOGIN])(sim);
  };
  const a = await evalEpisode(engine(fakeSession(elsewhere, upholds)), monitor(), testConfig(), new Noise({}), episode([LOGIN], [OVERVIEW], post));
  assert.equal(a.run.status, 'ok');
  assert.deepEqual(a.material, [{ by: 'author', tool: 'service_overview', args: { service: 'auth', minutes: 120 }, how: 'miss' }]);
  assert.equal(a.inconclusive, '1 material unanswered call(s): missed service_overview (author)');
  assert.equal(a.outcome, 'inconclusive');
  assert.equal(a.score?.match, true); // what it would have scored, kept for a look
  assert.equal(evalExitCode([a]), 1);

  // The recorded run made the call twice with different results: ambiguous, material, whoever asked.
  const recording: EvidenceItem[] = [OVERVIEW, { ...OVERVIEW, id: 'E-0c0c-2', text: 'route status | now\n/login 500 | 3' }, { ...OVERVIEW, id: 'E-0c0c-3', args: { service: 'auth', minutes: 30 } }];
  const ambiguousFirst: Script = async function* (sim) {
    await sim.mcp('service_overview', { service: 'auth', minutes: 60 });
    const r = await sim.mcp('service_overview', { service: 'auth', minutes: 30 });
    await sim.mcp('submit_report', report({ rows: [LOGIN], evidence: [{ id: lastId(r.text), quote: '/login 500 | 420', claim: '420 logins failed' }] }));
    yield ok(0.2, 3);
  };
  const upholds30: Script = async function* (sim) {
    const r = await sim.mcp('service_overview', { service: 'auth', minutes: 30 });
    await sim.mcp('submit_challenge', { objections: [], items: [{ item: 1, holds: 'yes', reason: 'The counts match.', evidence: [lastId(r.text)] }], overall: 'Holds up.' });
    yield ok(0.1, 2);
  };
  const b = await evalEpisode(engine(fakeSession(ambiguousFirst, upholds30)), monitor(), testConfig(), new Noise({}), episode([LOGIN], recording, post));
  assert.equal(b.run.status, 'ok');
  assert.deepEqual(b.hits, { author: 1, challenger: 1 });
  assert.deepEqual(b.material, [{ by: 'author', tool: 'service_overview', args: { service: 'auth', minutes: 60 }, how: 'ambiguous' }]);
  assert.equal(b.inconclusive, '1 material unanswered call(s): ambiguous service_overview (author)');
  assert.equal(b.outcome, 'inconclusive');
  assert.match(evalLine(b), /label post major: inconclusive · inconclusive: 1 material unanswered call\(s\)/);

  // A tool the recording never had (one added since): listed, not material, the episode judged.
  const newTool: Script = async function* (sim) {
    await sim.mcp('promql', { query: 'sum(up{job="auth"})' });
    yield* reporting('major', [LOGIN])(sim);
  };
  const d = await evalEpisode(engine(fakeSession(newTool, upholds)), monitor(), testConfig(), new Noise({}), episode([LOGIN], [OVERVIEW], post));
  assert.deepEqual(d.newTools, ['promql']);
  assert.deepEqual(d.material, []);
  assert.equal(d.inconclusive, undefined);
  assert.equal(d.outcome, 'match');
  assert.equal(evalExitCode([d]), 0);
});

test('eval: a v2 label end to end: a post on the no-post problem is a false post, a mismatch, and the CLI exits 1', async () => {
  const rows = [LOGIN, CRAWLER];
  const label = {
    problems: [
      { id: 'login', rows: [LOGIN], actionable: true, severity: 'major', expect: 'post' },
      { id: 'crawler', rows: ['/^logs\\|crawler\\|/'], actionable: false, expect: 'no-post' },
    ],
  };
  const two: Script = async function* (sim) {
    const r = await sim.mcp('service_overview', { service: 'auth', minutes: 60 });
    const ev = [{ id: lastId(r.text), quote: '/login 500 | 420', claim: '420 logins failed' }];
    await sim.mcp('submit_report', report({ rows: [LOGIN], evidence: ev }));
    await sim.mcp('submit_report', report({ title: 'Crawler floods the sitemap', rows: [CRAWLER], evidence: ev }));
    yield ok(0.2, 3);
  };
  const both: Script = async function* (sim) {
    const r = await sim.mcp('service_overview', { service: 'auth' });
    const yes = (item: number) => ({ item, holds: 'yes', reason: 'The counts match.', evidence: [lastId(r.text)] });
    await sim.mcp('submit_challenge', { objections: [], items: [yes(1), yes(2)], overall: 'Holds up.' });
    yield ok(0.1, 2);
  };
  const res = await evalEpisode(engine(fakeSession(two, both)), monitor(), testConfig(), new Noise({}), episode(rows, [OVERVIEW], label));
  assert.deepEqual(res.reports.map((r) => [r.rows[0], r.posts]), [[LOGIN, true], [CRAWLER, true]]);
  assert.equal(res.inconclusive, undefined);
  assert.equal(res.outcome, 'mismatch');
  assert.deepEqual([res.score?.missed, res.score?.falsePosts, res.score?.duplicates, res.score?.severity], [0, 1, 0, 0]);
  assert.match(evalLine(res), /label 2 problem\(s\): MISMATCH \(1 false post\(s\)\)$/);
  assert.deepEqual(problemLines(res), [
    '  login (actionable, post major): 1 report(s), 1 posted, top major · ok',
    '  crawler (not actionable, no-post): 1 report(s), 1 posted, top major · FALSE POST ×1',
  ]);
  assert.equal(evalExitCode([res]), 1);
  assert.equal(evalTotals([res]), '1 episode(s) · labels: 0 match, 1 mismatch, 0 inconclusive · problems: 2 judged, 1 false post(s) · 2 hit(s), 0 miss(es), 0 ambiguous: 0 of 2 call(s) unanswered · $0.30');

  // The same run against a label that puts login under a no-post regex too: the label is wrong, not the run.
  const broad = { problems: [label.problems[0], { id: 'crawler', rows: ['/^(logs|http)\\|/'], actionable: false, expect: 'no-post' }] };
  const wrong = await evalEpisode(engine(fakeSession(two, both)), monitor(), testConfig(), new Noise({}), episode(rows, [OVERVIEW], broad));
  assert.equal(wrong.inconclusive, `the label puts row(s) ${LOGIN} under both a problem to post and one not to`);
  assert.equal(wrong.outcome, 'inconclusive');
  assert.equal(evalExitCode([wrong]), 1);
  // A problem to post with no row in the task: inconclusive too, and not counted as missed.
  const absent = { problems: [...label.problems, { id: 'payments', rows: [PAY], actionable: true, expect: 'post' }] };
  const off = await evalEpisode(engine(fakeSession(two, both)), monitor(), testConfig(), new Noise({}), episode(rows, [OVERVIEW], absent));
  assert.equal(off.inconclusive, "the label's problem(s) to post payments match no row of the task");
  assert.equal(off.score?.missed, 0);
  assert.equal(evalTotals([res, wrong, off]), '3 episode(s) · labels: 0 match, 1 mismatch, 2 inconclusive · problems: 2 judged, 1 false post(s) · 6 hit(s), 0 miss(es), 0 ambiguous: 0 of 6 call(s) unanswered · $0.90');
  assert.equal(evalTotals([wrong]), '1 episode(s) · labels: 0 match, 0 mismatch, 1 inconclusive · problems: 0 judged · 2 hit(s), 0 miss(es), 0 ambiguous: 0 of 2 call(s) unanswered · $0.30');
});

test('eval exit code: 1 on any mismatch, inconclusive episode or failed episode; 0 when all match or are unlabelled', () => {
  const base: EvalResult = { episode: 'ep', run: { id: 'r', status: 'ok' }, cost: 0.3, turns: 3, reports: [], hits: { author: 1, challenger: 0 }, misses: [], ambiguous: [], material: [], newTools: [] };
  assert.equal(evalExitCode([base]), 0);
  assert.equal(evalExitCode([base, { ...base, outcome: 'match' }]), 0);
  assert.equal(evalExitCode([base, { ...base, outcome: 'mismatch' }]), 1);
  assert.equal(evalExitCode([base, { ...base, inconclusive: 'the author got no recorded result', outcome: 'inconclusive' }]), 1);
  assert.equal(evalExitCode([{ ...base, inconclusive: 'the run ended error' }]), 1); // unlabelled, still says nothing
  // ...and the totals say so, or a run that exits 1 would show nothing wrong in its last line.
  assert.equal(evalTotals([{ ...base, outcome: 'match', label: { expect: 'post' } }, { ...base, inconclusive: 'the run ended error' }]), '2 episode(s) · labels: 1 match, 0 mismatch, 0 inconclusive · unlabelled: 1 inconclusive · 2 hit(s), 0 miss(es), 0 ambiguous: 0 of 2 call(s) unanswered · $0.60');
  assert.doesNotMatch(evalTotals([base]), /unlabelled/);
  assert.equal(evalExitCode([base], 1), 1);
});

test('representative $/day: the eval\'s mean $/run over runs that started, times the runs per day a detector replay counts', () => {
  const at = (cost: number, status = 'ok') => ({ cost, run: { id: 'r', status } });
  const d = costPerDay([at(0.3), at(0.5, 'no_output'), at(0, 'skipped')], 96);
  assert.deepEqual({ ...d!, perDay: Number(d!.perDay.toFixed(6)) }, { runs: 2, perRun: 0.4, runsPerDay: 96, perDay: 38.4 });
  assert.equal(costPerDay([at(0, 'skipped')], 96), undefined);
  assert.throws(() => costPerDay([at(0.3)], -1), /runs per day/);
  assert.throws(() => costPerDay([at(0.3)], Number.NaN), /runs per day/);
  const r = (cost: number): EvalResult => ({ episode: 'ep', run: { id: 'r', status: 'ok' }, cost, turns: 1, reports: [], hits: { author: 1, challenger: 0 }, misses: [], ambiguous: [], material: [], newTools: [] });
  assert.match(evalTotals([r(0.3), r(0.5)], 0, 96), / · \$0\.80 · \$0\.40\/run × 96 runs\/day = \$38\.40\/day$/);
  assert.doesNotMatch(evalTotals([r(0.3)]), /runs\/day/);
});
