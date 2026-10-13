# sre-agent

An AI SRE patrol for Stark's production platform. Every 15 minutes, code builds a **not-200 summary** of production. When something is new or worse, an LLM investigator works out what broke, since when, the impact and the likely cause, and writes a card.

Read-only everywhere: it recommends and never acts. Paging stays with deterministic rules, and this agent never suppresses them.

## How a patrol works

1. **Summary (code, no LLM).** For every source, it compares the last 15 min with the same window **1 h, 1 d and 7 d** earlier:
   - **HTTP:** every route × status that isn't 2xx/3xx, across the V3 services, legacy `/v1`, Keycloak and the mesh, plus traffic drops.
   - **Workloads:** restarts, stuck containers, unavailable replicas.
   - **Error counters:** for example SQS consumer errors.
   - **Logs:** error lines grouped into stable templates.
   - **Traces:** error traces by root operation.
2. **Filter.** Steady rows, known noise (`config/noise.yaml`) and already-reported rows are dropped. A quiet patrol ends here and costs $0.
3. **Investigate.** Only if rows remain, the Agent SDK runs one investigator. It has read-only tools and no shell or files, and must submit schema-checked reports that cite evidence ids.
4. **Card.** Cards go to `out/cards/`, and to Slack only with `--post` and a webhook. Rows the investigator didn't cover still get a card.

The baseline is `min(1 d, 7 d)`, scaled by current traffic, so a one-day incident doesn't become its own baseline the next day. The 1 h window only labels a row "started" or "ongoing".

## Run it

```bash
npm install
cp .env.example .env          # set LOKI/TEMPO uids after `doctor`
npm run dev -- doctor         # VPN on: checks access and shows the real metric labels
npm run dev -- patrol         # one patrol now, no LLM
npm run dev -- patrol --llm   # with the investigator (ANTHROPIC_API_KEY or Bedrock)
npm run dev -- loop --llm     # every 15 min (local shadow)
```

### Replay and backtest

```bash
# Record the 29 Sep → 2 Oct incident before Prometheus retention drops it (~27 Oct):
npm run dev -- export --from 2026-09-29T00:00:00Z --to 2026-10-02T23:45:00Z --out data/incident-0929

# Replay it offline, step by step, as the patrol would have seen it:
npm run dev -- replay --from 2026-09-29T00:00:00Z --to 2026-10-01T00:00:00Z --replay data/incident-0929
```

**Pass condition:** the sign-up and password-reset 400s on the legacy `/v1` series show up as fresh rows at the start of the incident, and the known noise stays quiet.

### Tests

```bash
npm test             # unit and patrol tests on a synthetic 29 Sep incident
npm run typecheck
npm run smoke:llm    # real model, fake telemetry: checks the LLM path without VPN
```

## Layout

| Path | What |
|---|---|
| `config/sources.yaml` | What the patrol reads. Labels marked UNVERIFIED need `doctor` first. |
| `config/noise.yaml` | Known noise (reason and expiry required) and the never-suppress list. |
| `src/clients/telemetry.ts` | Grafana datasource proxy client (Prometheus, Loki, Tempo), plus record and replay. |
| `src/patrol/` | Collectors, scoring, noise, state, summary. |
| `src/investigate/` | Tools, prompt, report schema, Agent SDK runner. |
| `src/output/` | Card rendering (Slack Block Kit and Markdown) and the sink. |
| `src/runner.ts`, `src/cli.ts` | Patrol orchestration and commands. |

## Guardrails in code

- **Telemetry is read-only by construction.** The client has no write method, and Prometheus and Loki calls are concurrency-capped.
- **The model holds no credentials.** Tools run in this process. The SDK subprocess gets only model credentials, with `tools: []`, `settingSources: []`, `strictMcpConfig` and `dontAsk`.
- **PII and secrets are redacted** before anything reaches the model, a card or disk. Log text is fenced as untrusted data.
- **Reports are checked in code:** the zod schema, cited evidence ids must exist, row keys must be real, and a critical report must have measured impact.
- **Spend is capped:** a per-investigation budget (`SRE_MAX_USD_PER_INVESTIGATION`) and a daily cap (`SRE_DAILY_CAP_USD`). The patrol keeps reporting when the cap is reached.

## Not built yet

- Paging and the "on fire" rules: these are Prometheus rules, kept separate on purpose.
- The in-cluster deploy: `sre` namespace, Bedrock EU and three identities.
- Slack thread Q&A.
- Business metrics and support-ticket counts.
- The daily Opus sweep.
- GitHub and code tools for the investigator.
