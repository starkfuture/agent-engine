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
}

export const rowKey = (r: Pick<Row, 'section' | 'service' | 'subject' | 'status'>) =>
  [r.section, r.service, r.subject, r.status ?? ''].join('|');
