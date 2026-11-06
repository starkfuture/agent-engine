import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { LoadedAgent } from '../engine/agent.js';
import type { RunRow, Store } from '../engine/store.js';
import { redact, truncate } from '../engine/text.js';
import { pauseText } from '../output/card.js';
import { heldNow } from '../output/notices.js';
import { deployLines, deploysHeading, type Deploys } from '../patrol/deploys.js';
import type { Issues } from '../patrol/issues.js';
import { ATTEMPTS, State, type StateData } from '../patrol/state.js';
import type { Summary } from '../patrol/summary.js';
import type { SourceHealth } from '../patrol/types.js';
import type { McpContext } from './server.js';
import type { User } from './users.js';

// The `status` tool: is the patrol running, what is open, what can't it see,
// what was deployed, is the AI paused. Code only, from the last patrol's file,
// the patrol's state, the issue record and the ledger: no AI run, no cost.

export const STATUS_TOOL = {
  description:
    'Instant patrol status, from the last patrol: whether the patrol is running (STALE if not), whether the AI is paused and why, the last monitor run, open issues, what the last patrol found, each source as ok, degraded, unknown, blind or off, recent deploys, and spend against the caps. Read-only: no AI run, no cost.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
};

// Whether members see how many rows noise rules dropped; admins always do.
const NOISE_FOR_MEMBERS = false;

const MAX = 9000; // the cap on one tool result elsewhere (evidence.ts)
const MAX_ISSUES = 10; // open, and resolved, each
const MAX_DEPLOYS = 12;
const MAX_GAVE_UP = 5;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

// The spend tool's lines: today and this month against the caps, the
// monitor's monthly share, the caller's own, by agent, and the kill switch.
export function spendLines(ctx: McpContext, user: User, agents: LoadedAgent[], day: string): string[] {
  const st = ctx.engine.store;
  const byAgent = agents.map((a) => `  ${a.spec.name.padEnd(9)} $${st.spent(day, a.spec.name).toFixed(2)} of $${a.spec.limits.usd_per_day}`);
  // An agent's monthly share (the monitor's): what it leaves of the monthly cap is kept for people.
  const month = ctx.engine.monthlyCapUsd;
  const shares = agents.flatMap((a) => {
    const cap = ctx.engine.agentMonthlyCapUsd?.[a.spec.name];
    if (cap === undefined) return [];
    const kept = month !== undefined && month > cap ? ` (the other $${month - cap} of $${month} is kept for people)` : '';
    return [`${a.spec.name} $${st.spent(day.slice(0, 7), a.spec.name).toFixed(2)} of $${cap} this month${kept}`];
  });
  return [
    `today: $${st.spent(day).toFixed(2)} of $${ctx.engine.dailyCapUsd} · this month: $${st.spent(day.slice(0, 7)).toFixed(2)} of $${ctx.engine.monthlyCapUsd ?? '∞'}`,
    ...shares,
    `you today: $${st.spent(day, undefined, user.name).toFixed(2)} of $${user.usd_per_day ?? ctx.cfg.mcp.userDailyCapUsd}`,
    'by agent today:',
    ...byAgent,
    existsSync(ctx.engine.stopFile) ? 'STOP is set: new runs are skipped.' : '',
  ].filter(Boolean);
}

// The patrol's memory: holds, blind-source notices, rows. The one place that
// reads it, so moving it out of state.json (into engine.db) changes only this.
function readPatrolState(cfg: Config): StateData {
  return State.load(cfg.stateFile).data;
}

// A summary as written to disk. Its shape belongs to the patrol and changes
// with it, so every field is optional here.
type PatrolSource = Partial<SourceHealth> & { state?: unknown };
type PatrolFile = Partial<Omit<Summary, 'sources'>> & { sources?: PatrolSource[] };
interface Patrol {
  newest: string; // the newest file's name
  at: Date; // when the newest patrol ran
  summary?: PatrolFile; // from the newest file that could be read
  from?: string; // set when that is not the newest file
}

// runner.ts names each pass out/patrols/<stamp>.json, stamp = 2026-11-06T1430Z.
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z\.json$/;

function latestPatrol(outDir: string | undefined): Patrol | undefined {
  if (!outDir) return undefined;
  const dir = join(outDir, 'patrols');
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .reverse();
  const newest = names[0];
  if (!newest) return undefined;
  const m = STAMP.exec(newest);
  const at = m ? new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`) : statSync(join(dir, newest)).mtime;
  // The file is written in place, not renamed into place: a read can catch it
  // half written. Then the one before it.
  for (const name of names.slice(0, 3)) {
    try {
      const summary = JSON.parse(readFileSync(join(dir, name), 'utf8')) as PatrolFile;
      return { newest, at, summary, ...(name !== newest ? { from: name } : {}) };
    } catch {
      continue;
    }
  }
  return { newest, at };
}

// Copied from output/notices.ts:68 (notConfigured, not exported there): a
// source with no datasource set up was never watched, so it is off, not blind.
const notConfigured = (s: PatrolSource) => /(^|: )not configured\b/.test(s.error ?? '');

// The patrol's source states, in its order (first match wins): off, blind,
// unknown, degraded, ok. Same rules as sourceState() in the source-state PR
// (#35, src/patrol/types.ts); import that one once it has merged.
export function sourceState(s: PatrolSource): string {
  if (typeof s.state === 'string' && s.state) return s.state; // the patrol's own, once it writes one
  if ((s as { disabled?: boolean }).disabled || (!s.ok && notConfigured(s))) return 'off';
  if (!s.ok) return 'blind';
  if (s.unknown) return 'unknown';
  if (s.note) return 'degraded';
  return 'ok';
}

// "14:30Z" today, "11-05 14:30Z" another day.
function clock(iso: string | undefined, now: Date): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return String(iso ?? '?');
  const t = new Date(iso).toISOString();
  return `${t.slice(0, 10) === now.toISOString().slice(0, 10) ? '' : `${t.slice(5, 10)} `}${t.slice(11, 16)}Z`;
}

function span(ms: number): string {
  const min = Math.max(0, Math.round(ms / MIN));
  if (min < 90) return `${min} min`;
  return min < 48 * 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.round(min / (24 * 60))} d`;
}

// One line, at most n characters. Redacted before the cut: a cut through an
// email or a token would leave a part the patterns no longer match.
const short = (s: string, n: number) => {
  const t = redact(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const count = (x: unknown) => (Array.isArray(x) ? x.length : '?');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function patrolLines(p: Patrol | undefined, cfg: Config, now: Date): string[] {
  const every = cfg.windowMinutes || p?.summary?.windowMinutes || 15;
  if (!p) return [`STALE: no patrol file here (out/patrols is empty): the patrol may not be running. Issues, the pause and spend below come from the engine's records.`];
  const age = now.getTime() - p.at.getTime();
  const lines = [
    age > 2 * every * MIN
      ? `STALE: the last patrol ran at ${clock(p.at.toISOString(), now)}, ${span(age)} ago (it runs every ${every} min): the patrol may not be running. What it found, its sources and deploys below are that old.`
      : `Patrol running: last pass ${clock(p.at.toISOString(), now)}, ${span(age)} ago (every ${every} min).`,
  ];
  if (p.from) lines.push(`The newest patrol file (${p.newest}) could not be read, maybe still being written: what the patrol found, its sources and deploys come from ${p.from}.`);
  else if (!p.summary) lines.push(`No patrol file could be read: what the patrol found, its sources and deploys are missing.`);
  return lines;
}

function aiLine(ctx: McpContext, state: StateData | undefined, now: Date): string {
  const held = state?.held;
  const reason = heldNow(held, now, ctx.engine.stopFile);
  if (reason !== undefined) return `AI: paused${held?.since ? ` since ${clock(held.since, now)}` : ''}: ${pauseText(reason) ?? reason}.`;
  if (existsSync(ctx.engine.stopFile)) return 'AI: paused: the kill switch is on (STOP); an admin clears it with resume.';
  if (!state) return 'AI: not known (the patrol state could not be read).'; // a cap that holds it is kept there
  return 'AI: on (no cap or kill switch holds it).';
}

function runLine(r: RunRow, now: Date): string {
  const usd = r.status === 'running' ? `$${r.reserve.toFixed(2)} reserved` : `$${(r.cost ?? r.reserve).toFixed(2)}`;
  return [`${clock(r.started_at, now)} ${r.status}`, usd, ...(r.turns ? [`${r.turns} turns`] : []), ...(r.challenge ? [`challenge ${r.challenge}`] : []), ...(r.note ? [short(r.note, 160)] : []), r.id].join(' · ');
}

function runLines(st: Store, now: Date): string[] {
  const [last] = st.recent(1, { agent: 'monitor' });
  if (!last) return ['Last monitor run: none yet'];
  const lines = [`Last monitor run: ${runLine(last, now)}`];
  // A refused run records the refusal: when the AI last looked is the run before.
  if (last.status === 'skipped') {
    const ran = st.recent(50, { agent: 'monitor' }).find((r) => r.status !== 'skipped');
    if (ran) lines.push(`Last one that ran: ${runLine(ran, now)}`);
  }
  return lines;
}

function issueLines(issues: Issues | undefined, now: Date): string[] {
  if (!issues) return ['Issues: no issue record on this server.'];
  // All of them, capped per part below: listed()'s own cap counts open and
  // resolved together by last report, so resolved ones reported later would
  // push an older open issue out of the list.
  const { issues: list } = issues.listed(now, { max: Infinity, resolvedHours: 24 });
  const open = list.filter((i) => i.status === 'open');
  // listed() also keeps an older resolved issue while its Not an issue lasts.
  const resolved = list.filter((i) => i.status !== 'open' && now.getTime() - Date.parse(i.resolved_at ?? '') <= DAY);
  const lines = [`Open issues (${open.length}):`, ...(open.length ? [] : ['- none'])];
  for (const i of open.slice(0, MAX_ISSUES)) {
    const d = issues.disposition(i.id, now);
    const who = d?.kind === 'acknowledged' ? ' · On it' : d?.kind === 'dismissed' ? ` · Not an issue${d.until ? ` (muted until ${clock(d.until, now)})` : ''}` : '';
    lines.push(`- ${i.id} · ${i.severity} · ${i.title} · ${plural(i.rows.length, 'row')} · last report ${clock(i.last_at, now)}${who}`);
    if (i.hypothesis) lines.push(`  likely cause: ${short(i.hypothesis, 200)}`);
  }
  if (open.length > MAX_ISSUES) lines.push(`- … ${open.length - MAX_ISSUES} more open`);
  if (resolved.length)
    lines.push(
      `Resolved in the last 24 h (${resolved.length}):`,
      ...resolved.slice(0, MAX_ISSUES).map((i) => `- ${i.id} · ${i.severity} · ${i.title} · resolved ${clock(i.resolved_at ?? undefined, now)}`),
      ...(resolved.length > MAX_ISSUES ? [`- … ${resolved.length - MAX_ISSUES} more`] : []),
    );
  return lines;
}

function foundLines(p: Patrol | undefined, state: StateData | undefined, now: Date, noise: boolean): string[] {
  const lines: string[] = [];
  const s = p?.summary;
  if (s) {
    const parts = [`${count(s.send)} new or worse`, `${count(s.known)} still firing, already reported`, `${count(s.waiting)} waiting for a second patrol`, `${count(s.recovered)} recovered`, ...(noise ? [`${count(s.suppressed)} dropped as noise`] : [])];
    lines.push(`Last patrol found: ${parts.join(' · ')}`);
  }
  // Rows still firing that the investigator gave up on: no report after ATTEMPTS runs.
  const gaveUp = Object.entries(state?.rows ?? {})
    .filter(([, m]) => m?.investigation?.status === 'gave_up' && !m.recoveredAt && now.getTime() - Date.parse(m.lastSeen) <= DAY)
    .map(([k]) => k);
  if (gaveUp.length)
    lines.push(
      `The AI gave up on ${plural(gaveUp.length, 'row')} seen in the last 24 h (no report after ${ATTEMPTS} runs):`,
      ...gaveUp.slice(0, MAX_GAVE_UP).map((k) => `- ${k}`),
      ...(gaveUp.length > MAX_GAVE_UP ? [`- … ${gaveUp.length - MAX_GAVE_UP} more`] : []),
    );
  return lines;
}

// Worst first; ok sources share one line.
const SHOWN = ['blind', 'unknown', 'degraded', 'off'];

function sourceLines(s: PatrolFile | undefined, state: StateData | undefined, now: Date): string[] {
  if (!s) return [];
  if (!Array.isArray(s.sources)) return ['Sources: not in the patrol file.'];
  const blindSince = { ...state?.notices?.disk?.blind, ...state?.notices?.channel?.blind };
  const rank = (st: string) => (SHOWN.includes(st) ? SHOWN.indexOf(st) : SHOWN.length); // a newer word after these
  const rows = s.sources.map((x) => ({ name: String(x.source ?? '?'), state: sourceState(x), x }));
  const ok = rows.filter((r) => r.state === 'ok').map((r) => r.name);
  const lines = ['Sources (last patrol):'];
  for (const r of rows.filter((r) => r.state !== 'ok').sort((a, b) => rank(a.state) - rank(b.state))) {
    const since = r.state === 'blind' && blindSince[r.name] ? ` since ${clock(blindSince[r.name], now)}` : '';
    const why = r.x.ok === false ? r.x.error : r.x.note;
    lines.push(`- ${r.state}: ${r.name}${since}${why ? `: ${short(String(why), 200)}` : ''}`);
  }
  if (ok.length) lines.push(`- ok: ${ok.join(', ')}`);
  return lines;
}

function deploySection(s: PatrolFile | undefined): string[] {
  if (!s) return [];
  const d = s.deploys as Partial<Deploys> | undefined;
  // No list (and no error saying why) is missing data, never "none".
  if (!d || typeof d !== 'object' || (!Array.isArray(d.deploys) && !d.error)) return ['Deploys: not in the patrol file.'];
  const all = Array.isArray(d.deploys) ? d.deploys : [];
  const x: Deploys = { at: String(d.at ?? ''), hours: d.hours ?? 6, deploys: all.slice(-MAX_DEPLOYS), statefulsets: Array.isArray(d.statefulsets) ? d.statefulsets : [], notes: Array.isArray(d.notes) ? d.notes : [], ...(d.argocd ? { argocd: d.argocd } : {}), ...(d.error ? { error: d.error } : {}) };
  return [`${deploysHeading(x)}, up to the last patrol:`, ...(all.length > x.deploys.length ? [`- … ${all.length - x.deploys.length} earlier ones: the deploys tool lists them`] : []), ...deployLines(x)];
}

// A part that can't be read says so; the rest still shows.
function attempt<T>(name: string, f: () => T): { value: T; error?: undefined } | { value?: undefined; error: string } {
  try {
    return { value: f() };
  } catch (e) {
    return { error: `${name}: could not be read (${short(String((e as Error)?.message ?? e), 200)})` };
  }
}
const part = (name: string, f: () => string[]): string[] => {
  const r = attempt(name, f);
  return r.error !== undefined ? [r.error] : r.value;
};

export function statusText(ctx: McpContext, user: User, now: Date, agents: LoadedAgent[]): string {
  const noise = user.role === 'admin' || NOISE_FOR_MEMBERS;
  const files = attempt('Patrol files', () => latestPatrol(ctx.cfg.outDir));
  const memory = attempt('Patrol state', () => readPatrolState(ctx.cfg));
  const patrol = files.value;
  const state = memory.value;
  const sections = [
    [
      ...(files.error !== undefined ? [`STALE: whether the patrol runs is unknown. ${files.error}`] : patrolLines(patrol, ctx.cfg, now)),
      ...(memory.error !== undefined ? [memory.error] : []),
      ...part('AI', () => [aiLine(ctx, state, now)]),
      ...part('Last monitor run', () => runLines(ctx.engine.store, now)),
    ],
    part('Issues', () => issueLines(ctx.issues, now)),
    part('Last patrol', () => foundLines(patrol, state, now, noise)),
    part('Sources', () => sourceLines(patrol?.summary, state, now)),
    part('Deploys', () => deploySection(patrol?.summary)),
    ['Spend:', ...part('Spend', () => spendLines(ctx, user, agents, now.toISOString().slice(0, 10)))],
  ];
  return truncate(redact(sections.filter((x) => x.length).map((x) => x.join('\n')).join('\n\n')), MAX);
}
