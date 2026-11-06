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
import { evalEpisode, evalLine, evalTotals, promptOf, recordedTools, wouldPost, type Tally } from '../src/eval.js';
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
  assert.deepEqual(res.reports, [{ title: 'Login returns 500 for most users', severity: 'major', rows: [LOGIN], issue: 'new', holds: 'yes', posts: true }]);
  assert.deepEqual(res.prod, { reports: [{ title: 'Login returns 500 for most users', severity: 'major', rows: [LOGIN], issue: 'new', holds: 'yes', posts: true }], challenge: 'upheld' });
  assert.equal(res.inconclusive, undefined);
  assert.equal(res.outcome, 'match');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'eval-result.json'), 'utf8')), JSON.parse(JSON.stringify(res)));
  assert.match(evalLine(res), /: ok · reports major \(posts\) · prod major \(posts\) · 2 hit\(s\), 1 miss\(es\), 0 ambiguous: 1 of 3 call\(s\) unanswered · 5 turns · \$0\.40 · label post major: match$/);
  assert.equal(e.store.get(res.run.id)!.trigger, 'eval');

  // Without the challenger, a major report is not posted; the challenge was due, so it says nothing either way.
  const quick = await evalEpisode(engine(fakeSession(author)), monitor(), testConfig(), new Noise({}), dir, { challenge: false });
  assert.equal(quick.challenge, undefined);
  assert.equal(quick.reports[0]!.posts, false);
  assert.equal(quick.inconclusive, 'a challenge was due and was skipped');
  assert.equal(quick.outcome, 'inconclusive');
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
  assert.equal(evalTotals([res, quick, held]), '3 episode(s) · labels: 1 match, 0 mismatch, 2 inconclusive · 3 hit(s), 2 miss(es), 0 ambiguous: 2 of 5 call(s) unanswered · $0.70');
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
