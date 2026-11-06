import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { SlackError, type Transport } from '../src/output/slack.js';
import { between, bot, key, linker, schedule, setup, webhook, type SetupOptions, type World } from './world.js';

// Event sequences: whole stories over several patrols, in one world (world.ts)
// with the issue record, the outbox, the fake model and a fake Slack, as in
// production. Five families: intake, dedup, recovery, delivery, caps. They also
// play, as sequences, what single-behaviour tests pin elsewhere (kept as they
// are): patrol.test.ts "past its monthly share…", "Slack down…" and "an
// observer outage…"; visibility.test.ts "the monitor's share used up…" and
// "sources the patrol cannot read…".

const texts = (t: { sent: Array<{ text: string }> }) => t.sent.map((m) => m.text.split('\n')[0]!);
const idOf = (w: World, hours: number) => {
  const open = w.issues!.openIssues();
  assert.equal(open.length, 1, `one open issue at ${hours} h`);
  return open[0]!.id;
};
// Prometheus can be made to time out for every query, at will.
const outage = () => {
  const o = { down: false };
  return { o, blind: () => o.down };
};
// The monitor spent this much before the story starts.
const spent = (w: World, usd: number, when: string) => {
  w.monitor.engine.store.admit({ id: `earlier-${when}`, agent: 'monitor', version: 'v', trigger: 'patrol', now: new Date(when), deadlineMs: 60_000, reserve: usd, agentCap: 100, globalCap: 100 });
  w.monitor.engine.store.settle(`earlier-${when}`, { status: 'ok', cost: usd, turns: 1, outputs: 1, now: new Date(Date.parse(when) + 5 * 60_000) });
};

// ---- intake ---------------------------------------------------------------------

// As in production: news must hold a second patrol, and a 4xx jump is not urgent by itself.
const strict: Partial<Config> = { confirmPatrols: 2, urgentClientErrors: false };

test('intake: news holds a second patrol, then is investigated, challenged and posted once; a one-patrol burst never is', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40), '/v1/auth/sign-up': between(1, 1.25, 300) });
  const t = bot();
  const w = setup(t, linker(), { cfg: strict });

  const first = await w.patrol(tel, 0);
  assert.deepEqual([first.summary.send, first.summary.waiting.map((r) => r.key)], [[], [key('/v1/auth/login')]], 'once is not enough');
  assert.deepEqual([first.cards, t.sent, w.session.seen.length], [[], [], 0], 'no rows card, no post, no run');

  const confirmed = await w.patrol(tel, 0.25);
  assert.deepEqual(w.session.seen.map((s) => s.rows), [[key('/v1/auth/login')]]);
  assert.equal(confirmed.filed[0]?.action, 'opened');
  assert.equal(w.session.challenges.length, 1, 'checked before the channel sees it');
  assert.deepEqual(texts(t), ['🟠 Major: Sign-in rejects emails with a trailing space']);

  const known = await w.patrol(tel, 0.5);
  assert.deepEqual([known.summary.known.map((r) => r.key), known.investigation, t.sent.length], [[key('/v1/auth/login')], undefined, 1], 'known: no run, no post');

  // Sign-up 400s at 300 for one patrol: big, but client errors, and gone by the next.
  const burst = await w.patrol(tel, 1);
  assert.deepEqual(burst.summary.waiting.map((r) => r.key), [key('/v1/auth/sign-up')]);
  await w.patrol(tel, 1.25);
  assert.deepEqual([w.session.seen.length, t.sent.length], [1, 1], 'the burst was never news');
});

test('intake: an urgent row does not wait: the rows card goes to Slack on its first patrol, before the AI, then the report', async () => {
  const tel = schedule({ '/v1/orders 503': between(0, 40, 300) });
  const t = bot();
  const w = setup(t, (s) => ({ issue: s.issues[0]?.id ?? 'new', severity: 'critical', title: 'Orders return 503' }), { cfg: strict });
  const first = await w.patrol(tel, 0);
  assert.deepEqual(first.summary.send.map((r) => r.key), [key('/v1/orders', '503')]);
  assert.equal(first.filed[0]?.action, 'opened');
  assert.deepEqual(texts(t), ['Patrol 2026-11-02 08:00Z: 1 to look at', '🔴 Critical: Orders return 503']);
  assert.equal(w.session.challenges.length, 1, 'an urgent row is always challenged');
  await w.patrol(tel, 0.25);
  assert.equal(t.sent.length, 2, 'still firing: known, nothing more');
});

// ---- dedup ------------------------------------------------------------------------

test('dedup: the same cause on another row is a quiet reply in its thread; nothing new, no run; on the webhook the repeat is not posted', async () => {
  const story = async (transport: Transport & { sent: Array<{ text: string; thread_ts?: string | undefined; reply_broadcast?: boolean | undefined }> }) => {
    const tel = schedule({ '/v1/auth/login': between(0, 40), '/v1/ownership/transfer': between(2, 40) });
    const w = setup(transport, linker());
    assert.equal((await w.patrol(tel, 0)).filed[0]?.action, 'opened');
    const id = idOf(w, 0);
    assert.equal((await w.patrol(tel, 0.25)).investigation, undefined, 'known: no run');
    const sibling = await w.patrol(tel, 2);
    assert.equal(sibling.filed[0]?.action, 'linked');
    assert.deepEqual(w.session.seen[1]!.issues, [{ id, resolved: false }], 'the investigator was shown the open issue');
    assert.equal((await w.patrol(tel, 2.25)).investigation, undefined);
    assert.deepEqual(w.issues!.openIssues().map((i) => i.id), [id], 'one issue');
    assert.deepEqual(w.issues!.get(id)!.rows, [key('/v1/auth/login'), key('/v1/ownership/transfer')]);
    return { id, w };
  };
  const t = bot();
  const { id } = await story(t);
  assert.deepEqual(t.sent, [
    { text: '🟠 Major: Sign-in rejects emails with a trailing space' },
    { text: `🟠 Update on ${id}: Sign-in rejects emails with a trailing space`, thread_ts: '1700000000.000001', reply_broadcast: false },
  ]);
  const hook = webhook();
  await story(hook);
  assert.deepEqual(texts(hook), ['🟠 Major: Sign-in rejects emails with a trailing space'], 'no thread to reply in: the repeat says nothing new');
});

// ---- recovery ---------------------------------------------------------------------

test('recovery: back only after an hour without firing; a flicker inside the hour keeps the issue open; one note when it resolves', async () => {
  const login = (t: number) => between(0, 0.25)(t) || between(0.5, 0.75)(t);
  const tel = schedule({ '/v1/auth/login': login });
  const t = bot();
  const w = setup(t, linker(), { recoverAfterMinutes: 60 });
  await w.patrol(tel, 0);
  const id = idOf(w, 0);
  const resolvedAt: number[] = [];
  for (const h of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) if ((await w.patrol(tel, h)).resolved.length) resolvedAt.push(h);
  assert.deepEqual(resolvedAt, [1.5], 'an hour after its last firing (08:30), not after the first quiet patrol');
  assert.equal(w.session.seen.length, 1, 'the flicker was the same episode: no second run');
  assert.deepEqual(t.sent, [
    { text: '🟠 Major: Sign-in rejects emails with a trailing space' },
    { text: `✅ Back to normal at 09:30Z · quiet for 1 h · ${id} resolved: backend-production · /v1/auth/login 400`, thread_ts: '1700000000.000001', reply_broadcast: false },
  ]);
});

test('recovery: an observer outage is said once, proves no recovery (also across a restart), is back once with how long, then the issue resolves once', async () => {
  const { o, blind } = outage();
  const tel = schedule({ '/v1/auth/login': between(0, 0.25) }, { blind });
  const t = bot();
  const w = setup(t, linker(), { stateFile: true });
  await w.patrol(tel, 0);
  const id = idOf(w, 0);

  o.down = true;
  for (const h of [0.25, 0.5]) assert.deepEqual((await w.patrol(tel, h)).summary.recovered, [], 'missing observations cannot prove recovery');
  w.restart();
  const afterRestart = await w.patrol(tel, 0.75);
  assert.deepEqual([afterRestart.summary.recovered, afterRestart.resolved], [[], []]);
  assert.deepEqual(texts(t), ['🟠 Major: Sign-in rejects emails with a trailing space', '⚠️ Blind at 08:15Z: the patrol could not read 3 sources'], 'blind said once, also after a restart');

  o.down = false;
  const back = await w.patrol(tel, 1);
  assert.deepEqual([back.summary.recovered, back.resolved], [[key('/v1/auth/login')], [id]]);
  assert.deepEqual(texts(t).slice(2), ['✅ The patrol reads 3 sources again at 09:00Z, after 45 min blind', `✅ Back to normal at 09:00Z · quiet for 15 min · ${id} resolved: backend-production · /v1/auth/login 400`]);
  w.restart();
  const again = await w.patrol(tel, 1.25);
  assert.deepEqual([again.summary.recovered, again.resolved, t.sent.length], [[], [], 4], 'back once, resolved once');
});

// ---- delivery ---------------------------------------------------------------------

test('delivery: Slack down, the patrol still finishes and marks its rows; the next patrol sends what waited, in order, once', async () => {
  let down = true;
  let attempts = 0;
  const t = bot();
  const flaky: Transport = { threads: true, post: async (m) => (attempts++, down ? Promise.reject(new SlackError('Slack: HTTP 503')) : t.post(m)) };
  const tel = schedule({ '/v1/auth/login': between(0, 40, 300) }); // urgent: the rows card, then the report
  const w = setup(flaky, linker());
  const first = await w.patrol(tel, 0);
  assert.equal(first.filed[0]?.action, 'opened', 'the run went ahead');
  assert.deepEqual([t.sent, attempts], [[], 1], 'one failed try (the rows card); not tried again at the patrol end');
  assert.deepEqual(w.box.status(), [{ status: 'pending', n: 2 }]);

  down = false;
  const next = await w.patrol(tel, 0.25);
  assert.deepEqual([next.summary.send, next.investigation], [[], undefined], 'rows were marked reported despite the outage: no repeat');
  assert.deepEqual(texts(t), ['Patrol 2026-11-02 08:00Z: 1 to look at', '🟠 Major: Sign-in rejects emails with a trailing space']);
  assert.deepEqual(w.box.status(), [{ status: 'sent', n: 2 }]);
  await w.patrol(tel, 0.5);
  assert.equal(t.sent.length, 2, 'sent once');
});

test("delivery: a short Retry-After is waited out in the patrol; a long one leaves the rest for the next patrol, which sends it", async () => {
  let calls = 0;
  const t = bot();
  const limited: Transport = {
    threads: true,
    post: async (m) => {
      calls++;
      if (calls === 1) throw new SlackError('Slack: rate limited', 2);
      if (calls === 3) throw new SlackError('Slack: rate limited', 120);
      return t.post(m);
    },
  };
  const tel = schedule({ '/v1/auth/login': between(0, 40, 300) });
  const w = setup(limited, linker());
  await w.patrol(tel, 0);
  assert.deepEqual(w.sleeps, [2000], "Slack's 2 s waited out");
  assert.deepEqual(texts(t), ['Patrol 2026-11-02 08:00Z: 1 to look at'], 'the rows card went; the report waits out its 120 s');
  assert.deepEqual(w.box.status().find((s) => s.status === 'pending'), { status: 'pending', n: 1 });
  await w.patrol(tel, 0.25);
  assert.deepEqual(texts(t), ['Patrol 2026-11-02 08:00Z: 1 to look at', '🟠 Major: Sign-in rejects emails with a trailing space']);
  assert.deepEqual([w.sleeps, calls], [[2000], 4]);
});

// ---- caps -------------------------------------------------------------------------

test('caps: at the daily cap the urgent rows card still posts, the AI pauses once, rows wait; the next day one run takes them and the AI is back, said once', async () => {
  const tel = schedule({ '/v1/auth/login': between(0, 40, 300), '/v1/ownership/transfer': between(0.5, 40), '/v1/auth/signup': between(1, 40, 300) });
  const t = bot();
  const w = setup(t, linker(), { clock: true, engine: { dailyCapUsd: 10 } });
  spent(w, 8, '2026-11-02T07:00:00Z'); // $8 of $10 today: the next run can't be paid for

  const first = await w.patrol(tel, 0);
  assert.equal(first.investigation?.status, 'skipped');
  assert.deepEqual(texts(t), ['Patrol 2026-11-02 08:00Z: 1 to look at', '⏸️ AI paused: the daily AI budget across all agents ($10) is used up until 00:00 UTC']);
  assert.equal(w.session.seen.length, 0, 'no model call');

  for (const h of [0.5, 1]) assert.match((await w.patrol(tel, h)).skippedLlm ?? '', /^deferred: global daily cap \$10 reached/);
  assert.deepEqual(texts(t).slice(2), ['Patrol 2026-11-02 09:00Z: 1 to look at'], 'a new urgent row still goes out; the transfer row (not urgent) and the pause are not said again');
  assert.ok(w.state.data.rows[key('/v1/auth/login')]!.investigation?.status === 'pending' && w.state.data.rows[key('/v1/auth/login')]!.investigation?.attempts === 0, 'deferred, not an attempt');

  const nextDay = await w.patrol(tel, 16.25); // 00:15Z: a new UTC day
  assert.equal(nextDay.investigation?.status, 'ok');
  assert.deepEqual([...w.session.seen[0]!.rows].sort(), [key('/v1/auth/login'), key('/v1/auth/signup'), key('/v1/ownership/transfer')], 'every row that waited, in one run');
  assert.deepEqual(texts(t).slice(3), ['🟠 Major: Sign-in rejects emails with a trailing space', '▶️ AI investigations resumed']);
  await w.patrol(tel, 16.5);
  assert.equal(t.sent.length, 5, 'resumed once');
});

test("caps: past the monitor's monthly share it patrols as at any cap: the urgent rows card, one pause naming the share; raised, one run and one 'resumed'; the kill switch is a new hold, said once", async () => {
  const story = async (engine: SetupOptions['engine']) => {
    const tel = schedule({ '/v1/auth/login': between(0, 40, 300), '/v1/auth/signup': between(1.5, 40) });
    const t = bot();
    const w = setup(t, linker(), { clock: true, engine });
    spent(w, 8, '2026-11-01T10:00:00Z'); // the monitor has spent $8 this month
    const first = await w.patrol(tel, 0);
    return { t, w, tel, first };
  };
  const share = await story({ monthlyCapUsd: 250, agentMonthlyCapUsd: { monitor: 10 } });
  const month = await story({ monthlyCapUsd: 10 }); // what any cap did before the share existed
  assert.deepEqual([share.first.skippedLlm, month.first.skippedLlm], ['investigator skipped: agent monthly cap $10 reached', 'investigator skipped: monthly cap $10 reached']);
  assert.deepEqual(texts(share.t), ['Patrol 2026-11-02 08:00Z: 1 to look at', "⏸️ AI paused: the monitor's monthly AI budget ($10) is used up"]);
  assert.deepEqual(texts(month.t), ['Patrol 2026-11-02 08:00Z: 1 to look at', '⏸️ AI paused: the monthly AI budget across all agents ($10) is used up'], 'each pause says which cap');
  assert.deepEqual(share.t.sent[0], month.t.sent[0], 'the same rows card');
  assert.deepEqual(share.first.cards.map((f) => basename(f).slice(16)), month.first.cards.map((f) => basename(f).slice(16)));

  const { t, w, tel } = share;
  for (const h of [0.25, 0.5]) assert.match((await w.patrol(tel, h)).skippedLlm ?? '', /^deferred: agent monthly cap \$10 reached/);
  assert.equal(t.sent.length, 2, 'the same hold: nothing more');

  w.monitor.engine.agentMonthlyCapUsd = { monitor: 100 }; // the share is raised
  const lifted = await w.patrol(tel, 0.75);
  assert.equal(lifted.investigation?.status, 'ok', 'admitted: the login row was still owed');
  assert.deepEqual(texts(t).slice(2), ['🟠 Major: Sign-in rejects emails with a trailing space', '▶️ AI investigations resumed']);
  await w.patrol(tel, 1);
  assert.equal(t.sent.length, 4, 'resumed once');

  writeFileSync(w.monitor.engine.stopFile, 'test'); // a new hold, for a new row: the kill switch
  await w.patrol(tel, 1.5);
  await w.patrol(tel, 1.75);
  assert.deepEqual(texts(t).slice(4), ['⏸️ AI paused: the kill switch is on (set test); an admin clears it with resume']);
  assert.equal(w.session.seen.length, 1, 'no model call under the kill switch');
});
