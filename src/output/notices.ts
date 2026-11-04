import { existsSync } from 'node:fs';
import type { StateData } from '../patrol/state.js';
import type { SourceHealth } from '../patrol/types.js';
import { blindCard, pausedCard, pauseText, resumedCard, sightCard, type Card } from './card.js';

// Two states look exactly like a quiet channel: the AI paused (a cap, the kill
// switch) and sources the patrol can't read. Code says each in the channel once
// when it starts and once when it ends. What the channel was told is kept in
// the state file, so a restart doesn't say it again.
export interface Notices {
  paused?: { reason: string; since: string }; // the hold the channel was told about
  blind?: Record<string, string>; // the sources it was told are blind, and since which patrol
}

// Queues a notice for the channel (or only for disk, with posting off).
export type Say = (card: Card, name: string) => void;

type Held = NonNullable<StateData['held']>;

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

// After a patrol: a hold that pauses the AI (see pauseText) and that the channel
// hasn't heard about gets one message. The same hold, next patrols: nothing. A
// daily cap still refusing the next day is a new hold.
export function announcePause(s: StateData, heldBy: string | undefined, at: string, say: Say): void {
  const h = s.held;
  const why = h && heldBy === h.reason ? pauseText(h.reason) : undefined;
  if (!h || !why || (s.notices?.paused?.reason === h.reason && s.notices.paused.since === h.since)) return;
  say(pausedCard(why, h.since, at), 'paused');
  (s.notices ??= {}).paused = { reason: h.reason, since: h.since };
}

// A run was admitted after a pause the channel was told about: one message
// that the AI is back, before its reports.
export function announceResume(s: StateData, at: string, say: Say): void {
  const p = s.notices?.paused;
  if (!p) return;
  say(resumedCard(pauseText(p.reason) ?? p.reason, p.since, at), 'resumed');
  delete s.notices!.paused;
}

// Everything but logs (Loki) and traces (Tempo) reads Prometheus.
const prometheus = (source: string) => source !== 'logs' && source !== 'traces';
// A source with no datasource set up isn't blind: it was never watched.
const notConfigured = (s: SourceHealth) => /(^|: )not configured\b/.test(s.error ?? '');

// A patrol that read nothing from Prometheus saw next to nothing: metrics don't
// count it as a success.
export function prometheusBlind(sources: SourceHealth[]): boolean {
  const prom = sources.filter((s) => prometheus(s.source));
  return prom.length > 0 && prom.every((s) => !s.ok);
}

// After a patrol: sources that failed and the channel hasn't heard about get
// one message ("also blind" while others still are). One outage, however it
// spreads: it is over when every source the channel was told about reads again
// in one patrol, with one message, and how long each was blind. A source no
// longer patrolled (taken out of the config) leaves it quietly.
export function announceBlind(s: StateData, sources: SourceHealth[], at: string, say: Say): void {
  const told = s.notices?.blind ?? {};
  const failed = sources.filter((x) => !x.ok && !notConfigured(x));
  const fresh = failed.filter((x) => !Object.hasOwn(told, x.source));
  if (fresh.length) {
    say(blindCard(fresh.map((x) => ({ source: x.source, error: x.error ?? 'unknown error' })), at, Object.keys(told).length > 0), 'blind');
    (s.notices ??= {}).blind = { ...told, ...Object.fromEntries(fresh.map((x) => [x.source, at])) };
    return;
  }
  if (failed.length || !Object.keys(told).length) return;
  const ok = new Set(sources.filter((x) => x.ok).map((x) => x.source));
  const back = Object.entries(told).filter(([k]) => ok.has(k)).map(([source, since]) => ({ source, since }));
  if (back.length) say(sightCard(back, at), 'sources-back');
  delete s.notices!.blind;
}
