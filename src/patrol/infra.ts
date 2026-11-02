import type { Gauge, Sources } from '../config.js';
import type { Telemetry } from '../clients/telemetry.js';
import { requireSeries } from './collectors.js';
import { rowKey, type Row } from './types.js';

// Gauges are measurements, not Poisson event counts. Require a complete,
// finite minute-resolution observation throughout the configured duration.
// Missing coverage fails this source, so an old incident cannot falsely resolve.
export async function collectGauge(tel: Telemetry, g: Gauge, at: Date, observed?: Set<string>, blind?: string[]): Promise<Row[]> {
  at = new Date(Math.floor(at.getTime() / 1000) * 1000);
  const start = new Date(at.getTime() - g.for_minutes * 60_000);
  const series = await tel.promRange(g.query, start, at, 60);
  if (!series.length) throw new Error(`no measurement series for ${g.id}`);
  if (series.length > 200) throw new Error(`${g.id}: more than 200 series; narrow or aggregate the query`);
  const rows: Row[] = [];
  const keys = new Set<string>();
  for (const s of series) {
    if ([...g.group_by, ...(g.service_label ? [g.service_label] : [])].some((k) => !s.labels[k])) throw new Error(`${g.id}: missing identity label`);
    const identity = g.group_by.map((k) => `${k}=${s.labels[k]}`).join(' ');
    if (keys.has(identity)) throw new Error(`${g.id}: duplicate identity; aggregate the query`);
    keys.add(identity);
    const p = s.points;
    if (
      p.length < g.for_minutes + 1 ||
      p.some(([t, v], i) => !Number.isFinite(v) || !Number.isFinite(t) || (i > 0 && (t <= p[i - 1]![0] || t - p[i - 1]![0] > 90))) ||
      p[0]![0] > start.getTime() / 1000 ||
      p.at(-1)![0] < at.getTime() / 1000
    ) {
      const problem = `${g.id}: incomplete or nonfinite measurement history for ${identity}`;
      if (!blind) throw new Error(problem);
      blind.push(problem);
      continue; // a new/disappeared node must not hide another node's failure
    }
    const service = s.labels[g.service_label ?? g.group_by[0]!]!;
    const subject = `${g.id} ${identity}`;
    observed?.add(rowKey({ section: 'infra', service, subject }));
    const crosses = (v: number, threshold: number) => (g.direction === 'above' ? v >= threshold : v <= threshold);
    if (!p.every(([, v]) => crosses(v, g.warning))) continue;
    const critical = g.critical !== undefined && p.every(([, v]) => crosses(v, g.critical!));
    const value = p.at(-1)![1];
    const threshold = critical ? g.critical! : g.warning;
    rows.push({
      key: rowKey({ section: 'infra', service, subject }),
      section: 'infra',
      service,
      subject,
      counts: { now: value, h1: 0, d1: 0, d7: 0 },
      score: { verdict: 'spike', expected: threshold, z: 0, trend: 'ongoing' },
      measurement: {
        value,
        unit: g.unit,
        threshold,
        direction: g.direction,
        forMinutes: g.for_minutes,
        level: critical ? 'critical' : 'warning',
      },
      detail: `${value.toFixed(2)} ${g.unit}; ${g.direction} ${threshold} for ${g.for_minutes} min (${critical ? 'critical' : 'warning'}); historical event baselines do not apply`,
      query: g.query,
    });
  }
  return rows;
}

export async function collectAlerts(tel: Telemetry, src: NonNullable<Sources['alerts']>, at: Date): Promise<Row[]> {
  const query = `max without (prometheus, prometheus_replica, replica) (ALERTS{alertstate="firing",namespace=~"${src.namespaces}",severity!="none"})`;
  const [samples] = await Promise.all([tel.promInstant(query, at), requireSeries(tel, src.health_selector, at, 'alert evaluator scrape')]);
  if (samples.length > 200) throw new Error('more than 200 firing alert series; narrow namespaces');
  if (samples.some((s) => !Number.isFinite(s.value))) throw new Error('nonfinite firing alert indicator');
  return samples
    .filter((s) => Number.isFinite(s.value) && s.value > 0)
    .map((s) => {
      const labels = Object.entries(s.labels)
        .filter(([k]) => k !== '__name__' && k !== 'alertstate')
        .sort(([a], [b]) => a.localeCompare(b));
      const service = s.labels.service ?? s.labels.deployment ?? s.labels.namespace ?? '?';
      const subject = labels.map(([k, v]) => `${k}=${v}`).join(' ');
      return {
        key: rowKey({ section: 'alert', service, subject }),
        section: 'alert' as const,
        service,
        subject,
        counts: { now: 1, h1: 0, d1: 0, d7: 0 },
        score: {
          verdict: 'new' as const,
          expected: 0,
          z: 0,
          trend: 'ongoing' as const,
        },
        contextOnly: s.labels.severity === 'info',
        detail: 'Existing Prometheus rule is firing. Severity is context; it does not authorize a new page or remediation.',
        query,
      };
    });
}
