import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { decodeCursor, encodeCursor, FindingsFeed, type FeedQuery } from '../src/api/findings.js';
import { parseQuery, RateLimiter } from '../src/api/http.js';
import { ApiKeys, KEY_FORMAT } from '../src/api/keys.js';
import { redact } from '../src/engine/text.js';
import { Issues, type Filed } from '../src/patrol/issues.js';
import { SlackOutbox, slackPermalinks } from '../src/output/slack.js';

const dbFile = () => join(mkdtempSync(join(tmpdir(), 'api-')), 'engine.db');
const T0 = new Date('2026-11-05T08:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
// Obviously fake: right shape, never issued.
const FAKE_KEY = `ae_000000000000_${'x'.repeat(43)}`;
const SINCE = '2026-10-01T00:00:00.000Z'; // when the key's owner was added

test('API keys: shown once, stored as a hash, refused when wrong, revoked or expired', () => {
  const file = dbFile();
  const keys = new ApiKeys(file);
  const { key, secret } = keys.create({ name: 'lookout-ana', owner: 'ana', ownerEmail: 'Ana@starkfuture.com', ownerSince: SINCE, scopes: ['findings:read'], days: 30 }, T0);
  assert.match(secret, KEY_FORMAT);
  assert.equal(secret.split('_')[1], key.id, 'the id is part of the key');
  assert.deepEqual({ ...key }, {
    id: key.id,
    name: 'lookout-ana',
    owner: 'ana',
    owner_email: 'ana@starkfuture.com',
    owner_since: SINCE,
    scopes: ['findings:read'],
    created_at: T0.toISOString(),
    expires_at: at(30 * 24 * 60).toISOString(),
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
  });

  // Nothing in the database holds the key or its secret part.
  const raw = new DatabaseSync(file, { readOnly: true });
  const dump = JSON.stringify([raw.prepare('SELECT * FROM api_keys').all(), raw.prepare('SELECT * FROM api_key_events').all()]);
  assert.ok(!dump.includes(secret) && !dump.includes(secret.slice(16)), 'only a hash is stored');
  assert.equal(redact(`token ${secret} in a log`), 'token <secret> in a log', 'a key that leaks into text is masked');

  assert.equal(keys.verify(secret, at(1)).ok, true);
  assert.deepEqual(keys.verify(undefined), { ok: false, reason: 'missing' });
  assert.deepEqual(keys.verify('eng_not-an-api-key'), { ok: false, reason: 'malformed' });
  assert.deepEqual(keys.verify(`${secret}x`), { ok: false, reason: 'malformed' });
  assert.deepEqual(keys.verify(FAKE_KEY), { ok: false, reason: 'unknown', id: '000000000000' });
  const wrong = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
  assert.deepEqual(keys.verify(wrong), { ok: false, reason: 'unknown', id: key.id }, 'a wrong secret looks like an unknown key');
  assert.deepEqual(keys.verify(secret, at(30 * 24 * 60)), { ok: false, reason: 'expired', id: key.id });

  // last_used_at moves at most once a minute.
  keys.touch(key.id, at(2));
  keys.touch(key.id, at(2.5));
  assert.equal(keys.get(key.id)!.last_used_at, at(2).toISOString());
  keys.touch(key.id, at(3.1));
  assert.equal(keys.get(key.id)!.last_used_at, at(3.1).toISOString());

  assert.equal(keys.revoke(key.id, 'root', at(4)), 'revoked');
  assert.equal(keys.revoke(key.id, 'root', at(5)), 'already');
  assert.equal(keys.revoke('0123456789ab', 'root'), 'unknown');
  assert.deepEqual(keys.verify(secret, at(6)), { ok: false, reason: 'revoked', id: key.id });
  assert.deepEqual(
    keys.events(key.id).map((e) => [e.type, e.by]),
    [
      ['created', 'ana'],
      ['revoked', 'root'],
    ],
  );
  assert.throws(() => raw.exec(`DELETE FROM api_key_events`), /append-only|readonly/);
  const rw = new DatabaseSync(file);
  assert.throws(() => rw.exec(`UPDATE api_key_events SET by = 'x'`), /append-only/);
  assert.throws(() => rw.exec(`DELETE FROM api_key_events`), /append-only/);

  // Survives a restart: a new instance on the same file.
  assert.equal(new ApiKeys(file).verify(secret, at(6)).ok, false);
  assert.equal(new ApiKeys(file).list().length, 1);
});

test('API keys: names, scopes and lifetimes are checked; removing an owner revokes their keys', () => {
  const keys = ApiKeys.memory();
  assert.throws(() => keys.create({ name: 'Bad Name', owner: 'ana', ownerSince: SINCE, scopes: ['findings:read'], days: 1 }), /name/);
  assert.throws(() => keys.create({ name: 'ok', owner: 'ana', ownerSince: SINCE, scopes: ['findings:read'], days: 366 }), /1 to 365/);
  assert.throws(() => keys.create({ name: 'ok', owner: 'ana', ownerSince: SINCE, scopes: [], days: 1 }), /scopes/);
  assert.throws(() => keys.create({ name: 'ok', owner: 'ana', ownerSince: SINCE, scopes: ['admin' as 'findings:read'], days: 1 }), /scopes/);
  const a = keys.create({ name: 'one', owner: 'ana', ownerSince: SINCE, scopes: ['findings:read'], days: 1 });
  const b = keys.create({ name: 'two', owner: 'ana', ownerSince: SINCE, scopes: ['findings:read'], days: 1 });
  const c = keys.create({ name: 'three', owner: 'bo', ownerSince: SINCE, scopes: ['findings:read'], days: 1 });
  assert.notEqual(a.secret, b.secret);
  assert.deepEqual(keys.revokeOwnedBy('ana', 'root').sort(), [a.key.id, b.key.id].sort());
  assert.equal(keys.verify(a.secret).ok, false);
  assert.equal(keys.verify(c.secret).ok, true);
  assert.equal(keys.get(a.key.id)!.revoked_by, 'root');
  assert.equal(JSON.stringify(keys.list()).includes('sha256'), false, 'the hash never leaves the class');
});

const filed = (title: string, severity: Filed['severity'], rows: string[], run?: string, hypothesis = 'The database pool is exhausted'): Filed => ({ title, severity, rows, hypothesis, ...(run ? { run } : {}) });
const q = (o: Partial<FeedQuery> = {}): FeedQuery => ({ after: { e: 0, t: 0 }, minLevel: 'major', status: 'all', limit: 50, ...o });

test('findings feed: issues as findings, current state, services only, no raw rows', () => {
  const file = dbFile();
  const issues = new Issues(file);
  new SlackOutbox(file, { threads: true, post: async () => '1.1' }); // creates slack_issue_threads
  const a = issues.open(filed('Checkout returns 500', 'major', ['http|ecom-service-production|POST /v3/orders|500', 'logs|ecom-service-production|ERROR pool timeout|'], '20261105T080000Z-monitor-abc123'), at(0));
  const b = issues.open(filed('Sign-in fails', 'critical', ['http|keycloak|/token|503'], '20261105T081500Z-monitor-def456'), at(15));
  issues.link(a.id, filed('Checkout returns 500', 'major', ['http|backend-production|street=Main St 5|500'], '20261105T083000Z-monitor-0a1b2c', 'Orders time out waiting for a database connection'), at(30), { reopen: true });
  issues.click(b.id, 'acknowledged', 'U0ONCALL', at(31));
  const raw = new DatabaseSync(file);
  raw.prepare(`INSERT INTO slack_issue_threads (issue, ts, opened_at) VALUES (?, ?, ?)`).run(b.id, '1762330000.123456', at(15).toISOString());
  raw.prepare(`INSERT INTO slack_issue_threads (issue, ts, opened_at) VALUES (?, ?, ?)`).run(a.id, null, at(0).toISOString());

  const feed = new FindingsFeed(file);
  const page = feed.page(q(), at(40));
  assert.equal(page.more, false);
  assert.deepEqual(
    page.findings.map((f) => f.finding.id),
    [a.id, b.id],
    'oldest change first',
  );
  const [fa, fb] = page.findings;
  assert.deepEqual(fa, {
    finding: {
      id: a.id,
      level: 'major',
      status: 'open',
      title: 'Checkout returns 500',
      summary: 'Orders time out waiting for a database connection',
      services: ['backend-production', 'ecom-service-production'],
      repos: [],
      runId: '20261105T083000Z-monitor-0a1b2c',
      url: null,
      ack: null,
      at: at(30).toISOString(),
      openedAt: at(0).toISOString(),
      resolvedAt: null,
    },
    thread: null,
  });
  assert.equal(fb!.finding.level, 'critical');
  assert.equal(fb!.finding.ack, 'on_it');
  assert.equal(fb!.thread, '1762330000.123456');
  assert.doesNotMatch(JSON.stringify(page), /Main St|POST \/v3|pool timeout|U0ONCALL/, 'no subjects, rows or Slack user ids');

  // The cursor: only what changed after it.
  assert.deepEqual(feed.page(q({ after: page.next }), at(41)).findings, []);
  issues.remind(a.id, at(45), '20261105T084500Z-monitor-111111');
  issues.rowsPosted(a.id, at(45), ['http|ecom-service-production|POST /v3/orders|500']);
  issues.noteWorse(b.id, at(45), ['http|keycloak|/token|503']);
  const quiet = feed.page(q({ after: page.next }), at(46));
  assert.deepEqual(quiet.findings, [], 'reminders, rows cards and worse notes are not changes');
  assert.ok(quiet.next.e > page.next.e, 'but the cursor moves past them');
  issues.resolve(b.id, at(60));
  const resolved = feed.page(q({ after: quiet.next }), at(61));
  assert.deepEqual(
    resolved.findings.map((f) => [f.finding.id, f.finding.status, f.finding.resolvedAt, f.finding.ack]),
    [[b.id, 'resolved', at(60).toISOString(), null]],
  );

  // Filters apply to the current state.
  assert.deepEqual(
    feed.page(q({ minLevel: 'critical' }), at(61)).findings.map((f) => f.finding.id),
    [b.id],
  );
  assert.deepEqual(
    feed.page(q({ status: 'open' }), at(61)).findings.map((f) => f.finding.id),
    [a.id],
  );
  assert.deepEqual(
    feed.page(q({ status: 'resolved' }), at(61)).findings.map((f) => f.finding.id),
    [b.id],
  );
  // since (first call): changes at or after that patrol time.
  assert.deepEqual(
    feed.page(q({ since: at(30).toISOString() }), at(61)).findings.map((f) => f.finding.id),
    [a.id, b.id],
  );
  assert.deepEqual(
    feed.page(q({ since: at(50).toISOString() }), at(61)).findings.map((f) => f.finding.id),
    [b.id],
  );
  const late = feed.page(q({ since: at(90).toISOString() }), at(61));
  assert.deepEqual(late.findings, []);
  assert.deepEqual(late.next, resolved.next, 'an empty first page still starts the cursor at the end, not the beginning');
});

test('findings feed: pages never skip a change, and a muted issue says so', () => {
  const file = dbFile();
  const issues = new Issues(file);
  const ids = [0, 1, 2].map((n) => issues.open(filed(`Problem ${n}`, 'major', [`http|svc-${n}|/x|500`]), at(n)).id);
  // The first issue changes again after the others: it is listed once per page.
  issues.link(ids[0]!, filed('Problem 0', 'critical', [`http|svc-0|/x|500`]), at(5), { reopen: true });
  const feed = new FindingsFeed(file);
  const p1 = feed.page(q({ limit: 2 }), at(6));
  assert.deepEqual(
    p1.findings.map((f) => f.finding.id),
    [ids[0], ids[1]],
  );
  assert.equal(p1.findings[0]!.finding.level, 'critical', 'current state, not the state at that event');
  assert.equal(p1.more, true);
  const p2 = feed.page(q({ after: p1.next, limit: 2 }), at(6));
  assert.deepEqual(
    p2.findings.map((f) => f.finding.id),
    [ids[2], ids[0]],
    'the third issue is not skipped; the first comes again for its later change',
  );
  assert.equal(p2.more, false);

  // Not an issue: a mute, shown while it lasts.
  issues.click(ids[1]!, 'dismissed', 'U0SOMEONE', at(7));
  const muted = feed.page(q({ after: p2.next }), at(8));
  assert.deepEqual(
    muted.findings.map((f) => [f.finding.id, f.finding.ack]),
    [[ids[1], 'not_an_issue']],
  );
  assert.equal(feed.page(q({ after: p2.next }), at(8 + 8 * 24 * 60)).findings[0]!.finding.ack, null, 'a mute past its end is over');

  // Text stored before today's redaction rules is masked on the way out; odd service names are dropped.
  const raw = new DatabaseSync(file);
  raw.prepare(`UPDATE issues SET title = ? WHERE id = ?`).run('Refund failed for jane.doe@example.com', ids[2]!);
  raw.prepare(`INSERT INTO issue_rows (issue_id, row_key) VALUES (?, ?)`).run(ids[2]!, 'logs|?|x|');
  raw.prepare(`INSERT INTO issue_rows (issue_id, row_key) VALUES (?, ?)`).run(ids[2]!, 'logs|ops@example.com|x|');
  const f2 = feed.page(q(), at(9)).findings.find((f) => f.finding.id === ids[2])!.finding;
  assert.equal(f2.title, 'Refund failed for <email>');
  assert.deepEqual(f2.services, ['svc-2']);

  // A cursor past the end (the database was replaced) restarts at its end.
  const ahead = feed.page(q({ after: { e: 10_000, t: 0 } }), at(9));
  assert.deepEqual(ahead.findings, []);
  assert.ok(ahead.next.e < 10_000);
});

test('findings feed: a fresh engine with no issues yet, and one with no database', () => {
  const file = dbFile();
  new ApiKeys(file); // the database exists, the issue tables don't
  assert.deepEqual(new FindingsFeed(file).page(q()), { findings: [], next: { e: 0, t: 0 }, more: false });
  assert.throws(() => new FindingsFeed(join(mkdtempSync(join(tmpdir(), 'none-')), 'engine.db')).page(q()), /does not exist/);
});

test('findings feed: query parameters and the cursor', () => {
  const p = (s: string) => parseQuery(new URLSearchParams(s));
  assert.deepEqual(p(''), { after: { e: 0, t: 0 }, since: undefined, minLevel: 'major', status: 'all', limit: 50 });
  assert.deepEqual(p(`cursor=${encodeCursor({ e: 42, t: 3 })}&min_level=critical&status=open&limit=200`), { after: { e: 42, t: 3 }, since: undefined, minLevel: 'critical', status: 'open', limit: 200 });
  assert.deepEqual(p('since=2026-11-05T09:00:00%2B01:00'), { after: { e: 0, t: 0 }, since: '2026-11-05T08:00:00.000Z', minLevel: 'major', status: 'all', limit: 50 });
  assert.match(p('since=2026-11-05') as string, /since/);
  assert.match(p('since=yesterday') as string, /since/);
  assert.match(p(`cursor=${encodeCursor({ e: 1, t: 0 })}&since=2026-11-05T08:00:00Z`) as string, /first call only/);
  assert.match(p('cursor=bm9wZQ') as string, /cursor/);
  assert.match(p('min_level=minor') as string, /critical or major/);
  assert.match(p('min_level=info') as string, /critical or major/);
  assert.match(p('status=closed') as string, /status/);
  for (const l of ['0', '201', '-1', '1.5', 'ten']) assert.match(p(`limit=${l}`) as string, /limit/);
  assert.match(p('minLevel=major') as string, /unknown parameter "minLevel"/);
  assert.match(p('limit=1&limit=2') as string, /twice/);
  assert.deepEqual(decodeCursor(encodeCursor({ e: 7, t: 2 })), { e: 7, t: 2 });
  assert.equal(decodeCursor('v1:7.2'), undefined);
  assert.equal(decodeCursor(Buffer.from('v1:7').toString('base64url')), undefined);
});

test('rate limit: a burst, then a steady rate, per key', () => {
  const r = new RateLimiter(2, 30); // one every 2 s
  assert.equal(r.take('a', 0), 0);
  assert.equal(r.take('a', 0), 0);
  assert.equal(r.take('a', 0), 2, 'seconds until the next one');
  assert.equal(r.take('b', 0), 0, 'another key has its own bucket');
  assert.equal(r.take('a', 1000), 1);
  assert.equal(r.take('a', 2000), 0);
});

test('Slack links: the workspace address once, retried after a failure', async () => {
  let calls = 0;
  let clock = 0;
  let fail = true;
  const logged: string[] = [];
  const link = slackPermalinks(
    async () => {
      calls++;
      if (fail) throw new Error('Slack down');
      return 'https://stark.slack.com/';
    },
    'C0CBLUZLW4S',
    { clock: () => clock, log: (l) => logged.push(l) },
  );
  assert.equal(await link('1762330000.123456'), undefined);
  assert.equal(await link('1762330000.123456'), undefined);
  assert.equal(calls, 1, 'not asked again right away');
  assert.deepEqual(logged, ['Slack workspace address unknown, findings have no thread links for 10 min: Slack down']);
  fail = false;
  clock = 600_000;
  assert.equal(await link('1762330000.123456'), 'https://stark.slack.com/archives/C0CBLUZLW4S/p1762330000123456');
  assert.equal(await link('1762330001.000001'), 'https://stark.slack.com/archives/C0CBLUZLW4S/p1762330001000001');
  assert.equal(calls, 2);
  assert.equal(await link('not-a-ts'), undefined);
  const evil = slackPermalinks(async () => 'https://evil.test/', 'C0CBLUZLW4S');
  assert.equal(await evil('1762330000.123456'), undefined, 'only a Slack address');
});

test('findings feed: a Slack thread that arrives after a poll is a change; Slack controls and row keys stay out of text', () => {
  const file = dbFile();
  const issues = new Issues(file);
  new SlackOutbox(file, { threads: true, post: async () => '1.1' });
  const key = 'logs|svc-a|ERROR payment for order 123 failed|';
  const a = issues.open(filed('Payments fail <!channel> for <@U0SOMEONE1>', 'major', [key], undefined, `Rows ${key} spike since the deploy`), at(0));
  const feed = new FindingsFeed(file);
  const first = feed.page(q(), at(1));
  assert.equal(first.findings[0]!.thread, null, 'not in Slack yet');
  assert.equal(first.findings[0]!.finding.title, 'Payments fail for');
  assert.equal(first.findings[0]!.finding.summary, 'Rows <row> spike since the deploy');
  assert.deepEqual(feed.page(q({ after: first.next }), at(2)).findings, []);
  // The outbox delivers the first post: the thread is news for the feed.
  new DatabaseSync(file).prepare(`INSERT INTO slack_issue_threads (issue, ts, opened_at) VALUES (?, ?, ?)`).run(a.id, '1762330000.123456', at(2).toISOString());
  const later = feed.page(q({ after: first.next }), at(3));
  assert.deepEqual(
    later.findings.map((f) => [f.finding.id, f.thread]),
    [[a.id, '1762330000.123456']],
  );
  assert.deepEqual(feed.page(q({ after: later.next }), at(4)).findings, []);
  // Pages fill from both streams without skipping either.
  const b = issues.open(filed('Second', 'major', ['http|svc-b|/y|500']), at(5));
  const c = issues.open(filed('Third', 'major', ['http|svc-c|/z|500']), at(6));
  const raw = new DatabaseSync(file);
  raw.prepare(`INSERT INTO slack_issue_threads (issue, ts, opened_at) VALUES (?, ?, ?)`).run(b.id, '1762330001.000001', at(7).toISOString());
  raw.prepare(`INSERT INTO slack_issue_threads (issue, ts, opened_at) VALUES (?, ?, ?)`).run(c.id, '1762330002.000002', at(7).toISOString());
  const seen: string[] = [];
  let cur = later.next;
  for (let i = 0; i < 5; i++) {
    const p = feed.page(q({ after: cur, limit: 1 }), at(8));
    seen.push(...p.findings.map((f) => f.finding.id));
    cur = p.next;
    if (!p.more) break;
  }
  assert.deepEqual(seen, [b.id, c.id, b.id, c.id], 'each change once: two openings, then two threads');
});
