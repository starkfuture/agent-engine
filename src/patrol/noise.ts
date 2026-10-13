import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Row } from './types.js';

const Matcher = z.object({
  section: z.string().optional(),
  service: z.string().optional(),
  route: z.string().optional(), // matches Row.subject
  status: z.string().optional(),
});
const NoiseRule = Matcher.extend({
  id: z.string(),
  reason: z.string().min(3),
  expires: z.coerce.date(),
});
const NoiseFile = z.object({
  never_suppress: z.array(Matcher).default([]),
  noise: z.array(NoiseRule).default([]),
});
export type NoiseRule = z.infer<typeof NoiseRule>;

type Compiled = { [K in 'section' | 'service' | 'route' | 'status']?: RegExp };
const compile = (m: z.infer<typeof Matcher>): Compiled => {
  const c: Compiled = {};
  for (const k of ['section', 'service', 'route', 'status'] as const) {
    const v = m[k];
    if (v !== undefined) c[k] = new RegExp(`^(?:${v})$`, 'i');
  }
  return c;
};
const matches = (c: Compiled, r: Row) =>
  (!c.section || c.section.test(r.section)) &&
  (!c.service || c.service.test(r.service)) &&
  (!c.route || c.route.test(r.subject)) &&
  (!c.status || c.status.test(r.status ?? ''));

export class Noise {
  private readonly never: Compiled[];
  private readonly rules: Array<{ rule: NoiseRule; c: Compiled }>;

  constructor(raw: unknown) {
    const f = NoiseFile.parse(raw ?? {});
    this.never = f.never_suppress.map(compile);
    this.rules = f.noise.map((rule) => ({ rule, c: compile(rule) }));
  }

  static load(file: string): Noise {
    return new Noise(existsSync(file) ? parse(readFileSync(file, 'utf8')) : {});
  }

  protected(r: Row): boolean {
    return this.never.some((c) => matches(c, r));
  }

  // The rule that suppresses this row, if any. Expired rules and protected rows never match.
  suppressedBy(r: Row, now: Date): NoiseRule | undefined {
    if (this.protected(r)) return undefined;
    return this.rules.find(({ rule, c }) => rule.expires > now && matches(c, r))?.rule;
  }
}
