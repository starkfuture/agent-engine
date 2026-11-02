import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/engine/store.js';
import type { Engine } from '../src/engine/run.js';
import { Users } from '../src/mcp/users.js';
import { SlackOutbox, type SlackMessage } from '../src/output/slack.js';
import { Interactions } from '../src/slack/interactions.js';
import { startSocket, type SocketClient } from '../src/slack/socket.js';
import { fakeSession, ok, type Script } from './fake-session.js';
import { FakeTelemetry, world } from './fake.js';

const root = '1700000000.000001';
function context(script?: Script) {
  const dir = mkdtempSync(join(tmpdir(), 'interaction-')),
    now = () => new Date('2026-11-02T12:00:00Z');
  const cfg = loadConfig({
    ENGINE_RUNS_DIR: dir,
    ENGINE_AGENTS_DIR: join(import.meta.dirname, '../agents'),
    SLACK_BOT_TOKEN: 'xoxb-fake-not-a-token',
    SLACK_CHANNEL_ID: 'C01234567',
    SLACK_APP_TOKEN: 'xapp-fake-not-a-token',
    SLACK_TEAM_ID: 'T01234567',
    SLACK_APP_ID: 'A01234567',
  });
  const engine: Engine = {
    store: new Store(join(dir, 'engine.db')),
    runsDir: dir,
    stopFile: join(dir, 'STOP'),
    session: script ? fakeSession(script) : fakeSession(),
    dailyCapUsd: 50,
    monthlyCapUsd: 300,
    llmAvailable: true,
    now,
  };
  const users = Users.load(join(dir, 'users.json'));
  users.add('ana', { slackId: 'U01234567' });
  users.add('bo', { slackId: 'U02345678' });
  const posts: Array<SlackMessage & { thread_ts?: string }> = [],
    updates: Array<SlackMessage & { ts: string }> = [];
  const outbox = new SlackOutbox(
    join(dir, 'engine.db'),
    {
      threads: true,
      async post(m) {
        posts.push(m);
        return `1700000000.${String(posts.length).padStart(6, '0')}`;
      },
      async update(ts, m) {
        updates.push({ ...m, ts });
        return ts;
      },
    },
    { now, controls: true, gapMs: 0, authorize: (actor) => users.bySlack(actor.slackUser, now())?.name === actor.engineUser },
  );
  outbox.enqueue({ kind: 'rows', keys: ['http|api|/login|500'], broadcast: true, message: { text: 'Incident from engine', blocks: [] } });
  return { cfg, engine, users, outbox, now, posts, updates, telemetry: new FakeTelemetry(world) };
}
const question = (text = 'Why is this happening?', event_id = 'Ev123') => ({
  type: 'event_callback',
  api_app_id: 'A01234567',
  team_id: 'T01234567',
  event_id,
  event: { type: 'app_mention', channel: 'C01234567', user: 'U01234567', thread_ts: root, text: `<@U0BOT12345> ${text}`, ts: '1700000001.000001' },
});
const action = (action_id = 'incident_on_it') => ({
  type: 'block_actions',
  api_app_id: 'A01234567',
  team: { id: 'T01234567' },
  channel: { id: 'C01234567' },
  user: { id: 'U01234567' },
  container: { type: 'message', message_ts: root },
  actions: [{ action_id, value: 'incident', action_ts: '1700000001.000001' }],
  message: { text: 'Untrusted replacement' },
});
const answer: Script = async function* (sim) {
  const e = await sim.mcp('service_overview', { service: 'backend-production', minutes: 15 });
  const id = /evidence_id: (E-[a-f0-9]{4}-\d+)/.exec(e.text)![1]!;
  await sim.mcp('submit_findings', {
    title: 'Current incident assessment',
    summary: 'Current telemetry is available for review.',
    findings: [{ claim: 'The service family was queried', status: 'confirmed', evidence: [{ id, quote: 'family legacy-v1' }] }],
    next_steps: ['Check the affected route'],
    not_checked: ['Customer impact is unknown'],
    lessons: [],
  });
  yield ok(0.1);
};

test('only bound identities in the configured workspace/channel and an engine thread are accepted', async () => {
  const c = context(),
    w = new Interactions(c);
  await c.outbox.flush();
  assert.equal(w.receive(question()), true);
  const variants = [
    { ...question(), team_id: 'T0WRONG00' },
    { ...question(), api_app_id: 'A0WRONG00' },
    { ...question(), event: { ...question().event, channel: 'C0WRONG00' } },
    { ...question(), event: { ...question().event, thread_ts: '1700000999.000001' } },
    { ...question(), event: { ...question().event, user: 'U0UNKNOWN0' } },
    { ...question(), event: { ...question().event, bot_id: 'B0BOT0000' } },
    { ...question(), event: { ...question().event, thread_ts: undefined } },
    { ...question(), event: { ...question().event, subtype: 'message_changed' } },
  ];
  for (const v of variants) assert.equal(w.receive(v), false);
  assert.equal(c.engine.store.db.prepare('SELECT count(*) AS n FROM slack_inbox').get()!.n, 1);
});

test('buttons record ownership and noise review, preserve the original message and never suppress alerts or invoke a model', async () => {
  let calls = 0;
  const c = context(async function* () {
    calls++;
    yield ok(0.1);
  });
  await c.outbox.flush();
  const w = new Interactions(c);
  assert.ok(JSON.stringify(c.posts[0]!.blocks).includes('incident_on_it'));
  assert.equal(w.receive(action()), true);
  await w.drain();
  assert.equal(w.receive(action('incident_not_issue')), true);
  await w.drain();
  assert.equal(calls, 0);
  assert.equal(c.updates.length, 2);
  assert.equal(c.updates[0]!.ts, root);
  assert.equal(c.updates[0]!.text, 'Incident from engine');
  assert.match(JSON.stringify(c.updates[1]!.blocks), /Noise review proposed by ana/);
  assert.ok(c.posts.some((p) => p.text.includes('does not resolve or suppress')));
  assert.ok(c.posts.slice(1).every((p) => p.thread_ts === root));
  const counts = c.outbox.status();
  assert.equal(counts.find((x) => x.status === 'sent')?.n, 5);
});

test('duplicate events and concurrent/restarted workers ask the model and deliver the answer once', async () => {
  let calls = 0;
  const c = context(async function* (s) {
    calls++;
    yield* answer(s);
  });
  await c.outbox.flush();
  const w = new Interactions(c);
  assert.equal(w.receive(question()), true);
  assert.equal(w.receive(question()), true);
  await Promise.all([w.drain(), new Interactions(c).drain()]);
  assert.equal(calls, 1);
  assert.equal(c.posts.length, 2);
  assert.match(c.posts[1]!.text, /Full answer and evidence: get_run/);
  assert.match(c.posts[1]!.text, /Customer impact is unknown/);
  assert.equal(c.posts[1]!.thread_ts, root);
  assert.equal(w.receive(question()), true);
  await new Interactions(c).drain();
  assert.equal(calls, 1);
  assert.equal(c.posts.length, 2);
  const run = c.engine.store.recent()[0]!;
  assert.equal(run.requested_by, 'ana');
  assert.equal(run.cost, 0.1);
});

test('a crash after model settlement recovers from the ledger without rerunning the model', async () => {
  let calls = 0;
  const c = context(async function* (s) {
    calls++;
    yield* answer(s);
  });
  await c.outbox.flush();
  const w = new Interactions(c);
  const enqueue = c.outbox.enqueue.bind(c.outbox);
  let fail = true;
  c.outbox.enqueue = (p) => {
    if (p.kind === 'reply' && fail) {
      fail = false;
      throw Error('disk interrupted');
    }
    return enqueue(p);
  };
  w.receive(question());
  await w.drain();
  assert.equal(calls, 1);
  assert.equal(c.posts.length, 1);
  await new Interactions(c).drain();
  assert.equal(calls, 1);
  assert.equal(c.posts.length, 2);
});

test('a slow question does not hold up ownership clicks, and spending caps still refuse new model work', async () => {
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>((r) => {
      release = r;
    }),
    entered = new Promise<void>((r) => {
      started = r;
    });
  const c = context(async function* (s) {
    started();
    await hold;
    yield* answer(s);
  });
  await c.outbox.flush();
  const w = new Interactions(c);
  w.receive(question());
  const running = w.drain();
  await entered;
  w.receive(action());
  await new Interactions(c).drain();
  assert.equal(c.updates.length, 1, 'button update must precede model completion');
  release();
  await running;
  const capped = context(answer);
  capped.engine.dailyCapUsd = 0;
  await capped.outbox.flush();
  const q = new Interactions(capped);
  q.receive(question());
  await q.drain();
  assert.equal(capped.engine.store.recent()[0]!.status, 'skipped');
  assert.equal(capped.engine.store.recent()[0]!.cost, 0);
});

test('revocation is checked before execution and again before publishing a model answer', async () => {
  const a = context();
  await a.outbox.flush();
  const w = new Interactions(a);
  w.receive(action());
  a.users.remove('ana');
  await w.drain();
  assert.equal(a.updates.length, 0);
  let c: ReturnType<typeof context>;
  c = context(async function* (s) {
    yield* answer(s);
    c.users.remove('ana');
  });
  await c.outbox.flush();
  const q = new Interactions(c);
  q.receive(question());
  await q.drain();
  assert.equal(c.posts.length, 1);
});

test('STOP/budgets are honored, queued questions are bounded and app-level secrets are redacted before storage', async () => {
  const c = context(answer);
  await c.outbox.flush();
  writeFileSync(c.engine.stopFile, 'operator stop');
  const w = new Interactions(c);
  for (let i = 0; i < 5; i++) assert.equal(w.receive(question('Check xapp-1-very-secret-value-12345', `Ev${i}`)), true);
  assert.equal(w.receive(question('Another request', 'Ev6')), false);
  assert.equal(w.receive(action()), true, 'a full question queue does not block an ownership click');
  const payloads = c.engine.store.db.prepare('SELECT question FROM slack_inbox').all();
  assert.doesNotMatch(JSON.stringify(payloads), /xapp-1-very-secret/);
  await w.drain();
  assert.equal(c.engine.store.recent()[0]!.status, 'skipped');
  assert.ok(c.posts.some((p) => p.text.includes('kill switch')));
});

test('Slack bindings never issue credentials, reject conflicts and fail closed on rebind/removal', () => {
  const c = context();
  const before = c.users.list().find((u) => u.name === 'ana')!.token_sha256;
  assert.throws(() => c.users.bindSlack('bo', 'U01234567'), /already bound/);
  assert.ok(c.users.bindSlack('ana', 'U03456789'));
  assert.equal(c.users.bySlack('U01234567'), undefined);
  assert.equal(c.users.bySlack('U03456789')?.name, 'ana');
  assert.equal(c.users.list().find((u) => u.name === 'ana')!.token_sha256, before);
  c.users.bindSlack('ana');
  assert.equal(c.users.bySlack('U03456789'), undefined);
});

test('Socket adapter persists before ack and never runs external calls with its fake client', async () => {
  const c = context();
  await c.outbox.flush();
  const handlers = new Map<string, (arg: any) => void>();
  let disconnected = false;
  const fake: SocketClient = {
    on: (event, handler) => handlers.set(event, handler),
    start: async () => {},
    disconnect: async () => {
      disconnected = true;
    },
  };
  const socket = startSocket(c, () => fake);
  await new Promise((r) => setImmediate(r));
  let acked = false;
  handlers.get('interactive')!({
    body: action(),
    ack: async () => {
      assert.equal(c.engine.store.db.prepare('SELECT count(*) AS n FROM slack_inbox').get()!.n, 1);
      acked = true;
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(acked, true);
  await socket.stop();
  assert.equal(disconnected, true);
});

test('a different Slack destination cannot read old incident context or deliver its queued replies', async () => {
  const c = context();
  await c.outbox.flush();
  c.outbox.enqueue({ kind: 'reply', message: { text: 'Private thread reply', blocks: [] }, keys: [], broadcast: false, targetTs: root, dedupeKey: 'once' });
  // A pre-feature worker selects only pending: interaction operations are
  // invisible to it, so a rollback cannot turn an update into a channel post.
  assert.equal(c.engine.store.db.prepare("SELECT count(*) AS n FROM slack_outbox WHERE status='pending'").get()!.n, 0);
  const sent: string[] = [];
  const other = new SlackOutbox(
    c.engine.store.file,
    {
      threads: true,
      async post(m) {
        sent.push(m.text);
        return root;
      },
    },
    { now: c.now, gapMs: 0, destination: 'TOTHER/COTHER' },
  );
  assert.equal(other.threadInfo(root), undefined);
  await other.flush();
  assert.deepEqual(sent, []);
  assert.equal(other.status().find((s) => s.status === 'destination_review')?.n, 1);
});

test('a delayed older ownership click cannot replace a newer owner', async () => {
  const c = context();
  await c.outbox.flush();
  const w = new Interactions(c);
  const newer = { ...action(), user: { id: 'U02345678' }, actions: [{ ...action().actions[0]!, action_ts: '1700000002.000001' }] };
  assert.ok(w.receive(newer));
  await w.drain();
  assert.ok(w.receive(action()));
  await w.drain();
  assert.equal(c.updates.length, 1);
  assert.match(JSON.stringify(c.updates[0]!.blocks), /On it: bo/);
});

test('revocation while a completed answer waits in the outbox prevents later delivery', async () => {
  const c = context(answer);
  await c.outbox.flush();
  const w = new Interactions(c),
    flush = c.outbox.flush.bind(c.outbox);
  c.outbox.flush = async () => ({ sent: 0, pending: 1, failed: 0, skipped: 0 });
  w.receive(question());
  await w.drain();
  assert.equal(c.posts.length, 1);
  c.users.remove('ana');
  c.outbox.flush = flush;
  await c.outbox.flush();
  assert.equal(c.posts.length, 1);
  assert.equal(c.outbox.status().find((s) => s.status === 'revoked')?.n, 1);
});
