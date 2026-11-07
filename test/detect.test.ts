import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RecordingTelemetry, ReplayTelemetry, type Sample, type Telemetry } from '../src/clients/telemetry.js';
import type { Config } from '../src/config.js';
import type { Session } from '../src/engine/session.js';
import { detect, detectExitCode, detectJson, detectLines, loadExpect, sectionOf, simulate, type Cover } from '../src/detect.js';
import { Noise } from '../src/patrol/noise.js';
import { State } from '../src/patrol/state.js';
import { buildSummary } from '../src/patrol/summary.js';
import { fail, fakeSession } from './fake-session.js';
import { FakeTelemetry, H, testConfig, world } from './fake.js';
import { at, between, bot, key, linker, schedule, setup } from './world.js';

// The 29 Sep world (reset and sign-up 400s from 12:00), with sign-up at a
// quarter of its size (worth a look, not urgent), and /v1/orders 404s at 20 a
// window from 10:00 to 11:00: a small problem nobody labelled.
const incident = (q: string, t: Date): Sample[] => {
  const base = world(q, t).map((x) => (x.labels.route === '/v1/auth/signup' && x.labels.status_code === '400' ? { ...x, value: Math.round(x.value / 4) } : x));
  if (!q.includes('backend_be_production_http_requests_total')) return base;
  const orders = t.getTime() >= Date.parse('2026-09-29T10:00:00Z') && t.getTime() < Date.parse('2026-09-29T11:00:00Z') ? 20 : 0;
  return [...base, { labels: { route: '/v1/orders', status_code: '200' }, value: 900 }, { labels: { route: '/v1/orders', status_code: '404' }, value: orders }];
};

// What `export` does: every patrol query in the range, into a folder, with export.json beside it.
async function record(tel: Telemetry, cfg: Config, from: string, to: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'sre-detect-'));
  const rec = new RecordingTelemetry(tel, dir);
  const state = State.memory();
  for (let t = new Date(from); t <= new Date(to); t = new Date(t.getTime() + 15 * 60_000)) await buildSummary(rec, cfg, new Noise({}), state, t);
  writeFileSync(join(dir, 'export.json'), JSON.stringify({ from, to, stepMinutes: 15, windowMinutes: 15, sources: cfg.sources }));
  return dir;
}

const RESET = 'http|backend-production|/v1/auth/password/reset|400';
const SIGNUP = 'http|backend-production|/v1/auth/signup|400';

test('detector replay: latency per labelled problem, a lost one exits 1, and a source the recording lacks is "not in recording", never a pass or a fail', async () => {
  const recCfg = { ...testConfig(), confirmPatrols: 2 };
  // Recorded without Loki and Tempo, and before an SQS error counter was patrolled.
  const dir = await record(new FakeTelemetry(incident), recCfg, '2026-09-29T09:00:00.000Z', '2026-09-29T13:00:00.000Z');
  const cfg: Config = { ...recCfg, sources: { ...recCfg.sources, error_counters: [{ id: 'sqs', selector: 'app_svc_sqs_message_errors_total', group_by: ['app', 'queue'] }] } };
  const expect = (lost: boolean) => {
    const file = join(dir, `expect-${lost}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        recordings: [
          {
            dir: '.',
            name: 'incident-0929',
            problems: [
              { id: 'reset-400', onset: '2026-09-29T11:55:00Z', rows: ['/^http\\|backend-production\\|\\/v1\\/auth\\/password\\/reset\\|4\\d\\d$/'], urgency: 'urgent' },
              { id: 'signup-400', onset: '2026-09-29T12:00:00Z', rows: [SIGNUP], urgency: 'urgent', note: 'a quarter of the size: not urgent, so it waits for the confirm patrol' },
              { id: 'sqs-errors', onset: '2026-09-29T12:00:00Z', rows: ['/^errors\\|/'], urgency: 'normal' },
              ...(lost ? [{ id: 'login-500', onset: '2026-09-29T12:30:00Z', rows: ['http|backend-production|/v1/auth/login|500'], urgency: 'normal' }] : []),
            ],
          },
          { dir: '.', name: 'quiet-0929', from: '2026-09-29T09:00:00Z', to: '2026-09-29T11:45:00Z', warmup_minutes: 30 },
        ],
      }),
    );
    return loadExpect(file);
  };

  const r = await detect(expect(true), cfg, new Noise({}));
  const [inc, quiet] = r.recordings;
  assert.deepEqual(
    inc!.problems.map((p) => [p.id, p.status, p.flaggedAt, p.latencyMin, p.urgentAt, p.aiAt, p.rows, p.urgencyMiss]),
    [
      ['reset-400', 'detected', '2026-09-29T12:00:00.000Z', 5, '2026-09-29T12:00:00.000Z', '2026-09-29T12:00:00.000Z', [RESET], undefined],
      ['signup-400', 'detected', '2026-09-29T12:15:00.000Z', 15, undefined, '2026-09-29T12:15:00.000Z', [SIGNUP], true],
      ['sqs-errors', 'not in recording', undefined, undefined, undefined, undefined, undefined, undefined],
      ['login-500', 'lost', undefined, undefined, undefined, undefined, undefined, undefined],
    ],
  );
  assert.deepEqual(inc!.problems[2]!.notInRecording, ['counter:sqs']);
  assert.equal(detectExitCode(r), 1, 'a lost labelled problem fails the replay');
  assert.deepEqual([r.totals.problems, r.totals.detected, r.totals.lost, r.totals.notInRecording, r.totals.urgencyMisses, r.totals.latencyMin], [4, 2, 1, 1, 1, { median: 10, max: 15 }]);

  // Per source: what the recording lacks, per patrol, never as healthy or failed.
  const src = Object.fromEntries(inc!.sources.map((s) => [s.source, [s.patrols, s.read, s.notInRecording, s.partlyNotInRecording, s.blind]]));
  assert.deepEqual(src, {
    'http:legacy-v1': [17, 17, 0, 0, 0],
    'counter:sqs': [17, 0, 17, 0, 0],
    workloads: [17, 17, 0, 0, 0],
    rollouts: [17, 17, 0, 0, 0],
    logs: [17, 0, 17, 0, 0],
    traces: [17, 0, 17, 0, 0],
    deploys: [17, 17, 0, 0, 0],
  });
  assert.ok(inc!.misses.prometheus > 0 && inc!.misses.loki > 0 && inc!.misses.tempo > 0);
  assert.equal(inc!.misses.total, inc!.misses.prometheus + inc!.misses.loki + inc!.misses.tempo, 'the same queries ReplayTelemetry counts');

  const lines = detectLines(r);
  assert.ok(lines.includes('  reset-400 (urgent): flagged 2026-09-29T12:00Z, 5 min after onset 2026-09-29T11:55Z · urgent 2026-09-29T12:00Z · AI run 2026-09-29T12:00Z · http|backend-production|/v1/auth/password/reset|400'), lines.join('\n'));
  assert.ok(lines.includes('  signup-400 (urgent): flagged 2026-09-29T12:15Z, 15 min after onset 2026-09-29T12:00Z · NOT URGENT (labelled urgent) · AI run 2026-09-29T12:15Z · http|backend-production|/v1/auth/signup|400'));
  assert.ok(lines.includes('  sqs-errors (normal): not in recording: counter:sqs (onset 2026-09-29T12:00Z)'));
  assert.ok(lines.includes('  login-500 (normal): LOST: no matching row flagged from onset 2026-09-29T12:30Z'));
  assert.ok(lines.includes('  not in recording: counter:sqs 17/17, logs 17/17, traces 17/17'));

  // The JSON a baseline keeps: what produced it, so a later run can tell it compares like with like.
  const json = detectJson(r, { expect: join(dir, 'expect-true.json'), build: 'c6aff21', cfg }) as { exitCode: number; build: string; expectSha256: string; config: Record<string, unknown>; recordings: Array<{ sourcesSha256: string }> };
  assert.deepEqual([json.exitCode, json.build, json.config.confirmPatrols, json.config.noiseSha256], [1, 'c6aff21', 2, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']);
  assert.match(json.expectSha256, /^[0-9a-f]{64}$/);
  assert.equal(json.recordings[0]!.sourcesSha256, json.recordings[1]!.sourcesSha256, 'the same sources');
  assert.match(json.recordings[0]!.sourcesSha256, /^[0-9a-f]{64}$/);

  // Per day. The orders 404s (10:00–11:00) wait a patrol and are flagged at
  // 10:15; reset and sign-up at 12:00 and 12:15. A run each (cover all). With no
  // row ever covered, each row is tried twice: orders again at 10:30 (still
  // firing, still owed), reset again at 12:15 with sign-up's first, and sign-up
  // again at 12:30.
  assert.deepEqual([inc!.patrols, inc!.counted, inc!.flagged, inc!.flaggedKeys, inc!.urgent, inc!.waiting, inc!.runs], [17, 17, 3, 3, 1, 2, { all: 3, none: 5, challenger: 1 }]);
  assert.deepEqual(inc!.perDay, { flagged: 16.9, runs: { all: 16.9, none: 28.2 } }, '17 patrols of 15 min: 4.25 h');
  assert.equal(inc!.control, false);

  // A control day: no problems; the warm-up patrols build state and aren't counted.
  assert.deepEqual([quiet!.control, quiet!.patrols, quiet!.counted, quiet!.countedFrom, quiet!.flagged, quiet!.runs], [true, 12, 10, '2026-09-29T09:30:00.000Z', 1, { all: 1, none: 2, challenger: 0 }]);
  assert.deepEqual(r.totals.control, { recordings: 1, days: 0.104, flaggedPerDay: 9.6, runsPerDay: { all: 9.6, none: 19.2 } });
  assert.match(lines.at(-1)!, /^detector replay: 2 recording\(s\) · 4 problem\(s\): 2 detected, 1 lost, 1 not in recording, 1 not urgent as labelled · latency median 10 min, max 15 min · control days \(1, 0\.104 d\): 9\.6 flagged rows\/day, 9\.6–19\.2 AI runs\/day$/);
  assert.ok(lines.some((l) => l.startsWith('quiet-0929 (control): 12 patrols')));

  // Without the lost one: nothing fails. "Not in recording" is not a failure.
  const ok = await detect(expect(false), cfg, new Noise({}));
  assert.deepEqual([ok.totals.lost, ok.totals.notInRecording, detectExitCode(ok)], [0, 1, 0]);
});

test('the expect file: patterns as in label.json, unique ids, an onset after the last patrol is refused', async () => {
  const dir = await record(new FakeTelemetry(incident), testConfig(), '2026-09-29T11:00:00.000Z', '2026-09-29T11:30:00.000Z');
  const write = (o: unknown) => {
    const f = join(dir, 'e.json');
    writeFileSync(f, JSON.stringify(o));
    return f;
  };
  const p = { id: 'a', onset: '2026-09-29T11:00:00Z', rows: [RESET], urgency: 'urgent' };
  assert.throws(() => loadExpect(write({ recordings: [{ dir: '.', problems: [{ ...p, rows: ['/x/i'] }] }] })), /neither a row key nor a valid \/regex\//);
  assert.throws(() => loadExpect(write({ recordings: [{ dir: '.', problems: [p, p] }] })), /problem ids must be unique/);
  assert.throws(() => loadExpect(write({ recordings: [{ dir: '.', problems: [{ ...p, urgency: 'soon' }] }] })), /urgency/);
  assert.throws(() => loadExpect(write({ recordings: [{ dir: '.' }, { dir: '.' }] })), /two recordings are named/);
  // A time without its zone would be read as the machine's local time.
  assert.throws(() => loadExpect(write({ recordings: [{ dir: '.', problems: [{ ...p, onset: '2026-09-29T11:00:00' }] }] })), /an ISO time with its zone/);
  assert.throws(() => loadExpect(write({ recordings: [{ dir: '.', to: '2026-09-29' }] })), /an ISO time with its zone/);
  assert.equal(loadExpect(write({ recordings: [{ dir: '.', problems: [{ ...p, onset: '2026-09-29T13:00:00+02:00' }] }] })).recordings[0]!.problems[0]!.onset, '2026-09-29T13:00:00+02:00');
  const late = loadExpect(write({ recordings: [{ dir: '.', problems: [{ ...p, onset: '2026-09-29T11:40:00Z' }] }] }));
  await assert.rejects(detect(late, testConfig(), new Noise({})), /onset 2026-09-29T11:40:00Z is after the last patrol of the recording \(2026-09-29T11:30:00\.000Z\)/);
  // The section, only when the pattern says for sure: anchored on it, and no alternation that could reach another.
  assert.deepEqual(
    ['http|a|b|500', '/^rollout\\|kc/', '/^\\^?x/', '/keycloak/', 'nope|x', '/http\\|keycloak\\|/', '/^http\\|a|^logs\\|b/', '/^http\\|keycloak\\|\\/(admin|token)\\|5\\d\\d$/', '/^logs\\|[a|b]/'].map(sectionOf),
    ['http', 'rollout', undefined, undefined, undefined, undefined, undefined, 'http', 'logs'],
  );

  // Production patrols once per window: a recording made at another step is refused, not replayed at its own pace.
  const fine = mkdtempSync(join(tmpdir(), 'sre-detect-'));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) copyFileSync(join(dir, f), join(fine, f));
  writeFileSync(join(fine, 'export.json'), JSON.stringify({ from: '2026-09-29T11:00:00.000Z', to: '2026-09-29T11:30:00.000Z', stepMinutes: 5, windowMinutes: 15 }));
  writeFileSync(join(fine, 'e.json'), JSON.stringify({ recordings: [{ dir: '.' }] }));
  await assert.rejects(detect(loadExpect(join(fine, 'e.json')), testConfig(), new Noise({})), /recorded every 5 min with a 15-min window; the detector replay patrols once per window/);
});

test('"sources": "export" replays a legacy recording with the sources it was recorded with', async () => {
  const old = { ...testConfig(), sources: { ...testConfig().sources, http_families: [{ id: 'legacy', selector: 'backend_be_production_http_requests_total', service: 'backend-production', route_label: 'route', status_label: 'status_code' }] } };
  const dir = await record(new FakeTelemetry(incident), old, '2026-09-29T11:45:00.000Z', '2026-09-29T12:15:00.000Z');
  const f = join(dir, 'e.json');
  const p = [{ id: 'reset', onset: '2026-09-29T12:00:00Z', rows: [RESET], urgency: 'urgent' }];
  writeFileSync(f, JSON.stringify({ recordings: [{ dir: '.', name: 'as-recorded', sources: 'export', problems: p }, { dir: '.', name: 'with-config', problems: p }] }));
  const r = await detect(loadExpect(f), testConfig(), new Noise({}));
  const [asRecorded, withConfig] = r.recordings;
  assert.equal(asRecorded!.problems[0]!.status, 'detected');
  assert.ok(asRecorded!.sources.some((s) => s.source === 'http:legacy' && s.read === 3) && !asRecorded!.sources.some((s) => s.source === 'http:legacy-v1'));
  // The config's family id differs: its queries are the same text, but its source is another name.
  assert.equal(withConfig!.problems[0]!.status, 'detected');
  assert.ok(withConfig!.sources.some((s) => s.source === 'http:legacy-v1' && s.read === 3));
  assert.notEqual(asRecorded!.sourcesSha256, withConfig!.sourcesSha256, 'other sources: not like with like');
});

test('the gate simulation starts a run exactly when the patrol does', async () => {
  // Login 30 (a look), transfer 300 (urgent) from 0.5 h, sign-up 5 (below the floor) from 1 h, all over at 2 h.
  const live = schedule({ '/v1/auth/login': between(0, 2), '/v1/ownership/transfer': between(0.5, 2, 300), '/v1/auth/signup': between(1, 2, 5) });
  const dir = mkdtempSync(join(tmpdir(), 'sre-gate-'));
  const w = setup(bot(), linker());
  const rec = new RecordingTelemetry(live, dir);
  const hours = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25];
  const patrolled: boolean[] = [];
  for (const h of hours) {
    const n = w.session.seen.length;
    await w.patrol(rec, h);
    patrolled.push(w.session.seen.length > n);
  }
  assert.deepEqual(patrolled, [true, false, true, false, false, false, false, false, false, false]);
  // The model's reports cover every row it is asked about: cover all.
  const simulated: boolean[] = [];
  for await (const p of simulate(new ReplayTelemetry(dir), w.c, new Noise({}), at(0), at(2.25), 15, 'all')) simulated.push(p.gate.run);
  assert.deepEqual(simulated, patrolled);
});

test('the gate simulation starts the same runs as the patrol with production settings: when every report covers its rows, and when none does', async () => {
  // News holds a second patrol, a 4xx jump is not urgent by itself, a row is back after an hour.
  const strict: Partial<Config> = { confirmPatrols: 2, urgentClientErrors: false, recoverAfterMinutes: 60 };
  // Login 400s at 30 (a look) from 0 h, 90 from 3 h (worse), over at 5 h. Orders 503s at 300 (urgent) from
  // 1 h to 1.5 h; again at 4 h, 3 h after its report (known); back an hour later; again at 7.5 h, past its
  // 6-hour reminder (a new episode). Sign-up 5 (below the floor) from 0.5 h to 2 h. Transfer 30 for one
  // patrol at 2.5 h (a blip).
  const live = schedule({
    '/v1/auth/login': (t) => between(0, 3)(t) || between(3, 5, 90)(t),
    '/v1/orders 503': (t) => between(1, 1.5, 300)(t) || between(4, 4.25, 300)(t) || between(7.5, 7.75, 300)(t),
    '/v1/auth/signup': between(0.5, 2, 5),
    '/v1/ownership/transfer': between(2.5, 2.75),
  });
  const hours = Array.from({ length: 33 }, (_, i) => i / 4); // 0 h to 8 h
  const story = async (cover: Cover) => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-gate-'));
    const rec = new RecordingTelemetry(live, dir);
    // all: the model's one report covers every row it is asked about. none: every run fails, covering nothing.
    const failing: Session = (req) =>
      fakeSession(async function* () {
        yield fail('error_max_budget_usd', 0.01);
      })(req);
    const w = setup(bot(), linker(), { cfg: strict, ...(cover === 'none' ? { engine: { session: failing } } : {}) });
    // What the patrol started: its log names how many rows a run covers, and the challenger the gate adds.
    const patrolled: string[] = [];
    for (const h of hours) {
      const n = w.logs.length;
      await w.patrol(rec, h);
      const started = w.logs.slice(n).find((l) => l.startsWith('investigating '));
      patrolled.push(started ? `${h} h: ${/^investigating (\d+) row/.exec(started)![1]} row(s)${started.includes('then a challenger') ? ', challenger' : ''}` : '');
    }
    const simulated: string[] = [];
    for await (const p of simulate(new ReplayTelemetry(dir), w.c, new Noise({}), at(0), at(8), 15, cover)) {
      const h = (p.at.getTime() - at(0).getTime()) / H;
      simulated.push(p.gate.run ? `${h} h: ${p.gate.pending.length} row(s)${p.gate.challenger ? ', challenger' : ''}` : '');
    }
    assert.deepEqual(simulated, patrolled, `cover ${cover}`);
    return { w, runs: patrolled.filter(Boolean) };
  };
  // The story reaches what the gate decides on: the confirm hold (login at 0.25 h, not 0 h), an urgent row
  // that doesn't wait, with its challenger (1 h), a row below the floor that rides along once owed (sign-up),
  // a blip that never runs (2.5 h), a worse row (3.25 h), a recurrence inside the reminder (4 h, none), and
  // one past it after a recovery (7.5 h).
  const all = await story('all');
  assert.deepEqual(all.runs, ['0.25 h: 1 row(s)', '1 h: 2 row(s), challenger', '3.25 h: 1 row(s)', '7.5 h: 1 row(s), challenger']);
  // No report ever covers a row: each is tried again by the next patrol (owed), then given up after two.
  const none = await story('none');
  assert.deepEqual(none.runs, ['0.25 h: 1 row(s)', '0.5 h: 1 row(s)', '1 h: 2 row(s), challenger', '1.25 h: 2 row(s), challenger', '3.25 h: 1 row(s)', '3.5 h: 1 row(s)', '7.5 h: 1 row(s), challenger']);
  assert.deepEqual(
    ['/v1/auth/login', '/v1/auth/signup'].map((r) => none.w.state.data.rows[key(r)]?.investigation?.status),
    ['gave_up', 'gave_up'],
  );
});

test('the gate simulation defers to the hourly pass exactly as the patrol does: when every report covers its rows, and when none does', async () => {
  // Production settings. Minor rows (12 client errors on routes of no likely-major family) wait for the hourly pass;
  // a checkout row is likely major; a 503 burst is urgent. Rides from 0 h; rewards from 0.25 h; profile for one patrol
  // at 0.75 h (a blip); warnings from 1.25 h (it stops at 2 h, before its pass); checkout from 1.75 h; status 503 at 2.5 h.
  const strict: Partial<Config> = { confirmPatrols: 2, urgentClientErrors: false, recoverAfterMinutes: 60 };
  const live = schedule({
    '/v1/vehicles/rides': between(0, 6, 12),
    '/v1/referral/rewards': between(0.25, 6, 12),
    '/v1/user/profile': between(0.75, 1, 12),
    '/v1/vehicles/warning-types': between(1.25, 2, 12),
    '/v1/checkout/cart': between(1.75, 6, 12),
    '/v1/vehicles/status 503': between(2.5, 2.75, 300),
  });
  const hours = Array.from({ length: 17 }, (_, i) => i / 4); // 0 h to 4 h
  const story = async (cover: Cover) => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-gate-'));
    const rec = new RecordingTelemetry(live, dir);
    const failing: Session = (req) =>
      fakeSession(async function* () {
        yield fail('error_max_budget_usd', 0.01);
      })(req);
    const w = setup(bot(), linker(), { cfg: strict, ...(cover === 'none' ? { engine: { session: failing } } : {}) });
    const patrolled: string[] = [];
    for (const h of hours) {
      const n = w.logs.length;
      await w.patrol(rec, h);
      const l = w.logs.slice(n);
      const started = l.find((x) => x.startsWith('investigating '));
      patrolled.push(started ? `${h} h: ${/^investigating (\d+) row/.exec(started)![1]} row(s)` : l.some((x) => x.includes('wait for the hourly pass')) ? `${h} h: waits` : '');
    }
    const simulated: string[] = [];
    for await (const p of simulate(new ReplayTelemetry(dir), w.c, new Noise({}), at(0), at(4), 15, cover)) {
      const h = (p.at.getTime() - at(0).getTime()) / H;
      const g = p.gate as typeof p.gate & { deferred: boolean }; // gateOf returns aiGate's whole result
      simulated.push(p.gate.run ? `${h} h: ${p.gate.pending.length} row(s)` : g.deferred ? `${h} h: waits` : '');
    }
    assert.deepEqual(simulated, patrolled, `cover ${cover}`);
    return patrolled.filter(Boolean);
  };
  // Rides is confirmed at 0.25 h and runs (no run before it). Rewards (0.5 h) waits; profile is a blip and never
  // is news; the hourly pass at 1.25 h takes rewards. Warnings (1.5 h) waits and stops firing at 2 h: it drops
  // out. Checkout is confirmed at 2 h and runs at once, 45 min after the last run. The 503 is urgent at 2.5 h: at once.
  assert.deepEqual(await story('all'), ['0.25 h: 1 row(s)', '0.5 h: waits', '0.75 h: waits', '1 h: waits', '1.25 h: 1 row(s)', '1.5 h: waits', '1.75 h: waits', '2 h: 1 row(s)', '2.5 h: 1 row(s)']);
  // No report ever covers a row: a minor row's retry waits for the hourly pass too (rides at 1.25 h, rewards with
  // checkout at 2 h), a likely-major row's comes the next patrol (checkout at 2.25 h). Two attempts each, as before.
  assert.deepEqual(await story('none'), ['0.25 h: 1 row(s)', '0.5 h: waits', '0.75 h: waits', '1 h: waits', '1.25 h: 2 row(s)', '1.5 h: waits', '1.75 h: waits', '2 h: 2 row(s)', '2.25 h: 1 row(s)', '2.5 h: 1 row(s)']);
});

test('replay --expect on the command line: exit 1 on a lost problem and 0 without; --json keeps the summary; --llm and the range flags are refused', async () => {
  const cfg = { ...testConfig(), confirmPatrols: 2 };
  const dir = await record(new FakeTelemetry(incident), cfg, '2026-09-29T11:00:00.000Z', '2026-09-29T12:30:00.000Z');
  const sources = join(dir, 'sources.yaml');
  writeFileSync(sources, JSON.stringify(cfg.sources)); // JSON is YAML
  const expect = (name: string, problems: unknown[]) => {
    const f = join(dir, `${name}.json`);
    writeFileSync(f, JSON.stringify({ recordings: [{ dir: '.', name: 'incident', problems }] }));
    return f;
  };
  const reset = { id: 'reset-400', onset: '2026-09-29T11:55:00Z', rows: [RESET], urgency: 'urgent' };
  const login = { id: 'login-500', onset: '2026-09-29T12:00:00Z', rows: ['http|backend-production|/v1/auth/login|500'], urgency: 'normal' };
  // Only what this test sets: nothing from the shell's (or a .env's) engine or patrol settings.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SRE_|PATROL_|ENGINE_|SLACK_|KEYCLOAK_|GRAFANA_|PROMETHEUS_|LOKI_|TEMPO_)/.test(k)));
  Object.assign(env, { SRE_SOURCES_FILE: sources, SRE_NOISE_FILE: join(dir, 'no-noise.yaml'), SRE_OUT_DIR: join(dir, 'out'), SRE_STATE_FILE: join(dir, 'state.json'), ENGINE_RUNS_DIR: join(dir, 'runs'), ENGINE_BUILD: 'test-build', PATROL_WINDOW_MINUTES: '15', PATROL_CONFIRM_PATROLS: '2', PATROL_URGENT_CLIENT_ERRORS: '1', PATROL_RECOVER_AFTER_MINUTES: '15', PATROL_ATTENTION_FLOOR: '10', ANTHROPIC_API_KEY: '' });
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', 'replay', ...args], { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 60_000 });

  const out = join(dir, 'summary.json');
  const lost = cli('--expect', expect('lost', [reset, login]), '--json', out);
  assert.equal(lost.status, 1, lost.stderr);
  assert.match(lost.stdout, /^ {2}login-500 \(normal\): LOST: no matching row flagged from onset 2026-09-29T12:00Z$/m);
  assert.match(lost.stdout, /^ {2}reset-400 \(urgent\): flagged 2026-09-29T12:00Z, 5 min after onset/m);
  const json = JSON.parse(readFileSync(out, 'utf8')) as { exitCode: number; build: string; totals: { lost: number; detected: number }; config: { confirmPatrols: number; sourcesFile: string } };
  assert.deepEqual([json.exitCode, json.build, json.totals.lost, json.totals.detected, json.config.confirmPatrols, json.config.sourcesFile], [1, 'test-build', 1, 1, 2, sources]);

  const ok = cli('--expect', expect('ok', [reset]));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /1 problem\(s\): 1 detected, 0 lost/);

  const llm = cli('--expect', expect('ok', [reset]), '--llm');
  assert.deepEqual([llm.status, llm.stderr.trim()], [1, 'replay --expect never runs the AI: drop --llm']);
  const range = cli('--expect', expect('ok', [reset]), '--from', '2026-09-29T11:00:00Z', '--replay', dir);
  assert.deepEqual([range.status, range.stderr.trim()], [1, 'replay --expect takes the recordings, their range and step from the expect file: drop --from, --replay']);
});
