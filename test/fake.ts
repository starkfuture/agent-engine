import type { LogLine, Sample, Series, Telemetry, TraceHit } from '../src/clients/telemetry.js';

// Answers promInstant by (query substring, time) so tests can describe the
// world as "this query at this moment returns these samples".
export class FakeTelemetry implements Telemetry {
  readonly has = { loki: false, tempo: false };
  readonly calls: string[] = [];
  constructor(private readonly answer: (query: string, at: Date) => Sample[]) {}
  async promInstant(query: string, at: Date): Promise<Sample[]> {
    this.calls.push(query);
    return this.answer(query, at);
  }
  async promRange(): Promise<Series[]> {
    return [];
  }
  async lokiRange(): Promise<LogLine[]> {
    return [];
  }
  async tempoSearch(): Promise<TraceHit[]> {
    return [];
  }
}

export const H = 3600_000;
export const DAY = 24 * H;

// The 29 Sep shape: password reset and sign-up start returning 400 at 12:00Z.
// Everything else is normal traffic with a steady trickle of 404s.
export const INCIDENT_START = Date.parse('2026-09-29T12:00:00Z');
export function world(query: string, at: Date): Sample[] {
  if (!query.includes('backend_be_production_http_requests_total')) return [];
  const t = at.getTime();
  const broken = t >= INCIDENT_START && t < INCIDENT_START + 30 * H;
  const cell = (route: string, status: string, value: number): Sample => ({ labels: { route, status_code: status }, value });
  return [
    cell('/v1/auth/password/reset', '200', broken ? 20 : 90),
    cell('/v1/auth/password/reset', '400', broken ? 75 : 2),
    cell('/v1/auth/signup', '201', broken ? 10 : 60),
    cell('/v1/auth/signup', '400', broken ? 55 : 3),
    cell('/v1/products', '200', 5000),
    cell('/v1/products', '404', 40),
  ];
}

