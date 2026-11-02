import type { Counts, Score } from './score.js';

export type Section = 'http' | 'drop' | 'workload' | 'errors' | 'logs' | 'traces' | 'infra' | 'alert';

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
  truncated?: boolean; // counts are lower bounds (log line limit hit)
  measurement?: { value: number; unit: string; threshold: number; direction: 'above' | 'below'; forMinutes: number; level: 'warning' | 'critical' };
  contextOnly?: boolean; // info alerts add context but never start an investigation
}

export interface Change {
  namespace: string;
  workload: string;
  changes: number; // generation bumps in the lookback window
}

export interface SourceHealth {
  source: string;
  ok: boolean;
  error?: string;
}

export const rowKey = (r: Pick<Row, 'section' | 'service' | 'subject' | 'status'>) =>
  [r.section, r.service, r.subject, r.status ?? ''].join('|');
