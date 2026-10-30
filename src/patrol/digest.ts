import type { FlaggedRow } from './summary.js';
import type { Row } from './types.js';

// What a person reads on the patrol card, from the rows the patrol sends. Pure
// presentation: detection, row keys and state are untouched, and the LLM still
// gets every row through renderSummary.

// Fresh or worse event rows below this count are listed as quiet, not as
// something to look at (PATROL_ATTENTION_FLOOR).
export const DEFAULT_FLOOR = 10;

export type Bucket = 'look' | 'ongoing' | 'quiet';

export interface DigestOptions {
  floor?: number;
  protected?: (r: Row) => boolean; // never_suppress journeys: ranked first, never quiet
}

// One card line: a single row, rows whose subject reads the same, or variants
// of one subject (the same text but for one token: a locale, a status, …).
export interface Line {
  section: Row['section'];
  service: string;
  text: string;
  rows: FlaggedRow[];
  protected: boolean;
  variants?: { label: string; values: Array<{ value: string; rows: FlaggedRow[] }> };
}

export interface Digest {
  look: Line[];
  ongoing: Line[];
  quiet: Line[];
  counts: Record<Bucket, number>; // rows, not lines
}

// The floor only applies to event counts. Workload rows count pods and
// restarts, drop rows count traffic (low by definition): their own thresholds hold.
const EVENTS = new Set<Row['section']>(['http', 'logs', 'traces', 'errors']);

export function bucketOf(r: FlaggedRow, floor: number, prot: boolean): Bucket {
  if (r.novelty === 'reminder' || r.novelty === 'known') return 'ongoing';
  return EVENTS.has(r.section) && !prot && r.counts.now < floor ? 'quiet' : 'look';
}

// Severity for ordering, from the row alone (never the model's opinion):
// protected journeys, then outages (5xx, traffic drops, workloads), then error
// counters and traces, then error logs, then client errors (4xx, hang-ups).
export function tier(r: Row, prot: boolean): number {
  if (prot) return 0;
  if (r.section === 'drop' || r.section === 'workload' || (r.section === 'http' && /^5/.test(r.status ?? ''))) return 1;
  if (r.section === 'errors' || r.section === 'traces') return 2;
  if (r.section === 'logs') return 3;
  return 4;
}

export function digest(send: FlaggedRow[], o: DigestOptions = {}): Digest {
  const floor = o.floor ?? DEFAULT_FLOOR;
  const prot = o.protected ?? (() => false);
  const ranked = send
    .map((r) => ({ r, p: prot(r) }))
    .sort((a, b) => tier(a.r, a.p) - tier(b.r, b.p) || Math.abs(b.r.score.z) - Math.abs(a.r.score.z));
  const by: Record<Bucket, FlaggedRow[]> = { look: [], ongoing: [], quiet: [] };
  for (const { r, p } of ranked) by[bucketOf(r, floor, p)].push(r);
  const lines = (rows: FlaggedRow[]) => groupLines(rows).map((l) => ({ ...l, protected: l.rows.some(prot) }));
  return { look: lines(by.look), ongoing: lines(by.ongoing), quiet: lines(by.quiet), counts: { look: by.look.length, ongoing: by.ongoing.length, quiet: by.quiet.length } };
}

// ---- short subjects -----------------------------------------------------------
const PLACEHOLDER = /<(?:ts|n|uuid|oid|hex|vin|str|ip|email|phone|iban|secret|jwt|private-key)>/g;
const KEYED = /\b([A-Za-z_][\w.-]*)=(?:"([^"]*)"|([^\s,"]+))/g;
// What every line of a logger repeats: timestamps, counters, the level, a Java
// logger name. Levels are upper case only, so "error connecting" keeps its verb.
const LEAD = /^\s*(?:<ts>|<n>|[,.:|-]+|\[?(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|ERR|FATAL|CRITICAL|SEVERE)\]?:?(?=\s|$)|\[[\w$]+(?:\.[\w$]+)+\]|(?:Uncaught )?[Ee]rror:(?=\s))\s*/;
// Thread names: (executor-thread-<n>), [pool-<n>-thread-<n>]. "(sl-SI)" stays.
const THREAD = /\s*[([](?=[^\s()[\]]*(?:thread|<n>))[^\s()[\]]+[)\]]/gi;

// key="value" events (Keycloak, logfmt): the event, the error and the client.
function keyed(s: string): string | undefined {
  const kv = new Map<string, string>();
  for (const m of s.matchAll(KEYED)) {
    const k = m[1]!.toLowerCase();
    const v = m[2] ?? m[3] ?? '';
    if (v && v !== 'null' && !/^<[a-z-]+>$/.test(v) && !kv.has(k)) kv.set(k, v);
  }
  const pick = (...ks: string[]) => ks.map((k) => kv.get(k)).find(Boolean);
  const what = pick('type', 'event', 'event_type', 'action', 'msg', 'message');
  if (kv.size < 2 || !what) return undefined;
  const client = pick('clientid', 'client_id', 'client');
  return [what, pick('error', 'err', 'reason'), client && `(${client})`].filter(Boolean).join(' ');
}

function tidy(s: string): string {
  let t = s;
  for (let prev = ''; prev !== t; ) [prev, t] = [t, t.replace(LEAD, '')];
  return t.replace(THREAD, '');
}

// Display only: row keys keep the full template.
export function shortSubject(r: Pick<Row, 'section' | 'subject'>): string {
  let s = r.section === 'logs' ? (keyed(r.subject) ?? tidy(r.subject)) : r.subject;
  s = s.replace(PLACEHOLDER, '…').replace(/…(?:[\s,.:;-]*…)+/g, '…').replace(/\s+/g, ' ').trim();
  return s.length > 100 ? `${s.slice(0, 99)}…` : s || r.subject.slice(0, 100);
}

const lineText = (r: FlaggedRow) => `${shortSubject(r)}${r.status ? ` ${r.status}` : ''}`;

// ---- variants -------------------------------------------------------------------
// Rows of one service and section whose text differs in exactly one token are
// one line. The rest must share a word with a letter in it, so "GET" and "POST"
// alone, or "/a 404" and "/b 404", stay apart. Biggest groups first; members
// keep their rank order, and a group sits where its best member was.
const SEP = /([\s()[\]{}:;,=/"'|]+)/;
const HOLE = '\u0000';

function variantLabel(values: string[]): string {
  if (values.every((v) => /^[a-z]{2}-[A-Z]{2}$/.test(v))) return 'locales';
  if (values.every((v) => /^\d{3}$/.test(v))) return 'statuses';
  return 'variants';
}

export function groupLines(rows: FlaggedRow[]): Line[] {
  // Same service, section and text: one unit (two templates that read the same).
  const units: Array<{ section: Row['section']; service: string; text: string; rows: FlaggedRow[] }> = [];
  const byText = new Map<string, (typeof units)[number]>();
  for (const r of rows) {
    const text = lineText(r);
    const k = `${r.section}\u0001${r.service}\u0001${text}`;
    const u = byText.get(k);
    if (u) u.rows.push(r);
    else {
      const n = { section: r.section, service: r.service, text, rows: [r] };
      byText.set(k, n);
      units.push(n);
    }
  }

  const shapes = new Map<string, Array<{ i: number; value: string }>>();
  units.forEach((u, i) => {
    const parts = u.text.split(SEP);
    for (let j = 0; j < parts.length; j += 2) {
      if (!parts[j]) continue;
      const rest = parts.filter((p, k) => k !== j && k % 2 === 0);
      if (!rest.some((p) => /[A-Za-z]/.test(p))) continue;
      const shape = parts.map((p, k) => (k === j ? HOLE : p)).join('');
      const k = `${u.section}\u0001${u.service}\u0001${shape}`;
      shapes.set(k, [...(shapes.get(k) ?? []), { i, value: parts[j]! }]);
    }
  });

  const taken = new Set<number>();
  const lineAt = new Map<number, Line>();
  for (;;) {
    let best: { key: string; members: Array<{ i: number; value: string }> } | undefined;
    for (const [key, all] of shapes) {
      const members = all.filter((m) => !taken.has(m.i));
      if (members.length >= 2 && (!best || members.length > best.members.length)) best = { key, members };
    }
    if (!best) break;
    for (const m of best.members) taken.add(m.i);
    const shape = best.key.split('\u0001')[2]!;
    const first = units[best.members[0]!.i]!;
    const values = best.members.map((m) => ({ value: m.value, rows: units[m.i]!.rows }));
    lineAt.set(best.members[0]!.i, {
      section: first.section,
      service: first.service,
      // A trailing hole, bracketed or not, is dropped: "MISSING_MESSAGE: more (…)" reads "MISSING_MESSAGE: more".
      text: shape.replace(new RegExp(`\\s*[([{]?${HOLE}[)\\]}]?\\s*$`), '').replaceAll(HOLE, '…'),
      rows: values.flatMap((v) => v.rows),
      protected: false,
      variants: { label: variantLabel(values.map((v) => v.value)), values },
    });
  }
  units.forEach((u, i) => {
    if (!taken.has(i)) lineAt.set(i, { ...u, protected: false });
  });
  return [...lineAt.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
}
