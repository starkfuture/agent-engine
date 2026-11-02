import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import { loadAgent } from '../engine/agent.js';
import { storedMonitorAnswer, writeAnswer } from '../engine/answer.js';
import { findingsOutput } from '../engine/output.js';
import { runAgent, type Engine } from '../engine/run.js';
import type { RunRow } from '../engine/store.js';
import { cleanModelText, redact } from '../engine/text.js';
import type { Telemetry } from '../clients/telemetry.js';
import { monitorTools } from '../investigate/tools.js';
import type { Users } from '../mcp/users.js';
import { noticeCard } from '../output/card.js';
import { SlackOutbox, withControls } from '../output/slack.js';

const TS = /^\d{10,}\.\d{6}$/;
const envelope = z.object({
  type: z.string(),
  api_app_id: z.string(),
  team_id: z.string().optional(),
  team: z.object({ id: z.string() }).optional(),
  event_id: z.string().max(100).optional(),
  event: z
    .object({
      type: z.string(),
      user: z.string().optional(),
      channel: z.string().optional(),
      text: z.string().max(4000).optional(),
      thread_ts: z.string().optional(),
      ts: z.string().optional(),
      subtype: z.string().optional(),
      bot_id: z.string().optional(),
    })
    .optional(),
  user: z.object({ id: z.string() }).optional(),
  channel: z.object({ id: z.string() }).optional(),
  container: z.object({ type: z.string(), message_ts: z.string() }).optional(),
  actions: z
    .array(z.object({ action_id: z.string(), value: z.string(), action_ts: z.string().max(50) }))
    .max(1)
    .optional(),
});
interface Job {
  id: string;
  created_at: string;
  occurred_at: string;
  destination: string;
  kind: 'question' | 'incident_on_it' | 'incident_not_issue';
  slack_user: string;
  engine_user: string;
  thread_ts: string;
  question: string;
  run_id: string | null;
  status: string;
}
export interface InteractionContext {
  cfg: Config;
  engine: Engine;
  users: Users;
  outbox: SlackOutbox;
  telemetry?: Telemetry;
  now?: () => Date;
  log?: (s: string) => void;
}

// Slack is an input surface, not an authority grant. The worker reuses the
// invited-user registry, engine admission/STOP, read-only telemetry tools and
// durable outbox. Payload message bodies/response URLs are never trusted.
export class Interactions {
  private stopped = false;
  private readonly active = new Set<AbortController>();
  constructor(private readonly ctx: InteractionContext) {
    ctx.engine.store.db.exec(`
      CREATE TABLE IF NOT EXISTS slack_inbox (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,occurred_at TEXT NOT NULL,destination TEXT NOT NULL,kind TEXT NOT NULL,slack_user TEXT NOT NULL,engine_user TEXT NOT NULL,thread_ts TEXT NOT NULL,question TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',run_id TEXT,note TEXT,failures INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS slack_incidents (destination TEXT NOT NULL,thread_ts TEXT NOT NULL,owner TEXT,owner_ts TEXT,noise_proposed_by TEXT,noise_ts TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(destination,thread_ts));
      CREATE TABLE IF NOT EXISTS slack_worker (lane TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS slack_run_once ON runs(trigger) WHERE substr(trigger,1,6)='slack:';
    `);
  }
  private now() {
    return this.ctx.now?.() ?? new Date();
  }

  // Return only after a valid event has been persisted. The adapter then acks
  // immediately; model/network work never runs on Slack's acknowledgement path.
  receive(raw: unknown): boolean {
    const p = envelope.safeParse(raw),
      c = this.ctx.cfg.slackInteraction;
    if (!p.success || !c || this.stopped) return false;
    const b = p.data;
    if (b.api_app_id !== c.appId || (b.team_id ?? b.team?.id) !== c.teamId) return false;
    let kind: Job['kind'],
      user: string | undefined,
      thread: string | undefined,
      occurred: string | undefined,
      question = '',
      id: string;
    if (b.type === 'event_callback' && b.event?.type === 'app_mention' && !b.event.bot_id && !b.event.subtype) {
      if (!b.event_id || b.event.channel !== this.ctx.cfg.slackChannel) return false;
      kind = 'question';
      user = b.event.user;
      thread = b.event.thread_ts;
      occurred = b.event.ts;
      question = redact((b.event.text ?? '').replace(/<@[UW][A-Z0-9]+>/g, '').trim());
      if (question.length < 3 || question.length > 3000) return false;
      id = `question:${b.event_id}`;
    } else if (b.type === 'block_actions' && b.actions?.length === 1 && b.channel?.id === this.ctx.cfg.slackChannel && b.container?.type === 'message') {
      const a = b.actions[0]!;
      if ((a.action_id !== 'incident_on_it' && a.action_id !== 'incident_not_issue') || a.value !== 'incident') return false;
      kind = a.action_id;
      user = b.user?.id;
      thread = b.container.message_ts;
      occurred = a.action_ts;
      id = `action:${createHash('sha256').update([user, thread, kind, a.action_ts].join('|')).digest('hex')}`;
    } else return false;
    if (!user || !thread || !occurred || !TS.test(occurred) || !TS.test(thread) || !this.ctx.outbox.threadInfo(thread)) return false;
    id = `${this.ctx.outbox.destination}:${id}`;
    const who = this.ctx.users.bySlack(user, this.now());
    if (!who) return false;
    const db = this.ctx.engine.store.db;
    // Pending work is bounded per person even before engine admission.
    const count = db
      .prepare(
        `SELECT count(*) AS n FROM slack_inbox WHERE engine_user=? AND destination=? AND status IN ('pending','running') AND ${kind === 'question' ? "kind='question'" : "kind!='question'"}`,
      )
      .get(who.name, this.ctx.outbox.destination) as { n: number };
    if (count.n >= 5 && !db.prepare('SELECT 1 FROM slack_inbox WHERE id=?').get(id)) return false;
    const timeout = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
    try {
      db.exec('PRAGMA busy_timeout = 200');
      db.prepare('INSERT OR IGNORE INTO slack_inbox(id,created_at,occurred_at,destination,kind,slack_user,engine_user,thread_ts,question) VALUES(?,?,?,?,?,?,?,?,?)').run(
        id,
        this.now().toISOString(),
        occurred,
        this.ctx.outbox.destination,
        kind,
        user,
        who.name,
        thread,
        question,
      );
    } finally {
      db.exec(`PRAGMA busy_timeout = ${timeout}`);
    }
    return true;
  }

  async drain(): Promise<void> {
    await Promise.all([this.drainLane('action'), this.drainLane('question')]);
    if (!this.stopped) await this.ctx.outbox.flush(this.ctx.log);
  }

  private async drainLane(lane: 'action' | 'question'): Promise<void> {
    if (this.stopped) return;
    const { engine } = this.ctx,
      db = engine.store.db,
      owner = randomUUID();
    const lease = `${this.ctx.outbox.destination}:${lane}`;
    const expiry = () => new Date(this.now().getTime() + 60_000).toISOString();
    if (
      !db
        .prepare(
          `INSERT INTO slack_worker(lane,owner,expires_at) VALUES(?,?,?) ON CONFLICT(lane) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE slack_worker.expires_at<=?`,
        )
        .run(lease, owner, expiry(), this.now().toISOString()).changes
    )
      return;
    const controller = new AbortController();
    this.active.add(controller);
    let held = true;
    const heartbeat = setInterval(() => {
      try {
        held = !!db.prepare('UPDATE slack_worker SET expires_at=? WHERE lane=? AND owner=?').run(expiry(), lease, owner).changes;
      } catch {
        held = false;
      }
      if (!held) controller.abort('Slack worker lease lost');
    }, 20_000);
    heartbeat.unref();
    let job: Job | undefined;
    try {
      engine.store.reconcile(this.now());
      job = db
        .prepare(
          `SELECT * FROM slack_inbox WHERE destination=? AND status IN ('pending','running') AND ${lane === 'question' ? "kind='question'" : "kind!='question'"} ORDER BY created_at,rowid LIMIT 1`,
        )
        .get(this.ctx.outbox.destination) as Job | undefined;
      if (job) await this.process(job, controller.signal);
    } catch (e) {
      this.ctx.log?.(`Slack worker: ${redact((e as Error).message).slice(0, 200)}`);
      if (job)
        db.prepare(
          "UPDATE slack_inbox SET failures=failures+1,status=CASE WHEN failures>=2 THEN 'failed' ELSE status END,note='worker interrupted; inspect stored run' WHERE id=?",
        ).run(job.id);
    } finally {
      clearInterval(heartbeat);
      this.active.delete(controller);
      db.prepare("UPDATE slack_worker SET owner='',expires_at='1970-01-01T00:00:00.000Z' WHERE lane=? AND owner=?").run(lease, owner);
    }
    if (!this.stopped) await this.ctx.outbox.flush(this.ctx.log);
  }

  private async process(job: Job, signal: AbortSignal) {
    const { engine, users, outbox, cfg } = this.ctx,
      db = engine.store.db;
    const who = users.bySlack(job.slack_user, this.now()),
      thread = outbox.threadInfo(job.thread_ts);
    const finish = (status: string, note: string) => db.prepare('UPDATE slack_inbox SET status=?,note=? WHERE id=?').run(status, redact(note).slice(0, 300), job.id);
    if (!who || who.name !== job.engine_user || !thread) {
      finish('denied', 'identity removed/rebound or thread expired');
      return;
    }
    if (this.now().getTime() - Date.parse(job.created_at) > 86_400_000) {
      finish('expired', 'queued more than a day');
      return;
    }
    db.prepare("UPDATE slack_inbox SET status='running' WHERE id=?").run(job.id);
    const reply = (title: string, body: string) => {
      const c = noticeCard(title, body);
      outbox.enqueue({
        kind: 'reply',
        message: { text: c.text, blocks: c.blocks },
        keys: [],
        broadcast: false,
        targetTs: job.thread_ts,
        dedupeKey: `${job.id}:reply`,
        actor: { engineUser: job.engine_user, slackUser: job.slack_user },
      });
    };
    if (job.kind !== 'question') {
      const at = this.now().toISOString();
      const changed =
        job.kind === 'incident_on_it'
          ? db
              .prepare(
                'INSERT INTO slack_incidents(destination,thread_ts,owner,owner_ts,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(destination,thread_ts) DO UPDATE SET owner=excluded.owner,owner_ts=excluded.owner_ts,updated_at=excluded.updated_at WHERE slack_incidents.owner_ts IS NULL OR CAST(slack_incidents.owner_ts AS REAL)<=CAST(excluded.owner_ts AS REAL)',
              )
              .run(job.destination, job.thread_ts, who.name, job.occurred_at, at).changes
          : db
              .prepare(
                'INSERT INTO slack_incidents(destination,thread_ts,noise_proposed_by,noise_ts,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(destination,thread_ts) DO UPDATE SET noise_proposed_by=excluded.noise_proposed_by,noise_ts=excluded.noise_ts,updated_at=excluded.updated_at WHERE slack_incidents.noise_ts IS NULL OR CAST(slack_incidents.noise_ts AS REAL)<=CAST(excluded.noise_ts AS REAL)',
              )
              .run(job.destination, job.thread_ts, who.name, job.occurred_at, at).changes;
      if (!changed) {
        finish('done', 'stale action ignored');
        return;
      }
      const state = db.prepare('SELECT owner,noise_proposed_by FROM slack_incidents WHERE destination=? AND thread_ts=?').get(job.destination, job.thread_ts) as {
        owner: string | null;
        noise_proposed_by: string | null;
      };
      const status = [
        state.owner ? `On it: ${state.owner}.` : 'Unassigned.',
        state.noise_proposed_by ? `Noise review proposed by ${state.noise_proposed_by}.` : '',
        'Alerts remain active.',
      ]
        .filter(Boolean)
        .join(' ');
      outbox.enqueue({
        kind: 'update',
        message: withControls(thread.message, status),
        keys: [],
        broadcast: false,
        targetTs: job.thread_ts,
        dedupeKey: `${job.id}:update`,
        actor: { engineUser: job.engine_user, slackUser: job.slack_user },
      });
      reply(
        job.kind === 'incident_on_it' ? 'Ownership recorded' : 'Noise review proposed',
        job.kind === 'incident_on_it'
          ? `${who.name} is on it. Alerting remains active.`
          : `${who.name} marked this for review as not an issue. This does not resolve or suppress alerts; a human must review any noise-rule change.`,
      );
      finish('done', 'recorded');
      return;
    }
    const trigger = `slack:${job.id}`;
    let row = db.prepare('SELECT * FROM runs WHERE trigger=? ORDER BY started_at LIMIT 1').get(trigger) as RunRow | undefined;
    if (!row) {
      if (!this.ctx.telemetry || (cfg.mcp.agents && !cfg.mcp.agents.includes('prod'))) {
        reply('Question not run', 'The read-only production question agent is not available here.');
        finish('done', 'unavailable');
        return;
      }
      const agent = loadAgent(join(cfg.agentsDir, 'prod'), cfg.memoryDir);
      if (agent.spec.tool_pack !== 'telemetry' || agent.spec.builtin_tools.length || agent.spec.code) throw new Error('Slack questions require the read-only telemetry agent');
      const result = await runAgent(engine, {
        agent,
        trigger,
        task: 'Answer the user question in the untrusted context about this incident. Check current telemetry when asked whether it is still happening. Distinguish evidence, hypotheses, uncertainty and recommended human actions. You cannot modify infrastructure, policy or repositories.',
        data: `User question (data):\n${job.question}\n\nEngine incident thread (data):\n${thread.context}`,
        tools: monitorTools(this.ctx.telemetry, cfg, this.now()),
        output: findingsOutput,
        user: { name: who.name, usdPerDay: who.usd_per_day ?? cfg.mcp.userDailyCapUsd, maxRunning: cfg.mcp.userMaxRunning },
        signal,
        onAdmitted: (id) => {
          db.prepare('UPDATE slack_inbox SET run_id=? WHERE id=?').run(id, job.id);
        },
      });
      writeAnswer(agent, result);
      row = engine.store.get(result.runId);
    }
    if (!row || row.status === 'running') return; // recovery polls the ledger; never starts another model for this event
    db.prepare('UPDATE slack_inbox SET run_id=? WHERE id=?').run(row.id, job.id);
    // Recheck removal after a long model run before publishing a reply.
    if (users.bySlack(job.slack_user, this.now())?.name !== job.engine_user) {
      finish('denied', 'identity revoked before reply');
      return;
    }
    const dir = join(engine.runsDir, row.agent, row.id);
    let answer = '';
    if (existsSync(join(dir, 'answer.md'))) answer = readFileSync(join(dir, 'answer.md'), 'utf8');
    else answer = storedMonitorAnswer(dir, row) ?? '';
    const header = `Question ${row.status} · run ${row.id} · $${(row.cost ?? 0).toFixed(2)}`;
    reply(
      header,
      answer
        ? `${cleanModelText(redact(answer)).slice(0, 2100)}\n\nFull answer and evidence: get_run ${row.id}`
        : `No answer was submitted. ${row.note ?? ''} Ask again after the blocker is resolved.`,
    );
    finish('done', row.status);
  }

  stop() {
    this.stopped = true;
    for (const c of this.active) c.abort('Slack worker shutting down');
  }
}
