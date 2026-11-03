import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patrolCard, type Card } from '../src/output/card.js';
import { digest, groupLines, shortSubject, tier } from '../src/patrol/digest.js';
import { Noise } from '../src/patrol/noise.js';
import { Owners } from '../src/patrol/owners.js';
import type { FlaggedRow, Summary } from '../src/patrol/summary.js';
import { rowKey, type Section } from '../src/patrol/types.js';

const AT = '2026-10-29T14:00:00.000Z';

type Opt = Partial<Pick<FlaggedRow, 'status' | 'novelty' | 'firstSeen' | 'totals' | 'truncated'>> & { h1?: number; expected?: number; z?: number; verdict?: FlaggedRow['score']['verdict'] };
function row(section: Section, service: string, subject: string, now: number, o: Opt = {}): FlaggedRow {
  const { h1 = 0, expected = 0, z = now, verdict = 'new', novelty = 'fresh', firstSeen = AT, ...rest } = o;
  return {
    key: rowKey({ section, service, subject, status: o.status }),
    section,
    service,
    subject,
    counts: { now, h1, d1: 0, d7: 0 },
    score: { verdict, expected, z, trend: h1 >= 5 && h1 >= now * 0.5 ? 'ongoing' : 'started' },
    novelty,
    firstSeen,
    ...rest,
  };
}
const summary = (send: FlaggedRow[], over: Partial<Summary> = {}): Summary => ({ at: AT, windowMinutes: 15, send, known: [], suppressed: [], recovered: [], deploys: { at: AT, hours: 6, deploys: [], statefulsets: [], notes: [] }, sources: [], ...over });

// What Slack parses: the notification text and every mrkdwn string.
const slackText = (c: Card) => [c.text, ...(JSON.stringify(c.blocks).match(/"type":"mrkdwn","text":"(?:[^"\\]|\\.)*"/g) ?? [])].join('\n');
const mrkdwn = (c: Card) => (c.blocks as Array<{ text?: { text: string }; elements?: Array<{ text: string }> }>).map((b) => b.text?.text ?? b.elements!.map((e) => e.text).join(' '));

// ---- short subjects --------------------------------------------------------------

test('log subjects keep the meaningful part: Keycloak event, error and client; no timestamps, threads or placeholders', () => {
  const kc =
    '<ts>,<n> WARN [org.keycloak.events] (executor-thread-<n>) type="LOGIN_ERROR", realmId="<uuid>", realmName="stark", clientId="stark-backend-client", userId="null", ipAddress="<ip>", error="user_not_found", auth_method="openid-connect", grant';
  assert.equal(shortSubject({ section: 'logs', subject: kc }), 'LOGIN_ERROR user_not_found (stark-backend-client)');
  assert.equal(shortSubject({ section: 'logs', subject: '<ts> ERROR [com.stark.sync.Worker] (pool-<n>-thread-<n>) Sync failed for <uuid> after <n> attempts' }), 'Sync failed for … after … attempts');
  assert.equal(shortSubject({ section: 'logs', subject: 'Error: MISSING_MESSAGE: more (sl-SI)' }), 'MISSING_MESSAGE: more (sl-SI)');
  assert.equal(shortSubject({ section: 'logs', subject: 'Ride with id <hex> not found' }), 'Ride with id … not found');
  assert.equal(shortSubject({ section: 'logs', subject: 'error connecting to <ip>' }), 'error connecting to …', 'a lower-case "error" is a word, not a level');
  assert.equal(shortSubject({ section: 'logs', subject: '[ProductService] Product <n> not found' }), '[ProductService] Product … not found', 'a JSON log context stays');
  assert.equal(shortSubject({ section: 'http', subject: '/v3/ecom/cart' }), '/v3/ecom/cart');
  assert.ok(shortSubject({ section: 'logs', subject: `x ${'y'.repeat(300)}` }).length <= 100);
});

// ---- grouping --------------------------------------------------------------------

test('variants of one subject group into one line, whatever the variant is', () => {
  const lines = groupLines([
    row('logs', 'web', 'Error: MISSING_MESSAGE: more (sl-SI)', 4),
    row('logs', 'web', 'Error: MISSING_MESSAGE: more (fr-FR)', 4),
    row('logs', 'web', 'Error: MISSING_MESSAGE: more (hu-HU)', 4),
    row('http', 'api', '/v3/ecom/cart', 7, { status: '404' }),
    row('http', 'api', '/v3/ecom/cart', 5, { status: '400' }),
    row('logs', 'sync', 'Queue orders-eu stalled', 9),
    row('logs', 'sync', 'Queue orders-us stalled', 9),
  ]);
  assert.deepEqual(
    lines.map((l) => [l.text, l.variants?.label, l.variants?.values.map((v) => v.value)]),
    [
      ['MISSING_MESSAGE: more', 'locales', ['sl-SI', 'fr-FR', 'hu-HU']],
      ['/v3/ecom/cart', 'statuses', ['404', '400']],
      ['Queue … stalled', 'variants', ['orders-eu', 'orders-us']],
    ],
  );
});

test('grouping stays within one service and section, needs shared words, and prefers the biggest group', () => {
  const lines = groupLines([
    row('logs', 'web', 'MISSING_MESSAGE: more (sl-SI)', 4),
    row('logs', 'other', 'MISSING_MESSAGE: more (fr-FR)', 4), // another service
    row('traces', 'web', 'MISSING_MESSAGE: more (de-DE)', 4), // another section
    row('traces', 'api', 'GET', 6),
    row('traces', 'api', 'POST', 6), // nothing shared but the hole
    row('http', 'api', '/a', 6, { status: '404' }),
    row('http', 'api', '/b', 6, { status: '404' }), // only a status in common
    row('logs', 'web', 'Payment failed for card', 6),
    row('logs', 'web', 'Payment declined for wallet', 6), // two tokens differ
  ]);
  assert.equal(lines.filter((l) => l.variants).length, 0);
  assert.equal(lines.length, 9);

  // "more (…)" (4 locales) wins over "… (de-DE)" (3 keys) for the row in both;
  // each row lands in one line, and a line sits where its best-ranked row was.
  const best = groupLines([
    row('logs', 'web', 'MISSING_MESSAGE: checkout_seo_page_image (de-DE)', 8),
    row('logs', 'web', 'MISSING_MESSAGE: more (sl-SI)', 4),
    row('logs', 'web', 'MISSING_MESSAGE: more (fr-FR)', 4),
    row('logs', 'web', 'MISSING_MESSAGE: more (hu-HU)', 4),
    row('logs', 'web', 'MISSING_MESSAGE: more (de-DE)', 4),
    row('logs', 'web', 'MISSING_MESSAGE: checkout_seo_page_keywords (de-DE)', 8),
  ]);
  assert.deepEqual(
    best.map((l) => [l.text, l.variants!.values.map((v) => v.value)]),
    [
      ['MISSING_MESSAGE: … (de-DE)', ['checkout_seo_page_image', 'checkout_seo_page_keywords']],
      ['MISSING_MESSAGE: more', ['sl-SI', 'fr-FR', 'hu-HU', 'de-DE']],
    ],
  );
  assert.equal(best.flatMap((l) => l.rows).length, 6);
});

test('rows that read the same once shortened share a line', () => {
  const a = '<ts> WARN [org.keycloak.events] type="LOGIN_ERROR", clientId="web", error="invalid_user_credentials", auth_method="openid-connect"';
  const b = '<ts> WARN [org.keycloak.events] type="LOGIN_ERROR", clientId="web", error="invalid_user_credentials", grant_type="password"';
  const [l, ...rest] = groupLines([row('logs', 'kc', a, 12), row('logs', 'kc', b, 3)]);
  assert.equal(rest.length, 0);
  assert.equal(l!.rows.length, 2);
  const c = patrolCard(summary([row('logs', 'kc', a, 12), row('logs', 'kc', b, 30)]), 'x');
  assert.match(c.markdown, /`LOGIN_ERROR invalid_user_credentials \(web\)` \(2 signals\) — now 42/);
});

// ---- ranking and the floor -------------------------------------------------------

test('lines to look at are ranked by severity, then by how far off they are', () => {
  const rows = [
    row('http', 'api', '/v3/products', 400, { status: '404', z: 40 }),
    row('logs', 'api', 'Something odd', 50, { z: 30 }),
    row('traces', 'api', 'GET /v3/orders', 20, { z: 9 }),
    row('http', 'api', '/v3/orders', 15, { status: '503', z: 5 }),
    row('drop', 'api', '(all routes)', 3, { verdict: 'drop', expected: 900, z: -29 }),
    row('http', 'api', '/v1/auth/login', 12, { status: '502', z: 3 }),
    row('traces', 'api', 'POST /v3/cart', 20, { z: 12 }),
  ];
  const noise = new Noise({ never_suppress: [{ section: 'http', route: '.*login.*', status: '5..' }] });
  const d = digest(rows, { protected: (r) => noise.protected(r) });
  assert.deepEqual(
    d.look.map((l) => l.text),
    ['/v1/auth/login 502', '(all routes)', '/v3/orders 503', 'POST /v3/cart', 'GET /v3/orders', 'Something odd', '/v3/products 404'],
  );
  assert.equal(tier(rows[1]!, false), 3);
  assert.ok(d.look[0]!.protected);
});

test('the floor: a small new count is quiet, not something to look at; reminders are ongoing', () => {
  const noise = new Noise({ never_suppress: [{ section: 'http', route: '.*checkout.*', status: '5..' }] });
  const rows = [
    row('logs', 'b', 'Vehicle not found', 4), // tiny, new
    row('logs', 'b', 'Ride gone', 10), // at the floor
    row('http', 'b', '/v3/x', 9, { status: '404', novelty: 'worse' }), // worse, still tiny
    row('http', 'b', '/v3/checkout', 3, { status: '500' }), // protected: never quiet
    row('workload', 'b', 'restarts app', 1), // pods, not events
    row('drop', 'b', '(all routes)', 2, { verdict: 'drop', expected: 400, z: -20 }), // a drop is low by definition
    row('logs', 'b', 'Old thing', 400, { novelty: 'reminder', firstSeen: '2026-10-27T10:00:00.000Z' }),
  ];
  const d = digest(rows, { protected: (r) => noise.protected(r) });
  const texts = (ls: typeof d.look) => ls.map((l) => l.text).sort();
  assert.deepEqual(texts(d.look), ['(all routes)', '/v3/checkout 500', 'Ride gone', 'restarts app']);
  assert.deepEqual(texts(d.quiet), ['/v3/x 404', 'Vehicle not found']);
  assert.deepEqual(texts(d.ongoing), ['Old thing']);
  assert.deepEqual(d.counts, { look: 4, ongoing: 1, quiet: 2 });
  assert.equal(digest(rows, { floor: 3 }).counts.quiet, 0, 'the floor is configurable');

  const c = patrolCard(summary(rows), 'x', { protected: (r) => noise.protected(r) });
  assert.match(c.text, /^Patrol 2026-10-29 14:00Z: 4 to look at · 1 still ongoing · 2 quiet$/);
  assert.match(c.markdown, /\*\*Quiet \(new, fewer than 10 events\)\*\*\n- \*\*b\*\* · logs `Vehicle not found` \(4\)/);
  assert.match(c.markdown, /- \*\*b\*\* · logs `Old thing` · now 400 · since 10-27 10:00Z/, 'ongoing lines are compact');
  assert.match(patrolCard(summary([rows[0]!]), 'x').text, /nothing new to look at · 1 quiet/);
});

// ---- owners ----------------------------------------------------------------------

test('owners: exact beats prefix beats regex; unknown services get no one; mentions can be turned off', () => {
  const o = new Owners({
    owners: {
      '/(ecom|stock)-.*/': '<!subteam^S0REGEX1>',
      'ecom-*': '<!subteam^S0PREFIX1>',
      'ecom-service-*': '<@U0PREFIX2>',
      'ecom-service-production': '<@U0EXACT1>',
    },
  });
  assert.equal(o.ownerOf('ecom-service-production'), '<@U0EXACT1>');
  assert.equal(o.ownerOf('ECOM-SERVICE-production'), '<@U0EXACT1>');
  assert.equal(o.ownerOf('ecom-service-staging'), '<@U0PREFIX2>', 'the longest prefix wins');
  assert.equal(o.ownerOf('ecom-worker'), '<!subteam^S0PREFIX1>');
  assert.equal(o.ownerOf('stock-sync'), '<!subteam^S0REGEX1>');
  assert.equal(o.ownerOf('xstock-sync'), undefined, 'regexes are anchored');
  assert.equal(o.ownerOf('backend-production'), undefined);
  assert.equal(new Owners({ mentions: false, owners: { x: '<@U0EXACT1>' } }).ownerOf('x'), undefined);
  assert.equal(Owners.load('/nonexistent/owners.yaml').ownerOf('x'), undefined);
  assert.equal(Owners.load(new URL('../config/owners.yaml', import.meta.url).pathname).ownerOf('keycloak-production'), undefined, 'the shipped file names no one');
});

test('owners: only a user or user-group mention is accepted', () => {
  for (const bad of ['<!channel>', '<!here>', '<!everyone>', '<@U123|x>', '<https://evil.test|grafana>', '@ana', 'U0123ABCD', '<@U0ABC> <!channel>', '<!subteam^S0ABC|@team>'])
    assert.throws(() => new Owners({ owners: { svc: bad } }), /must be <@U…>/, bad);
  assert.doesNotThrow(() => new Owners({ owners: { a: '<@U0123ABCD>', b: '<@W0123ABCD>', c: '<!subteam^S0123ABCD>' } }));
});

test('lines to look at mention their owner, and the summary line lists who is mentioned; nothing else pings', () => {
  const owners = new Owners({ owners: { 'kc-*': '<@U0KC1>', web: '<!subteam^S0WEB1>', quiet: '<@U0QUIET1>', old: '<@U0OLD1>' } });
  const s = summary([
    row('logs', 'kc-production', 'LOGIN_ERROR burst', 40),
    row('http', 'web', '/v3/cart', 30, { status: '404' }),
    row('http', 'nobody-owns-me', '/v3/x', 30, { status: '404' }),
    row('logs', 'quiet', 'tiny', 4),
    row('logs', 'old', 'still there', 50, { novelty: 'reminder' }),
  ]);
  const c = patrolCard(s, 'x', { owners });
  const look = mrkdwn(c).find((t) => t.startsWith('*To look at*'))!;
  assert.match(look, /`LOGIN_ERROR burst` — .* <@U0KC1>$/m);
  assert.match(look, /`\/v3\/cart 404` — .* <!subteam\^S0WEB1>$/m);
  assert.match(look, /`\/v3\/x 404` — [^<]*$/m, 'unknown service: no mention, no guess');
  assert.match(c.text, /· cc <@U0KC1> <!subteam\^S0WEB1>$/);
  assert.match(mrkdwn(c)[0]!, /· cc <@U0KC1> <!subteam\^S0WEB1>$/);
  assert.ok(!slackText(c).includes('U0QUIET1') && !slackText(c).includes('U0OLD1'), 'quiet and ongoing lines ping no one');

  const off = patrolCard(s, 'x', { owners: new Owners({ mentions: false, owners: { 'kc-*': '<@U0KC1>' } }) });
  assert.ok(!slackText(off).includes('<@') && !off.text.includes('cc'));
});

test('production text on the card is escaped; only owners-file mentions reach Slack raw', () => {
  const owners = new Owners({ owners: { '/.*/': '<@U0OWNER1>' } });
  const s = summary(
    [
      row('logs', 'api', 'boom <!channel> ping <@U0VICTIM> see <https://evil.test|grafana> & more', 40),
      row('http', '<!here>', '/v3/<!everyone>', 40, { status: '500' }),
      row('logs', 'api', 'quiet <!channel>', 3),
      row('logs', 'api', 'old <!channel>', 30, { novelty: 'reminder' }),
      row('logs', 'api', 'Error: MISSING <!channel> (sl-SI)', 30),
      row('logs', 'api', 'Error: MISSING <!channel> (fr-FR)', 30),
    ],
    { sources: [{ source: 'logs <!channel>', ok: false, error: 'x' }] },
  );
  const c = patrolCard(s, 'not investigated: <!channel>', { owners });
  const slack = slackText(c);
  // Remove the one allowed control, then nothing Slack would parse may be left.
  const rest = slack.replaceAll('<@U0OWNER1>', '');
  assert.ok(!/<[!@#]|<https?:/.test(rest), rest);
  assert.ok(!rest.includes('<'), rest);
  assert.match(slack, /&lt;!channel&gt;/);
  assert.match(slack, /&amp; more/);
  assert.ok(slack.includes('<@U0OWNER1>'));
});

test('card text on Slack is redacted', () => {
  const c = patrolCard(summary([row('logs', 'api', 'reset for jane@example.com failed token=abc123secretvalue', 40)]), 'x');
  const all = c.markdown + JSON.stringify(c.blocks) + c.text;
  assert.ok(!all.includes('jane@example.com') && !all.includes('abc123secretvalue'), all);
});

// ---- the cap ---------------------------------------------------------------------

test('a big patrol is capped in whole lines, under Slack limits, and says where the full list is', () => {
  const owners = new Owners({ owners: { 'svc-0': '<@U0FIRST1>', 'svc-29': '<@U0LAST1>' } });
  const long = (i: number) => `${'Something very wordy happened in the request pipeline '.repeat(4)} case ${i}`;
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => row('logs', `svc-${i}`, long(i), 100 - i, { z: 100 - i })),
    ...Array.from({ length: 20 }, (_, i) => row('http', `old-${i}`, `/v3/${'segment/'.repeat(30)}${i}`, 50, { status: '404', novelty: 'reminder' })),
    ...Array.from({ length: 40 }, (_, i) => row('logs', `small-${i}`, `tiny thing number ${i} ${'x'.repeat(60)}`, 3)),
  ];
  const c = patrolCard(summary(rows), 'x', { owners, ref: 'patrols/20261029T140000Z.md' });
  assert.ok(c.blocks.length <= 50);
  for (const t of mrkdwn(c)) assert.ok(t.length < 3000, `block of ${t.length} chars`);
  const [title, look, ongoing, quiet, footer] = mrkdwn(c);
  assert.match(title!, /30 to look at · 20 still ongoing · 40 quiet/);
  const lookLines = look!.split('\n').filter((l) => l.startsWith('•'));
  assert.ok(lookLines.length <= 10 && lookLines.length >= 3, `${lookLines.length} lines`);
  assert.match(look!, new RegExp(`\\n…and ${30 - lookLines.length} more to look at <@U0LAST1>$`), 'owners of cut lines are still mentioned');
  assert.ok(look!.includes('<@U0FIRST1>'));
  assert.ok(ongoing!.split('\n').filter((l) => l.startsWith('•')).length <= 6);
  assert.match(ongoing!, /…and \d+ more$/);
  assert.match(quiet!, /…and \d+ more$/);
  assert.match(footer!, /full list: patrols\/20261029T140000Z\.md/);
  for (const l of lookLines) assert.match(l, / — now \d+ \(1h ago \d+\) vs expected \d+ · new, started/, 'lines are whole');
  // Thirty owners: the summary names all of them, and no block nears Slack's limit.
  const many = new Owners({ owners: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`svc-${i}`, `<@U0OWNER${String(i).padStart(4, '0')}LONGID>`])) });
  const c2 = patrolCard(summary(rows), 'x', { owners: many });
  for (const t of mrkdwn(c2)) assert.ok(t.length < 2900, `block of ${t.length} chars`);
  assert.equal(c2.text.match(/<@U0OWNER/g)!.length, 30);
  // The file on disk keeps every line.
  assert.equal(c.markdown.split('\n').filter((l) => l.startsWith('- ')).length, 30 + 20 + 40);
});

test('a small patrol is not cut and has no "full list" pointer', () => {
  const c = patrolCard(summary([row('logs', 'a', 'x happened', 20), ...Array.from({ length: 7 }, (_, i) => row('logs', `o${i}`, `old ${i}`, 20, { novelty: 'reminder' }))]), 'x', { ref: 'patrols/p.md' });
  assert.ok(!mrkdwn(c).join('\n').includes('more'), 'seven ongoing lines are shown, not six and "…and 1 more"');
  assert.ok(!mrkdwn(c).join('\n').includes('full list'));
});

// ---- the first real card (2026-10-29 14:00Z), its 14 visible signals --------------

const KC =
  '<ts>,<n> WARN [org.keycloak.events] (executor-thread-<n>) type="LOGIN_ERROR", realmId="<uuid>", realmName="stark", clientId="stark-backend-client", userId="null", ipAddress="<ip>", error="user_not_found", auth_method="openid-connect", grant';
const EARLIER = '2026-10-28T08:00:00.000Z';
const CARD_1400: FlaggedRow[] = [
  row('logs', 'keycloak-production', KC, 10, { verdict: 'spike', novelty: 'worse', firstSeen: '2026-10-24T04:30:00.000Z', h1: 2, z: 10 }),
  row('http', 'product-catalog-service-production', '/v3/product-catalog/products/:slug/configurator', 9, { status: '404', novelty: 'reminder', firstSeen: '2026-10-27T23:30:00.000Z', z: 9.3 }),
  row('http', 'ecom-service-production', '__unmatched__', 8, { status: '404', verdict: 'spike', z: 8.4, totals: { now: 80, h1: 70, d1: 53, d7: 63 } }),
  row('traces', 'stock-sync-service-production', 'GET', 12, { verdict: 'spike', novelty: 'reminder', firstSeen: EARLIER, h1: 1, expected: 1, z: 7.8 }),
  row('traces', 'auth-service-production', 'POST /v3/auth/session/derive-web', 5, { novelty: 'reminder', firstSeen: EARLIER, z: 5 }),
  row('logs', 'backend-production', 'Vehicle not found', 4),
  row('logs', 'backend-production', 'Ride with id <hex> not found', 4),
  ...['sl-SI', 'fr-FR', 'hu-HU'].map((l) => row('logs', 'frontend-next-production', `Error: MISSING_MESSAGE: more (${l})`, 4, { novelty: 'reminder', firstSeen: EARLIER })),
  row('traces', 'ecom-service-production', 'GET /v3/ecom/orders', 6, { verdict: 'spike', novelty: 'reminder', firstSeen: EARLIER, h1: 1, expected: 1, z: 3.5 }),
  ...['image', 'keywords'].map((k) => row('logs', 'frontend-next-production', `Error: MISSING_MESSAGE: checkout_seo_page_${k} (de-DE)`, 8, { verdict: 'spike', novelty: 'reminder', firstSeen: EARLIER, h1: 3, expected: 2, z: 3.5 })),
  row('http', 'ecom-service-production', '/v3/ecom/cart', 7, { status: '404', verdict: 'spike', novelty: 'reminder', firstSeen: EARLIER, h1: 2, expected: 1.8, z: 3.1 }),
];

test('the 14:00Z card: summary first, one line to look at, repeats collapsed, nothing cut', () => {
  const owners = new Owners({ owners: { 'keycloak-*': '<@U0EXAMPLE1>', 'frontend-next-*': '<!subteam^S0EXAMPLE2>' } });
  const c = patrolCard(summary(CARD_1400), 'not investigated: LLM disabled for this run', { owners, protected: (r) => new Noise({}).protected(r), ref: 'patrols/20261029T140000Z.md' });
  const [title, look, ongoing, quiet, footer] = mrkdwn(c);
  assert.equal(title, '*Patrol 2026-10-29 14:00Z: 1 to look at · 10 still ongoing · 3 quiet* · cc <@U0EXAMPLE1>');
  assert.equal(
    look,
    '*To look at*\n• *keycloak-production* · logs `LOGIN_ERROR user_not_found (stark-backend-client)` — now 10 (1h ago 2) vs expected 0 · spike, worse, started · since 10-24 04:30Z <@U0EXAMPLE1>',
  );
  assert.match(ongoing!, /• \*frontend-next-production\* · logs `MISSING_MESSAGE: more` — 3 locales: sl-SI, fr-FR, hu-HU · now 12/);
  assert.match(ongoing!, /`MISSING_MESSAGE: … \(de-DE\)` — 2 variants: checkout_seo_page_image, checkout_seo_page_keywords/);
  assert.equal(ongoing!.split('\n').length, 1 + 7);
  assert.ok(!ongoing!.includes('S0EXAMPLE2'), 'reminders ping no one');
  assert.match(quiet!, /`Vehicle not found` \(4\).*`Ride with id … not found` \(4\).*`__unmatched__ 404` \(8\)/);
  assert.equal(footer, 'not investigated: LLM disabled for this run');
  assert.ok(JSON.stringify(c.blocks).length < 3000);
});
