import type { Sources } from '../config.js';
import type { Telemetry } from '../clients/telemetry.js';

export interface ServiceMeasurement {
  family: string;
  service: string;
  requests: number;
  serverErrors: number;
  availability: number | null;
  p95Seconds: number | null;
  p99Seconds: number | null;
  objective: { availability: number; owner: string } | null;
}

// A bounded snapshot of what can actually be measured. These service-level
// indicators are candidates, not a declaration of customer journey success.
// No traffic yields unknown availability, never 100% success.
export async function coverage(tel: Telemetry, src: Sources, at: Date, minutes: number) {
  const services: ServiceMeasurement[] = [];
  const sources: Array<{ family: string; ok: boolean; error?: string }> = [];
  await Promise.all(
    src.http_families.map(async (f) => {
      const by = [f.service_label, f.status_label].filter(Boolean).join(', ');
      const svc = (labels: Record<string, string>) => f.service ?? (f.service_label ? labels[f.service_label] : undefined) ?? f.id;
      try {
        const samples = await tel.promInstant(`sum by (${by}) (increase(${f.selector}[${minutes}m]))`, at);
        if (!samples.length || samples.some((s) => !Number.isFinite(s.value) || s.value < 0)) throw new Error('request measurements missing or invalid');
        const grouped = new Map<string, ServiceMeasurement>();
        for (const s of samples) {
          if (!s.labels[f.status_label]) throw new Error('status label missing');
          const service = svc(s.labels);
          let m = grouped.get(service);
          if (!m) {
            const o = src.objectives?.find((o) => o.family === f.id && o.service === service);
            m = {
              family: f.id,
              service,
              requests: 0,
              serverErrors: 0,
              availability: null,
              p95Seconds: null,
              p99Seconds: null,
              objective: o ? { availability: o.availability, owner: o.owner } : null,
            };
            grouped.set(service, m);
          }
          m.requests += s.value;
          if (/^5\d\d$/.test(s.labels[f.status_label]!)) m.serverErrors += s.value;
        }
        for (const m of grouped.values()) m.availability = m.requests > 0 ? 1 - m.serverErrors / m.requests : null;
        // A bad histogram is a separate blind spot; preserve the request SLIs.
        services.push(...grouped.values());
        sources.push({ family: f.id, ok: true });
        if (f.latency_buckets) {
          try {
            for (const q of [0.95, 0.99]) {
              const by = ['le', f.service_label].filter(Boolean).join(', ');
              const values = await tel.promInstant(`histogram_quantile(${q}, sum by (${by}) (rate(${f.latency_buckets}[${minutes}m])))`, at);
              let valid = 0;
              for (const s of values) {
                const m = grouped.get(svc(s.labels));
                if (m && m.requests > 0 && Number.isFinite(s.value) && s.value >= 0) {
                  if (q === 0.95) m.p95Seconds = s.value;
                  else m.p99Seconds = s.value;
                  valid++;
                }
              }
              if (!valid) throw new Error(`p${q * 100} unavailable (no traffic or histogram coverage)`);
            }
            sources.push({ family: `${f.id}:latency`, ok: true });
          } catch (e) {
            sources.push({
              family: `${f.id}:latency`,
              ok: false,
              error: String((e as Error).message),
            });
          }
        } else
          sources.push({
            family: `${f.id}:latency`,
            ok: false,
            error: 'no histogram configured',
          });
      } catch (e) {
        sources.push({
          family: f.id,
          ok: false,
          error: String((e as Error).message),
        });
      }
    }),
  );
  return {
    at: at.toISOString(),
    windowMinutes: minutes,
    services: services.sort((a, b) => `${a.family}/${a.service}`.localeCompare(`${b.family}/${b.service}`)),
    sources: sources.sort((a, b) => a.family.localeCompare(b.family)),
    caveats: [
      'Availability here means HTTP non-5xx fraction, not confirmed customer journey success.',
      'Latency quantiles describe requests in this window; they are not anomaly probability thresholds.',
      'No SLO objective is assumed. Owners must review objectives before budget/burn alerting.',
      'Missing frontend or queue backlog measurements require instrumentation/exporters; an AI cannot infer them reliably from silence.',
    ],
  };
}
