// Probe: does a real WebFetch result get its evidence id and stay redacted?
// Run outside any sandbox: node --disable-warning=ExperimentalWarning --import tsx scripts/probe-webfetch.mts
import { Evidence, evidenceHook } from '../src/engine/evidence.ts';
import { sdkSession } from '../src/engine/session.ts';
import { loadDotEnv } from '../src/config.ts';

loadDotEnv();
const ev = new Evidence();
const t0 = Date.now();
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 180_000);
let text = '';
try {
  for await (const e of sdkSession({
    model: 'claude-sonnet-5-5',
    system: 'Use WebFetch once, then reply with the evidence_id you were given for the result and one sentence quoted from it.',
    prompt: 'WebFetch https://code.claude.com/docs/en/agent-sdk/agent-loop with prompt "quote the sentences about maxBudgetUsd".',
    tools: [],
    builtin: ['WebFetch'],
    hooks: { PostToolUse: [evidenceHook(ev, 'author')] },
    maxTurns: 3,
    maxBudgetUsd: 0.2,
    abort,
    cwd: process.cwd(),
  }))
    if (e.kind === 'result') text = `${e.subtype} $${e.cost.toFixed(3)} :: ${e.text}`;
} catch (err) {
  text = `session error: ${(err as Error).message}`;
}
clearTimeout(timer);
console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);
for (const i of ev.items.values()) console.log(`${i.id} ${i.tool} ${i.text.slice(0, 160).replace(/\n/g, ' ')}`);
console.log(ev.items.size ? 'PASS: WebFetch result stamped' : 'FAIL: no stamped WebFetch result');
console.log(text.slice(0, 500));
