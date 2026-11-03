import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { recoveredCard } from '../src/output/card.js';
import { CardSink } from '../src/output/sink.js';
import { botTransport, SlackError, SlackOutbox, webhookTransport, type Transport } from '../src/output/slack.js';

type Sent = { text: string; thread_ts?: string; reply_broadcast?: boolean };

// A bot-like transport: records posts, hands out ts values, fails on demand.
function fakeBot(fail: (n: number) => SlackError | undefined = () => undefined): Transport & { sent: Sent[] } {
  let n = 0;
  const sent: Sent[] = [];
  return {
    threads: true,
    sent,
    async post(m) {
      const err = fail(++n);
      if (err) throw err;
      sent.push({ text: m.text, ...(m.thread_ts ? { thread_ts: m.thread_ts, reply_broadcast: m.reply_broadcast } : {}) });
      return `1700000000.${String(sent.length).padStart(6, '0')}`;
    },
  };
}

const msg = (text: string) => ({ text, blocks: [] });
const clock = (start: string) => {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (min: number) => (t += min * 60_000) };
};
const outbox = (t: Transport, c = clock('2026-10-31T10:00:00Z')) => ({ box: new SlackOutbox(':memory:', t, { now: c.now, sleep: async () => {}, gapMs: 0 }), c });

test('one message per issue: later news on the same rows goes into its thread, and only older threads get it broadcast', async () => {
  const bot = fakeBot();
  const { box, c } = outbox(bot);
  box.enqueue({ kind: 'rows', keys: ['http|svc|/a|500'], broadcast: true, message: msg('urgent /a 500') });
  box.enqueue({ kind: 'report', keys: ['http|svc|/a|500'], broadcast: true, message: msg('Major: /a fails') });
  assert.deepEqual(await box.flush(), { sent: 2, pending: 0, failed: 0, skipped: 0 });
  assert.equal(bot.sent[0]!.thread_ts, undefined, 'first post opens the thread');
  assert.equal(bot.sent[1]!.thread_ts, '1700000000.000001', 'the AI report lands in it');
  assert.equal(bot.sent[1]!.reply_broadcast, false, 'same news, minutes later: not broadcast');

  c.advance(120);
  box.enqueue({ kind: 'rows', keys: ['http|svc|/a|500', 'http|svc|/b|500'], broadcast: true, message: msg('worse') });
  await box.flush();
  assert.equal(bot.sent[2]!.thread_ts, '1700000000.000001');
  assert.equal(bot.sent[2]!.reply_broadcast, true, 'news on an older thread shows in the channel too');

  c.advance(25 * 60);
  box.enqueue({ kind: 'rows', keys: ['http|svc|/b|500'], broadcast: true, message: msg('a day later') });
  await box.flush();
  assert.equal(bot.sent[3]!.thread_ts, undefined, 'after a quiet day the issue starts a new message');
});

test('a Slack failure stays queued and goes out on the next flush; a bad message fails once', async () => {
  const bot = fakeBot((n) => (n === 1 ? new SlackError('Slack: HTTP 500') : n === 3 ? new SlackError('Slack: invalid_blocks', undefined, true) : undefined));
  const { box } = outbox(bot);
  box.enqueue({ kind: 'rows', keys: ['k1'], broadcast: true, message: msg('one') });
  box.enqueue({ kind: 'rows', keys: ['k2'], broadcast: true, message: msg('two') });
  const logs: string[] = [];
  assert.deepEqual(await box.flush((s) => logs.push(s)), { sent: 0, pending: 2, failed: 0, skipped: 0 });
  assert.match(logs[0]!, /will retry: Slack: HTTP 500/);
  assert.deepEqual(await box.flush(), { sent: 1, pending: 0, failed: 1, skipped: 0 });
  assert.deepEqual(bot.sent.map((s) => s.text), ['one']);
  assert.deepEqual(box.status(), [{ status: 'failed', n: 1 }, { status: 'sent', n: 1 }]);
});

test('rate limits: a short Retry-After is waited out, a long one leaves the rest for the next patrol, and a day-old post gives up', async () => {
  const waits: number[] = [];
  let calls = 0;
  const t: Transport = {
    threads: true,
    async post() {
      calls++;
      if (calls === 1) throw new SlackError('rate limited', 2);
      if (calls === 3) throw new SlackError('rate limited', 120);
      return `ts${calls}`;
    },
  };
  const c = clock('2026-10-31T10:00:00Z');
  const box = new SlackOutbox(':memory:', t, { now: c.now, sleep: async (ms) => void waits.push(ms), gapMs: 0 });
  for (const k of ['a', 'b', 'c']) box.enqueue({ kind: 'rows', keys: [k], broadcast: true, message: msg(k) });
  assert.deepEqual(await box.flush(), { sent: 1, pending: 2, failed: 0, skipped: 0 });
  assert.ok(waits.includes(2000), 'waited the 2 s Slack asked for');
  c.advance(25 * 60);
  assert.equal((await box.flush()).failed, 2, 'posts older than a day give up instead of arriving stale');
});

test('recoveries reply only where the problem was posted, grouped per thread', async () => {
  const bot = fakeBot();
  const { box } = outbox(bot);
  box.enqueue({ kind: 'rows', keys: ['http|svc|/a|500', 'logs|svc|Queue stalled|'], broadcast: true, message: msg('urgent') });
  await box.flush();
  const groups = box.groupByThread(['http|svc|/a|500', 'logs|svc|Queue stalled|', 'http|other|/x|503']);
  assert.deepEqual(groups, [['http|svc|/a|500', 'logs|svc|Queue stalled|']], 'a row that was never posted has no thread');
  const card = recoveredCard(groups[0]!, '2026-10-31T10:30:00.000Z');
  assert.match(card.markdown, /Back to normal at 10:30Z/);
  assert.match(card.markdown, /- svc · \/a 500/);
  box.enqueue({ kind: 'recovered', keys: groups[0]!, broadcast: false, message: { text: card.text, blocks: card.blocks } });
  box.enqueue({ kind: 'recovered', keys: ['http|other|/x|503'], broadcast: false, message: msg('never posted') });
  assert.deepEqual(await box.flush(), { sent: 1, pending: 0, failed: 0, skipped: 1 });
  assert.equal(bot.sent[1]!.thread_ts, '1700000000.000001');
  assert.equal(bot.sent[1]!.reply_broadcast, false);
});

test('the webhook cannot thread: every post is top-level, as before', async () => {
  const sent: string[] = [];
  const box = new SlackOutbox(':memory:', { threads: false, post: async (m) => void sent.push(m.text) }, { sleep: async () => {}, gapMs: 0 });
  box.enqueue({ kind: 'rows', keys: ['k'], broadcast: true, message: msg('one') });
  box.enqueue({ kind: 'report', keys: ['k'], broadcast: true, message: msg('two') });
  await box.flush();
  assert.deepEqual(sent, ['one', 'two']);
  assert.deepEqual(box.groupByThread(['k']), []);
});

test('the bot calls chat.postMessage with the channel, thread and no unfurling; Slack errors map to retry or permanent', async (t) => {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  let reply: () => Response = () => Response.json({ ok: true, ts: '1.2' });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
    return reply();
  }) as typeof fetch;
  const bot = botTransport('xoxb-test', 'C0TEST123');
  assert.equal(await bot.post({ text: 't', blocks: [], thread_ts: '9.9', reply_broadcast: true }), '1.2');
  assert.equal(calls[0]!.url, 'https://slack.com/api/chat.postMessage');
  assert.equal(calls[0]!.auth, 'Bearer xoxb-test');
  assert.deepEqual(calls[0]!.body, { channel: 'C0TEST123', text: 't', blocks: [], thread_ts: '9.9', reply_broadcast: true, unfurl_links: false, unfurl_media: false });

  reply = () => new Response('', { status: 429, headers: { 'retry-after': '7' } });
  await assert.rejects(bot.post({ text: 't', blocks: [] }), (e: SlackError) => e.retryAfterSec === 7 && !e.permanent);
  reply = () => Response.json({ ok: false, error: 'invalid_blocks' });
  await assert.rejects(bot.post({ text: 't', blocks: [] }), (e: SlackError) => e.permanent);
  reply = () => Response.json({ ok: false, error: 'not_in_channel' });
  await assert.rejects(bot.post({ text: 't', blocks: [] }), (e: SlackError) => !e.permanent && /not_in_channel/.test(e.message));

  const hook = webhookTransport('https://hooks.slack.test/x');
  reply = () => new Response('invalid_blocks', { status: 400 });
  await assert.rejects(hook.post({ text: 't', blocks: [] }), (e: SlackError) => e.permanent);
});

test('the sink queues only cards meant for Slack, with their rows', async () => {
  const bot = fakeBot();
  const box = new SlackOutbox(':memory:', bot, { sleep: async () => {}, gapMs: 0 });
  const sink = new CardSink(mkdtempSync(join(tmpdir(), 'sink-')), box);
  sink.emit({ text: 'disk only', blocks: [], markdown: 'x' }, 'a');
  sink.emit({ text: 'to slack', blocks: [], markdown: 'y' }, 'b', { kind: 'rows', keys: ['k'], broadcast: true });
  await sink.flush();
  assert.deepEqual(bot.sent.map((s) => s.text), ['to slack']);
});

test('config: the bot token needs its channel id, and both are checked', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.equal(loadConfig({}).slackBotToken, undefined);
  assert.deepEqual((({ slackBotToken, slackChannel }) => ({ slackBotToken, slackChannel }))(loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_CHANNEL_ID: 'C0CBLUZLW4S' })), { slackBotToken: 'xoxb-1', slackChannel: 'C0CBLUZLW4S' });
  assert.throws(() => loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1' }), /needs SLACK_CHANNEL_ID/);
  assert.throws(() => loadConfig({ SLACK_BOT_TOKEN: 'xoxp-user-token', SLACK_CHANNEL_ID: 'C0CBLUZLW4S' }), /bot token/);
  assert.throws(() => loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_CHANNEL_ID: '#prod-monitor' }), /not a channel id/);
});

test('config: SLACK_ONCALL is one user or user-group id, rendered as its mention; unset means none', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.equal(loadConfig({}).slackOncall, undefined);
  assert.equal(loadConfig({ SLACK_ONCALL: '' }).slackOncall, undefined);
  assert.equal(loadConfig({ SLACK_ONCALL: 'U0ONCALL1' }).slackOncall, '<@U0ONCALL1>');
  assert.equal(loadConfig({ SLACK_ONCALL: ' S0ONCALL1 ' }).slackOncall, '<!subteam^S0ONCALL1>');
  for (const bad of ['<@U0ONCALL1>', '<!channel>', 'channel', 'here', '@oncall', 'C0CHANNEL1', 'u0oncall1', 'U0ONCALL1,S0ONCALL1', 'S0ONCALL1|@team'])
    assert.throws(() => loadConfig({ SLACK_ONCALL: bad }), /SLACK_ONCALL: .* is not a Slack user id \(U…\) or user-group id \(S…\)/, bad);
});

test('two senders sharing a database deliver each entry once and preserve thread order', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'outbox-')), 'engine.db');
  const sent: Sent[] = [];
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  let release!: () => void;
  const blocked = new Promise<void>(r => { release = r; });
  const transport: Transport = { threads: true, post: async m => {
    sent.push(m);
    if (sent.length === 1) { entered(); await blocked; }
    return `ts${sent.length}`;
  } };
  const a = new SlackOutbox(file, transport, { sleep: async () => {}, gapMs: 0 });
  const b = new SlackOutbox(file, transport, { sleep: async () => {}, gapMs: 0 });
  a.enqueue({ kind: 'rows', keys: ['k'], broadcast: true, message: msg('urgent') });
  a.enqueue({ kind: 'report', keys: ['k'], broadcast: true, message: msg('analysis') });
  const first = a.flush();
  await started;
  try {
    const overlap = await b.flush();
    assert.equal(overlap.sent, 0, 'another sender cannot take entries already being delivered');
    assert.equal(overlap.pending, 2);
  } finally { release(); }
  assert.equal((await first).sent, 2);
  assert.deepEqual(sent.map(s => [s.text, s.thread_ts]), [['urgent', undefined], ['analysis', 'ts1']]);
  assert.equal((await b.flush()).sent, 0);
  assert.deepEqual(b.status(), [{ status: 'sent', n: 2 }]);
});

test('an abandoned sender lease expires and its pending posts can be delivered', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'outbox-crash-')), 'engine.db');
  const bot = fakeBot();
  const c = clock('2026-10-31T10:00:00Z');
  const box = new SlackOutbox(file, bot, { now: c.now, sleep: async () => {}, gapMs: 0 });
  box.enqueue({ kind: 'rows', keys: ['k'], broadcast: true, message: msg('urgent') });
  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO slack_sender (id, owner, expires_at) VALUES (1, 'crashed', '2026-10-31T10:01:00.000Z')`).run();
  db.close();
  assert.deepEqual(await box.flush(), { sent: 0, pending: 1, failed: 0, skipped: 0 });
  c.advance(2);
  assert.deepEqual(await box.flush(), { sent: 1, pending: 0, failed: 0, skipped: 0 });
  assert.deepEqual(bot.sent.map(s => s.text), ['urgent']);
});

test('separate flushes and senders share the channel rate limit', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'outbox-gap-')), 'engine.db');
  const c = clock('2026-10-31T10:00:00Z');
  const sentAt: number[] = [];
  const t: Transport = { threads: true, post: async () => { sentAt.push(c.now().getTime()); return `ts${sentAt.length}`; } };
  const opts = { now: c.now, sleep: async (ms: number) => { c.advance(ms / 60_000); }, gapMs: 1100 };
  const first = new SlackOutbox(file, t, opts);
  const second = new SlackOutbox(file, t, opts);
  first.enqueue({ kind: 'rows', keys: ['k'], broadcast: true, message: msg('urgent') });
  await first.flush();
  second.enqueue({ kind: 'report', keys: ['k'], broadcast: true, message: msg('analysis') });
  await second.flush();
  assert.equal(sentAt[1]! - sentAt[0]!, 1100);
});

test('a failed post waits for its backoff: Retry-After holds across flushes, then 30 s and more after a second failure', async () => {
  let calls = 0;
  const c = clock('2026-10-31T10:00:00Z');
  const t: Transport = {
    threads: true,
    async post() {
      calls++;
      if (calls === 1) throw new SlackError('Slack: rate limited', 120);
      if (calls === 3 || calls === 4) throw new SlackError('Slack: HTTP 503');
      return `ts${calls}`;
    },
  };
  const box = new SlackOutbox(':memory:', t, { now: c.now, sleep: async () => {}, gapMs: 0 });
  box.enqueue({ kind: 'rows', keys: ['a'], broadcast: true, message: msg('a') });
  box.enqueue({ kind: 'report', keys: ['a'], broadcast: true, message: msg('a, analysed') });
  assert.deepEqual(await box.flush(), { sent: 0, pending: 2, failed: 0, skipped: 0 });
  c.advance(1); // a click flushes a minute later
  assert.deepEqual(await box.flush(), { sent: 0, pending: 2, failed: 0, skipped: 0 });
  assert.equal(calls, 1, "not before Slack's Retry-After, and the reply behind it waits too");
  c.advance(1.05);
  assert.deepEqual(await box.flush(), { sent: 1, pending: 1, failed: 0, skipped: 0 }); // the reply fails once (503)
  assert.deepEqual(await box.flush(), { sent: 0, pending: 1, failed: 0, skipped: 0 }); // its first retry may go at once, and fails
  assert.equal(calls, 4);
  assert.deepEqual(await box.flush(), { sent: 0, pending: 1, failed: 0, skipped: 0 });
  assert.equal(calls, 4, 'after a second failure it waits');
  c.advance(1);
  assert.deepEqual(await box.flush(), { sent: 1, pending: 0, failed: 0, skipped: 0 });
});

test('turning the buttons on keeps the destination: open threads keep their replies and queued posts go out', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'outbox-switch-')), 'engine.db');
  const updates: string[] = [];
  const bot = Object.assign(fakeBot(), { update: async (ts: string) => void updates.push(ts) });
  const before = new SlackOutbox(file, bot, { sleep: async () => {}, gapMs: 0 });
  before.enqueue({ kind: 'report', keys: ['k'], broadcast: true, issue: 'I-abcd', message: msg('new issue') });
  await before.flush();
  before.enqueue({ kind: 'rows', keys: ['k2'], broadcast: true, message: msg('queued before the switch') });
  // Socket Mode on: the same database and channel, now with buttons.
  const after = new SlackOutbox(file, bot, { sleep: async () => {}, gapMs: 0, controls: () => [{ type: 'actions', elements: [] }] });
  after.enqueue({ kind: 'report', keys: ['k'], broadcast: false, issue: 'I-abcd', repeat: true, message: msg('same cause') });
  assert.deepEqual(await after.flush(), { sent: 3, pending: 0, failed: 0, skipped: 0 });
  assert.deepEqual(bot.sent.map((s) => [s.text, s.thread_ts]), [['new issue', undefined], ['queued before the switch', undefined], ['same cause', '1700000000.000001']]);
  assert.deepEqual(updates, ['1700000000.000001'], 'the open issue gets its buttons on its first message');
  assert.deepEqual(after.status(), [{ status: 'sent', n: 4 }]);
});

test('a message update waiting for Retry-After keeps waiting when a newer click replaces it', async () => {
  const c = clock('2026-10-31T10:00:00Z');
  let updates = 0;
  const t: Transport = {
    threads: true,
    post: async () => '1700000000.000001',
    update: async () => {
      if (++updates === 1) throw new SlackError('Slack: rate limited', 120);
    },
  };
  const box = new SlackOutbox(':memory:', t, { now: c.now, sleep: async () => {}, gapMs: 0, controls: () => [{ type: 'actions', elements: [] }] });
  box.enqueue({ kind: 'report', keys: ['k'], broadcast: true, issue: 'I-abcd', message: msg('new issue, with its buttons') });
  await box.flush();
  box.updateRoot('I-abcd'); // a click
  await box.flush();
  assert.equal(updates, 1, 'rate limited for 120 s');
  box.updateRoot('I-abcd'); // another click replaces the waiting update
  await box.flush();
  assert.equal(updates, 1, "the newer update waits for Slack's Retry-After too");
  c.advance(2.1);
  assert.deepEqual(await box.flush(), { sent: 1, pending: 0, failed: 0, skipped: 0 });
  assert.equal(updates, 2);
  assert.deepEqual(box.status(), [{ status: 'sent', n: 2 }, { status: 'superseded', n: 1 }]);
});

test('posts sent before in_channel existed count for the reminder clock when they were top-level or broadcast', async () => {
  const bot = fakeBot();
  const { box, c } = outbox(bot);
  box.enqueue({ kind: 'report', keys: ['k'], broadcast: true, issue: 'I-abcd', message: msg('new issue') });
  await box.flush();
  c.advance(20 * 60);
  box.enqueue({ kind: 'report', keys: ['k'], broadcast: true, issue: 'I-abcd', message: msg('raised: shown in the channel') });
  await box.flush();
  c.advance(60);
  box.enqueue({ kind: 'report', keys: ['k'], broadcast: false, issue: 'I-abcd', repeat: true, message: msg('the same cause, quietly') });
  await box.flush();
  assert.equal(box.newsAt('I-abcd'), '2026-11-01T06:00:00.000Z');
  // The same rows as an older image left them: no in_channel.
  (box as unknown as { db: DatabaseSync }).db.exec(`UPDATE slack_outbox SET in_channel = NULL`);
  assert.equal(box.newsAt('I-abcd'), '2026-11-01T06:00:00.000Z', 'the broadcast reply counts, the quiet one does not');
});
