// Pure scoring: given counts for the patrol window now and the same window
// 1 h / 1 d / 7 d earlier, decide whether a row is worth anyone's attention.
//
// Baseline = min(1 d, 7 d), scaled by today's traffic when totals are known.
// min() keeps a one-day incident from becoming its own baseline the next day
// (29 Sep stays visible on 30 Sep, because 7 d ago was clean). 1 h ago is used
// only to label the row "started" vs "ongoing", never as a baseline: a baseline
// of 1 h would make any incident older than an hour disappear.

export interface Counts {
  now: number;
  h1: number;
  d1: number;
  d7: number;
}

export type Verdict = 'new' | 'spike' | 'drop' | 'steady';

export interface Thresholds {
  minCount: number; // ignore anything with fewer events in the window
  minZ: number; // Poisson-ish z-score over the expected count
  minRatio: number; // and at least this multiple of expected
  dropMinBaseline: number; // traffic drop needs at least this much expected traffic
  dropMaxFraction: number; // and now <= expected * this
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minCount: 5,
  minZ: 3,
  minRatio: 1.5,
  dropMinBaseline: 60,
  dropMaxFraction: 0.25,
};

export interface Score {
  verdict: Verdict;
  expected: number;
  z: number;
  trend: 'started' | 'ongoing';
}

// totals (optional): traffic of the parent (route) in the same windows, so a
// busier hour doesn't read as an error spike.
export function scoreErrors(c: Counts, totals?: Counts, t: Thresholds = DEFAULT_THRESHOLDS): Score {
  const baseline = Math.min(c.d1, c.d7);
  let expected = baseline;
  if (totals) {
    const rate = (e: number, n: number) => (n > 0 ? e / n : undefined);
    const rates = [rate(c.d1, totals.d1), rate(c.d7, totals.d7)].filter((x): x is number => x !== undefined);
    if (rates.length) expected = Math.min(...rates) * totals.now;
  }
  const z = (c.now - expected) / Math.sqrt(expected + 1);
  const trend: Score['trend'] = c.h1 >= t.minCount && c.h1 >= c.now * 0.5 ? 'ongoing' : 'started';
  if (c.now < t.minCount) return { verdict: 'steady', expected, z, trend };
  if (c.d1 === 0 && c.d7 === 0) return { verdict: 'new', expected, z, trend };
  if (z >= t.minZ && c.now >= expected * t.minRatio) return { verdict: 'spike', expected, z, trend };
  return { verdict: 'steady', expected, z, trend };
}

export function scoreTraffic(totals: Counts, t: Thresholds = DEFAULT_THRESHOLDS): Score {
  const expected = Math.min(totals.d1, totals.d7);
  const z = (totals.now - expected) / Math.sqrt(expected + 1);
  const trend: Score['trend'] = totals.h1 <= expected * t.dropMaxFraction ? 'ongoing' : 'started';
  if (expected >= t.dropMinBaseline && totals.now <= expected * t.dropMaxFraction)
    return { verdict: 'drop', expected, z, trend };
  return { verdict: 'steady', expected, z, trend };
}

// Everything that isn't 2xx/3xx. Istio's "0" (client went away) counts too.
export const isErrorStatus = (status: string) => status !== '' && !/^[23]/.test(status);
