import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isQuiet, notificationPolicy } from '../src/output/schedule.js';
import { SlackOutbox } from '../src/output/slack.js';

const policy = () => notificationPolicy({ SLACK_QUIET_HOURS: '20:00-08:00', SLACK_TIMEZONE: 'Europe/Madrid', SLACK_QUIET_WEEKENDS: '1' })!;
const msg = (text: string) => ({ text, blocks: [] });

test('24/7 is the default; quiet hours need an explicit valid timezone and an open delivery window', () => {
  assert.equal(notificationPolicy({}), undefined);
  assert.equal(isQuiet(new Date()), false);
  for (const env of [
    { SLACK_QUIET_HOURS: '20:00-08:00' },
    { SLACK_QUIET_HOURS: '20:00-08:00', SLACK_TIMEZONE: 'Not/AZone' },
    { SLACK_QUIET_HOURS: '20:00-20:00', SLACK_TIMEZONE: 'UTC' },
  ])
    assert.throws(() => notificationPolicy(env));
});

test('timezone boundaries, weekends and the DST clock change use local calendar time', () => {
  const p = policy();
  assert.equal(isQuiet(new Date('2026-11-02T06:59:00Z'), p), true);
  assert.equal(isQuiet(new Date('2026-11-02T07:00:00Z'), p), false);
  assert.equal(isQuiet(new Date('2026-11-02T19:00:00Z'), p), true);
  assert.equal(isQuiet(new Date('2026-11-01T12:00:00Z'), p), true);
  const q = { ...p, quiet: { ...p.quiet!, weekends: false } };
  assert.equal(isQuiet(new Date('2026-10-25T00:30:00Z'), q), true);
  assert.equal(isQuiet(new Date('2026-10-25T01:30:00Z'), q), true);
  assert.equal(isQuiet(new Date('2026-10-25T07:00:00Z'), q), false);
});

test('urgent posts bypass held reports, and weekend updates survive restart into one Monday digest', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'schedule-')), 'outbox.db');
  let time = new Date('2026-10-30T21:00:00Z');
  const sent: string[] = [];
  const transport = {
    threads: true,
    async post(m: { text: string }) {
      sent.push(m.text);
      return `1700000000.${String(sent.length).padStart(6, '0')}`;
    },
  };
  const opts = { now: () => time, policy: policy(), gapMs: 0 };
  const a = new SlackOutbox(file, transport, opts);
  a.enqueue({ kind: 'report', keys: ['nonurgent'], broadcast: true, message: msg('A nonurgent report') });
  a.enqueue({ kind: 'rows', keys: ['urgent'], broadcast: true, message: msg('Urgent customer impact') });
  await a.flush();
  assert.deepEqual(sent, ['Urgent customer impact']);
  assert.equal(a.status().find((x) => x.status === 'deferred')?.n, 1);
  time = new Date('2026-11-02T07:00:00Z');
  const b = new SlackOutbox(file, transport, opts);
  await b.flush();
  assert.equal(sent.length, 2);
  assert.match(sent[1]!, /Monitoring digest/);
  assert.match(sent[1]!, /A nonurgent report/);
  assert.equal(b.status().find((x) => x.status === 'digested')?.n, 1);
  await b.flush();
  assert.equal(sent.length, 2, 'same local-day digest cannot duplicate');
});

test('daily health and degraded/restored notices persist and require distinct patrol observations', async () => {
  const sent: string[] = [];
  let time = new Date('2026-11-02T09:00:00Z');
  const p = notificationPolicy({ SLACK_DAILY_HEALTH: '1', SLACK_HEALTH_NOTICES: '1' })!;
  const box = new SlackOutbox(
    ':memory:',
    {
      threads: true,
      async post(m) {
        sent.push(m.text);
        return `1700000000.${String(sent.length).padStart(6, '0')}`;
      },
    },
    { now: () => time, policy: p, gapMs: 0 },
  );
  const bad = () => ({ at: time.toISOString(), sources: [{ source: 'http:api', ok: false }] });
  box.recordHealth(bad());
  box.recordHealth(bad());
  await box.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /Daily monitoring status/);
  time = new Date('2026-11-02T09:15:00Z');
  box.recordHealth(bad());
  await box.flush();
  assert.equal(sent.length, 2);
  assert.match(sent[1]!, /coverage degraded/);
  time = new Date('2026-11-02T09:30:00Z');
  box.recordHealth({ at: time.toISOString(), sources: [{ source: 'http:api', ok: true }] });
  await box.flush();
  assert.equal(sent.length, 3);
  assert.match(sent[2]!, /coverage restored/);
  box.recordHealth({ at: time.toISOString(), sources: [{ source: 'http:api', ok: true }] });
  await box.flush();
  assert.equal(sent.length, 3);
});
