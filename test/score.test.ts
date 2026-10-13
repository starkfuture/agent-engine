import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isErrorStatus, scoreErrors, scoreTraffic } from '../src/patrol/score.js';

test('below minCount is steady even when new', () => {
  assert.equal(scoreErrors({ now: 4, h1: 0, d1: 0, d7: 0 }).verdict, 'steady');
});

test('never seen in either baseline is new', () => {
  assert.equal(scoreErrors({ now: 12, h1: 0, d1: 0, d7: 0 }).verdict, 'new');
});

test('spike against the smaller baseline', () => {
  const s = scoreErrors({ now: 60, h1: 5, d1: 10, d7: 8 });
  assert.equal(s.verdict, 'spike');
  assert.equal(s.trend, 'started');
});

test('steady when matching last week', () => {
  assert.equal(scoreErrors({ now: 50, h1: 48, d1: 52, d7: 47 }).verdict, 'steady');
});

test('a one-day incident does not become its own baseline the next day', () => {
  // 29 Sep had 400 errors; 30 Sep at the same time also has 400. 7 d ago was clean.
  const s = scoreErrors({ now: 400, h1: 380, d1: 400, d7: 3 });
  assert.equal(s.verdict, 'spike');
  assert.equal(s.trend, 'ongoing');
});

test('error rate scales with traffic: twice the traffic, twice the errors is steady', () => {
  const s = scoreErrors({ now: 40, h1: 20, d1: 20, d7: 20 }, { now: 2000, h1: 1000, d1: 1000, d7: 1000 });
  assert.equal(s.verdict, 'steady');
});

test('error rate jump on flat traffic is a spike', () => {
  const s = scoreErrors({ now: 300, h1: 20, d1: 20, d7: 20 }, { now: 1000, h1: 1000, d1: 1000, d7: 1000 });
  assert.equal(s.verdict, 'spike');
});

test('traffic drop needs real baseline traffic', () => {
  assert.equal(scoreTraffic({ now: 5, h1: 100, d1: 400, d7: 380 }).verdict, 'drop');
  assert.equal(scoreTraffic({ now: 0, h1: 3, d1: 30, d7: 40 }).verdict, 'steady');
  assert.equal(scoreTraffic({ now: 300, h1: 350, d1: 400, d7: 380 }).verdict, 'steady');
});

test('error statuses', () => {
  for (const s of ['400', '401', '404', '500', '503', '0']) assert.ok(isErrorStatus(s), s);
  for (const s of ['200', '201', '204', '301', '304', '']) assert.ok(!isErrorStatus(s), s);
});
