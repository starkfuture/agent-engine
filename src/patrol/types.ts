import type { Counts, Score } from './score.js';

export type Section = 'http' | 'drop' | 'workload' | 'rollout' | 'errors' | 'logs' | 'traces';

export interface Row {
  key: string; // stable identity across patrols: section|service|subject|status
  section: Section;
  service: string;
  subject: string; // route, workload/container, counter labels, log template, trace root
  status?: string;
  counts: Counts;
  totals?: Counts;
  score: Score;
  detail?: string; // redacted sample line, termination reason, …
  query?: string; // to reproduce in Grafana
  truncated?: boolean; // counts are lower bounds (the log line or trace search limit was hit)
}

export interface SourceHealth {
  source: string;
  ok: boolean;
  error?: string;
  // Read, but not all of it: capped results, some scrape targets down, a
  // presence check not run. Shown under the blind spots; never fails the source.
  note?: string;
  // Not even whether it reads is known: the search read nothing and the
  // presence check failed. Neither blind nor back (output/notices.ts), and no
  // row recovers on it (summary.ts).
  unknown?: true;
  // Switched off in config/sources.yaml (deploys.argocd: false): nothing is
  // read, and the source is listed only so its state says off. Logs and traces
  // with no datasource uid are off too (by their error), but they stay in the
  // lists of failed sources that predate states, as before; this one is in
  // none: engine_patrol_source_up (a 0 fires AgentEngineBlindSpot), the
  // card's blind spots, the investigator's, the log line.
  disabled?: true;
}

// One word per source, first match wins: off (not configured, or switched
// off), blind (not read), unknown (not known whether it reads; also ok with a
// note, so tested first), degraded (read in part: capped, some targets down)
// and ok. Saved with each source in the patrol JSON as `state`.
export type SourceState = 'off' | 'blind' | 'unknown' | 'degraded' | 'ok';

// A source with no datasource set up isn't blind: it was never watched.
export const notConfigured = (s: SourceHealth) => /(^|: )not configured\b/.test(s.error ?? '');

export function sourceState(s: SourceHealth): SourceState {
  if (s.disabled || (!s.ok && notConfigured(s))) return 'off';
  if (!s.ok) return 'blind';
  if (s.unknown) return 'unknown';
  if (s.note) return 'degraded';
  return 'ok';
}

export const rowKey = (r: Pick<Row, 'section' | 'service' | 'subject' | 'status'>) =>
  [r.section, r.service, r.subject, r.status ?? ''].join('|');
