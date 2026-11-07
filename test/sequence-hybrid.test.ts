import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { at, between, bot, key, schedule, setup, type Decide } from './world.js';

// The hybrid AI gate as a story: a likely-major row gets its AI run at once,
// any other row waits for the hourly pass, which takes every row owed in one
// run. The urgent rows card is untouched: it still posts at once.

// As in production, a 4xx jump is not urgent by itself (nor likely major). News at once.
const prod: Partial<Config> = { urgentClientErrors: false };
// Worth a look (above the attention floor), on a route of no likely-major
// family, a 4xx (no jump counts), and far from urgent: a minor row.
const MINOR = 12;
// Every report minor and new: nothing is posted, so Slack shows only code's cards.
const minor: Decide = () => ({ severity: 'minor', issue: 'new' });
const texts = (t: { sent: Array<{ text: string }> }) => t.sent.map((m) => m.text.split('\n')[0]!);

test('hybrid gate: a minor row runs when no run started in the last hour; the next waits; a likely-major row runs at once and takes it along; later minor rows wait for the hourly pass; an urgent row still posts its card at once', async () => {
  const A = '/v1/vehicles/rides';
  const B = '/v1/referral/rewards';
  const C = '/v1/checkout/cart'; // a checkout route: likely major
  const D = '/v1/vehicles/warning-types';
  const E = '/v1/user/profile';
  const F = '/v1/vehicles/status 503'; // 300 server errors: urgent
  const tel = schedule({ [A]: between(0, 40, MINOR), [B]: between(0.25, 40, MINOR), [C]: between(0.5, 40, MINOR), [D]: between(1.25, 40, MINOR), [E]: between(1.5, 40, MINOR), [F]: between(1.75, 40, 300) });
  const t = bot();
  const w = setup(t, minor, { cfg: prod, stateFile: true });
  const asked = () => w.session.seen.map((s) => [...s.rows].sort());
  const card = (r: { cards: string[] }) => readFileSync(r.cards.find((f) => f.endsWith('-rows.md'))!, 'utf8');

  // 08:00: a minor row, and no run before it: the hourly pass is due.
  await w.patrol(tel, 0);
  assert.deepEqual(asked(), [[key(A)]]);
  assert.equal(w.state.data.lastRunAt, '2026-11-02T08:00:00.000Z');

  // 08:15: another minor row, 15 min after a run: it waits, owed, with no attempt spent.
  const waits = await w.patrol(tel, 0.25);
  assert.deepEqual([waits.investigation, asked().length], [undefined, 1]);
  assert.equal(waits.skippedLlm, 'no likely-major row; the hourly pass covers it by 09:00Z');
  assert.match(card(waits), /not investigated: no likely-major row; the hourly pass covers it by 09:00Z/);
  assert.ok(w.logs.includes('1 row(s) wait for the hourly pass, due 09:00Z: none likely major, a run started at 08:00Z'));
  assert.deepEqual(w.state.data.rows[key(B)]!.investigation, { status: 'pending', attempts: 0 }, 'a deferral is not an attempt');
  assert.equal(w.state.data.lastRunAt, '2026-11-02T08:00:00.000Z');

  // A restart reads the last run back from state.json: B still waits.
  w.restart();
  assert.equal(JSON.parse(readFileSync(w.c.stateFile, 'utf8')).lastRunAt, '2026-11-02T08:00:00.000Z');

  // 08:30: a checkout row is likely major: a run at once, 30 min after the last, and B rides along.
  const likely = await w.patrol(tel, 0.5);
  assert.equal(likely.investigation?.status, 'ok');
  assert.deepEqual(asked()[1], [key(B), key(C)].sort());
  assert.deepEqual(w.state.data.rows[key(B)]!.investigation?.status, 'complete');
  assert.equal(w.state.data.lastRunAt, '2026-11-02T08:30:00.000Z', 'the hourly pass counts from the latest run');

  // 09:15: a minor row, 45 min after the 08:30 run: it waits for 09:30.
  assert.equal((await w.patrol(tel, 1.25)).skippedLlm, 'no likely-major row; the hourly pass covers it by 09:30Z');
  assert.equal(asked().length, 2);

  // 09:30: another minor row, an hour after the last run: the hourly pass takes both.
  await w.patrol(tel, 1.5);
  assert.deepEqual(asked()[2], [key(D), key(E)].sort());

  // 09:45: an urgent row, 15 min after a run: its rows card goes to Slack at once, and so does the run.
  const urgentNow = await w.patrol(tel, 1.75);
  assert.deepEqual(texts(t), ['Patrol 2026-11-02 09:45Z: 1 to look at'], 'the urgent rows card, and nothing else: no pause notice for a deferral');
  assert.deepEqual(asked()[3], [key('/v1/vehicles/status', '503')]);
  assert.equal(urgentNow.investigation?.challenge !== undefined, true, 'urgent rows are still challenged');
  assert.equal(w.session.seen.length, 4, 'four runs in seven patrols that had rows owed');
});

test('hybrid gate: a minor row that stops firing while it waits drops out: no run is spent on it', async () => {
  const A = '/v1/vehicles/rides';
  const B = '/v1/referral/rewards'; // one patrol only, at 08:15
  const tel = schedule({ [A]: between(0, 40, MINOR), [B]: between(0.25, 0.5, MINOR) });
  const w = setup(bot(), minor, { cfg: prod });
  await w.patrol(tel, 0);
  assert.equal((await w.patrol(tel, 0.25)).skippedLlm, 'no likely-major row; the hourly pass covers it by 09:00Z');
  for (const h of [0.5, 0.75, 1, 1.25]) assert.equal((await w.patrol(tel, h)).investigation, undefined, `no run at ${h} h`);
  assert.deepEqual(w.session.seen.map((s) => s.rows), [[key(A)]], 'B was never investigated');
  assert.equal(w.state.data.rows[key(B)]!.investigation, undefined, 'its owed work ended with its recovery');
  assert.ok(w.state.data.rows[key(B)]!.recoveredAt);
});

test('hybrid gate: a state file from before it (no lastRunAt) loads, and its first patrol may run', async () => {
  const w = setup(bot(), minor, { cfg: prod, stateFile: true });
  writeFileSync(w.c.stateFile, JSON.stringify({ rows: {}, notices: {} }));
  w.restart();
  await w.patrol(schedule({ '/v1/vehicles/rides': between(0, 40, MINOR) }), 0);
  assert.equal(w.session.seen.length, 1);
  assert.equal(w.state.data.lastRunAt, at(0).toISOString());
});
