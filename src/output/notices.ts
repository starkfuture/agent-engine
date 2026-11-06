import { existsSync } from 'node:fs';
import type { StateData } from '../patrol/state.js';
import { notConfigured, type SourceHealth } from '../patrol/types.js';
import { blindCard, pausedCard, pauseText, resumedCard, sightCard, type Card } from './card.js';

// Two states look exactly like a quiet channel: the AI paused (a cap, the kill
// switch) and sources the patrol can't read. Code says each in the channel once
// when it starts and once when it ends. What was said is kept in the state
// file, so a restart doesn't say it again: what the channel was told, and apart
// from it what patrols that don't post (a replay, a dry patrol on the same
// state file) wrote to disk, so a dry run never keeps the channel from hearing.
export interface Told {
  paused?: { reason: string; since: string }; // the hold it was told about
  blind?: Record<string, string>; // the sources it was told are blind, and since which patrol
}
export interface Notices {
  channel?: Told;
  disk?: Told;
}
export type Where = keyof Notices;

// Queues a notice for the channel (or only for disk, with posting off).
export type Say = (card: Card, name: string) => void;

type Held = NonNullable<StateData['held']>;
const told = (s: StateData, where: Where): Told => ((s.notices ??= {})[where] ??= {});

// Whether the hold the last refused run recorded still holds. A daily cap ends
// with its UTC day, a monthly one with its UTC month, the kill switch once its
// file is gone. The patrol doesn't record the same refusal again while it
// holds, and the rows card says the AI is paused.
export function heldNow(held: Held | undefined, now: Date, stopFile: string): string | undefined {
  if (!held) return undefined;
  const r = held.reason;
  const day = now.toISOString();
  if (/daily cap/.test(r) && held.since.slice(0, 10) !== day.slice(0, 10)) return undefined;
  if (/monthly cap/.test(r) && held.since.slice(0, 7) !== day.slice(0, 7)) return undefined;
  if (/^kill switch is on/.test(r) && !existsSync(stopFile)) return undefined;
  return r;
}

// After a patrol: a hold that pauses the AI (see pauseText) and that hasn't
// been said gets one message. The same hold, next patrols: nothing. A daily cap
// still refusing the next day is a new hold.
export function announcePause(s: StateData, where: Where, heldBy: string | undefined, at: string, say: Say): void {
  const h = s.held;
  const why = h && heldBy === h.reason ? pauseText(h.reason) : undefined;
  const p = s.notices?.[where]?.paused;
  if (!h || !why || (p?.reason === h.reason && p.since === h.since)) return;
  say(pausedCard(why, h.since, at), 'paused');
  told(s, where).paused = { reason: h.reason, since: h.since };
}

// After a patrol: a run was admitted since the pause that was said (the runner
// clears the hold once one is): one message that the AI is back. Here, not at
// admission, so it is saved with the state in the same breath: a restart
// during the run doesn't say it twice.
export function announceResume(s: StateData, where: Where, at: string, say: Say): void {
  const p = s.notices?.[where]?.paused;
  if (!p || s.held) return;
  say(resumedCard(pauseText(p.reason) ?? p.reason, p.since, at), 'resumed');
  delete told(s, where).paused;
}

// Everything but logs (Loki) and traces (Tempo) reads Prometheus.
const prometheus = (source: string) => source !== 'logs' && source !== 'traces';

// A patrol that read nothing from Prometheus saw next to nothing: metrics don't
// count it as a success.
export function prometheusBlind(sources: SourceHealth[]): boolean {
  const prom = sources.filter((s) => prometheus(s.source) && !s.disabled); // a source switched off was never read
  return prom.length > 0 && prom.every((s) => !s.ok);
}

// After a patrol: sources that failed and haven't been said get one message
// ("also blind" while others still are). One outage, however it spreads: it is
// over when every source that was said reads again in one patrol, with one
// message, and how long each was blind. A source no longer patrolled (taken
// out of the config) leaves it quietly. One whose read proves nothing either
// way (unknown: its presence check failed) neither starts nor ends it.
export function announceBlind(s: StateData, where: Where, sources: SourceHealth[], at: string, say: Say): void {
  const said = s.notices?.[where]?.blind ?? {};
  const failed = sources.filter((x) => !x.ok && !notConfigured(x));
  const fresh = failed.filter((x) => !Object.hasOwn(said, x.source));
  if (fresh.length) {
    say(blindCard(fresh.map((x) => ({ source: x.source, error: x.error ?? 'unknown error' })), at, Object.keys(said).length > 0), 'blind');
    told(s, where).blind = { ...said, ...Object.fromEntries(fresh.map((x) => [x.source, at])) };
    return;
  }
  if (failed.length || !Object.keys(said).length || sources.some((x) => x.unknown && Object.hasOwn(said, x.source))) return;
  const ok = new Set(sources.filter((x) => x.ok).map((x) => x.source));
  const back = Object.entries(said).filter(([k]) => ok.has(k)).map(([source, since]) => ({ source, since }));
  if (back.length) say(sightCard(back, at), 'sources-back');
  delete told(s, where).blind;
}
