import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SourceError, type Sample, type Telemetry } from '../src/clients/telemetry.js';
import type { Config } from '../src/config.js';
import { loadAgent } from '../src/engine/agent.js';
import type { Engine } from '../src/engine/run.js';
import type { Session } from '../src/engine/session.js';
import { Store } from '../src/engine/store.js';
import type { Report } from '../src/investigate/report.js';
import { CardSink } from '../src/output/sink.js';
import { SlackOutbox, type Transport } from '../src/output/slack.js';
import { Issues } from '../src/patrol/issues.js';
import { Noise } from '../src/patrol/noise.js';
import { State } from '../src/patrol/state.js';
import { patrolOnce, type MonitorAgent, type PatrolResult } from '../src/runner.js';
import { fail, fakeSession, ok } from './fake-session.js';
import { FakeTelemetry, H, testConfig } from './fake.js';

// A patrol world for event sequences: telemetry on a schedule, a fake model
// that links or not as the test decides, a fake Slack, and one engine.db for
// the issues and the outbox, as in production. Lifted from issues.test.ts
// (schedule, model, bot, webhook, setup), which keeps its own copy for now:
// another session owns that file this wave. sequence.test.ts and
// detect.test.ts play whole stories in it.

// ---- the world: legacy /v1 routes whose errors fire on a schedule -----------------

// route → errors in the window at time t. A route's errors are 400s; "route 503"
// gives that status instead.
export type Schedule = Record<string, (t: number) => number>;
export const T0 = Date.parse('2026-11-02T08:00:00Z');
export const at = (hours: number) => new Date(T0 + hours * H);
export const between = (from: number, to: number, n = 30) => (t: number) => (t >= T0 + from * H && t < T0 + to * H ? n : 0);
export const key = (route: string, status = '400') => `http|backend-production|${route}|${status}`;

// blind(t): Prometheus times out at t (every source but logs and traces, which aren't configured).
export function schedule(s: Schedule, o: { blind?: (t: number) => boolean } = {}) {
  return new FakeTelemetry((query: string, when: Date): Sample[] => {
    if (o.blind?.(when.getTime())) throw new SourceError('prometheus', 'The operation was aborted due to timeout');
    if (/^count\(kube_(pod_container_status_restarts_total|deployment_spec_replicas)\b/.test(query)) return [{ labels: {}, value: 120 }];
    if (!query.includes('backend_be_production_http_requests_total')) return [];
    const ok = new Set<string>();
    return Object.entries(s).flatMap(([name, f]) => {
      const [route = name, status = '400'] = name.split(' ');
      const healthy = ok.has(route) ? [] : [{ labels: { route, status_code: '200' }, value: 1000 }];
      ok.add(route);
      return [...healthy, { labels: { route, status_code: status }, value: f(when.getTime()) }];
    });
  });
}

// ---- the model: links or not, as the test decides ------------------------------

export interface Seen {
  prompt: string;
  rows: string[]; // the row keys the task asks it to cover
  issues: Array<{ id: string; resolved: boolean }>; // the issue list it was shown
}
export type Decide = (s: Seen) => Partial<Report> & { expectRejected?: RegExp };

export const report = (over: Partial<Report> = {}): Report => ({
  title: 'Sign-in rejects emails with a trailing space',
  severity: 'major',
  status: 'active',
  started_at: '2026-11-02T08:00:00Z',
  what_broke: 'POST /v1/auth/login returns 400 for valid accounts',
  impact: '30 failed sign-ins in 15 min',
  reach: 'many',
  cause: { hypothesis: 'email validation rejects a trailing space', confidence: 'medium' },
  evidence: [{ id: 'E-abcd-1', quote: 'x', claim: 'the route returns 400' }],
  suggested_fix: 'trim the email before validating it',
  not_checked: [],
  rows: [],
  issue: 'new',
  ...over,
});

export function parse(prompt: string): Seen {
  const rows: string[] = [];
  let inRows = false;
  for (const l of prompt.split('\n')) {
    if (l.startsWith('Row keys to cover')) inRows = true;
    else if (inRows && l.startsWith('- ')) rows.push(l.slice(2));
    else if (inRows) inRows = false;
  }
  const issues = [...prompt.matchAll(/^- (I-[0-9a-f]{4,6}) · (open|RESOLVED)/gm)].map((m) => ({ id: m[1]!, resolved: m[2] === 'RESOLVED' }));
  return { prompt, rows, issues };
}

// What the fake challenger says, given its own evidence id and the one the
// report cites: its submission, or 'fail' (it runs out of budget first).
export type Judge = (ids: { mine: string; theirs: string }) => { items?: unknown[]; objections?: unknown[]; overall?: string } | 'fail';
export const agree: Judge = () => ({ items: [{ item: 1, holds: 'yes', reason: 'The counts match the evidence.' }] });

// One fake investigation per patrol: read one tool result, cite it, submit
// one report covering every row, as decided. A challenger re-checks one tool
// result and judges as told (by default it agrees).
export function model(decide: Decide, judge: Judge = agree): Session & { seen: Seen[]; challenges: Array<{ model: string; prompt: string }> } {
  const seen: Seen[] = [];
  const challenges: Array<{ model: string; prompt: string }> = [];
  const session = (req: Parameters<Session>[0]) =>
    fakeSession(async function* (sim) {
      if (sim.req.tools.some((t) => t.name === 'submit_challenge')) {
        challenges.push({ model: sim.req.model, prompt: sim.req.prompt });
        const out = await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
        const said = judge({ mine: /evidence_id: (E-[0-9a-f]{4}-\d+)/.exec(out.text)![1]!, theirs: /"id": "(E-[0-9a-f]{4}-\d+)"/.exec(sim.req.prompt)![1]! });
        if (said === 'fail') {
          yield fail('error_max_budget_usd', 1);
          return;
        }
        await sim.mcp('submit_challenge', { objections: [], overall: 'Holds up: the counts match the evidence.', ...said });
        yield ok(0.05, 1);
        return;
      }
      const s = parse(sim.req.prompt);
      seen.push(s);
      const out = await sim.mcp('service_overview', { service: 'backend-production', minutes: 60 });
      const id = /evidence_id: (E-[0-9a-f]{4}-\d+)/.exec(out.text)![1]!;
      const quote = /^\S+ [45]\d\d \| [1-9]\d*/m.exec(out.text)![0];
      const { expectRejected, ...over } = decide(s);
      const r = await sim.mcp('submit_report', report({ evidence: [{ id, quote, claim: 'the route returns 400' }], rows: s.rows, ...over }));
      if (expectRejected) {
        assert.equal(r.isError, true);
        assert.match(r.text, expectRejected);
        const again = await sim.mcp('submit_report', report({ evidence: [{ id, quote, claim: 'the route returns 400' }], rows: s.rows, ...over, issue: 'new' }));
        assert.equal(again.isError, false, again.text);
      } else assert.equal(r.isError, false, r.text);
      yield ok(0.1, 3);
    })(req);
  return Object.assign(session, { seen, challenges });
}

// The same cause, linked whenever an issue is listed (open or resolved).
export const linker = (over: Partial<Report> = {}): Decide => (s) => ({ ...over, issue: s.issues[0]?.id ?? 'new' });

export type Sent = { text: string; thread_ts?: string | undefined; reply_broadcast?: boolean | undefined };
export function bot(): Transport & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    threads: true,
    sent,
    async post(m) {
      sent.push({ text: m.text, ...(m.thread_ts ? { thread_ts: m.thread_ts, reply_broadcast: m.reply_broadcast } : {}) });
      return `1700000000.${String(sent.length).padStart(6, '0')}`;
    },
  };
}
export function webhook(): Transport & { sent: Sent[] } {
  const sent: Sent[] = [];
  return { threads: false, sent, post: async (m) => void sent.push({ text: m.text }) };
}

export interface SetupOptions {
  issues?: boolean;
  oncall?: string | undefined;
  judge?: Judge;
  buttons?: boolean;
  recoverAfterMinutes?: number;
  cfg?: Partial<Config>;
  engine?: Partial<Engine>; // caps, say; merged into the monitor's engine
  clock?: boolean; // the engine's clock is the patrol's (caps by day and month); default: the real one
  stateFile?: boolean; // state in its file, so restart() reads it back; default: in memory
}

// A patrol world with one engine.db for the issues and the outbox, as in production.
export function setup(transport: Transport, decide: Decide, o: SetupOptions = {}) {
  const c: Config = { ...testConfig(), slackOncall: o.oncall, ...(o.recoverAfterMinutes ? { recoverAfterMinutes: o.recoverAfterMinutes } : {}), ...o.cfg };
  const db = join(c.runsDir, 'engine.db');
  const clock = { now: new Date(T0) };
  const sleeps: number[] = []; // the outbox's waits (Retry-After, the channel gap), in ms
  const box = new SlackOutbox(db, transport, { now: () => clock.now, sleep: async (ms) => void sleeps.push(ms), gapMs: 0 });
  const sink = new CardSink(c.outDir, box);
  const issues = o.issues === false ? undefined : new Issues(db);
  const session = model(decide, o.judge);
  const monitor: MonitorAgent = {
    engine: { store: new Store(db), runsDir: c.runsDir, stopFile: join(c.runsDir, 'STOP'), session, dailyCapUsd: 1000, llmAvailable: true, ...(o.clock ? { now: () => clock.now } : {}), ...o.engine },
    agent: loadAgent(join(c.agentsDir, 'monitor')),
  };
  let state = o.stateFile ? State.load(c.stateFile) : State.memory();
  const rules = { noise: new Noise({}) }; // a test may add a noise rule part way
  const logs: string[] = [];
  const patrol = async (tel: Telemetry, hours: number): Promise<PatrolResult> => {
    clock.now = at(hours);
    return patrolOnce(tel, c, rules.noise, state, sink, at(hours), { llm: true, post: true, log: (s) => logs.push(s), issues, buttons: o.buttons }, monitor);
  };
  // A restart: the state as its file has it (stateFile), the rest as it was.
  const restart = () => {
    state = State.load(c.stateFile);
  };
  return {
    c,
    db,
    box,
    issues,
    session,
    monitor,
    patrol,
    logs,
    get state() {
      return state;
    },
    rules,
    clock,
    sleeps,
    restart,
  };
}
export type World = ReturnType<typeof setup>;
