# agent-engine (repo: sre-agent)

A small host for **self-running agents** on the Claude Agent SDK. An agent is a folder; the engine runs it in a fresh session with hard limits, makes every claim cite a real tool result, optionally has a challenger check the answer, and records every run in a ledger. Agents are read-only and produce drafts.

The first agent is **monitor**, an AI SRE patrol (below). The others, **research** (web) and **codebase** (a local folder), take tasks on demand.

Design and research: `../agent_workspace/research/agent-engine-2026-10-14/` (05-DESIGN.md and 08-adjudication.md are the decisions).

## The engine

```bash
npm run dev -- agents                                   # list agents: version, model, tools, limits
npm run dev -- run research --task "How does X do Y?"   # web research, cited findings
npm run dev -- run codebase --path ../backend-nest --task "Where is the token validated?"
npm run dev -- run research --task "..." --challenge    # plus an independent challenger
npm run dev -- runs                                     # ledger: status, cost, challenge verdict
npm run dev -- stop | resume                            # kill switch for every agent
```

**An agent folder** (`agents/<name>/`):

| File | What |
|---|---|
| `agent.yaml` | Model, interval, built-in tools, limits (turns, $/run, $/day, deadline), challenge policy, sinks |
| `CLAUDE.md` | The system prompt |
| `memory/lessons.md` | Read at every run start; curated by humans |
| `memory/proposed.md` | Where runs propose lessons; a human promotes them (gitignored) |
| `skills/`, `agents/` | Claude Code skills and subagents, loaded as a local plugin |

Code-driven parts (a deterministic gate, credentialed tools, output checks) live in `src/`. The monitor's are `src/runner.ts` and `src/investigate/`.

**What the engine enforces, in code:**
- **Fresh session per run.** No `settingSources`, so no parent `CLAUDE.md` or settings. A throwaway `HOME`. Skill shell execution is off. The model holds no credentials: credentialed tools run in the engine process.
- **Rule of Two.** An agent can't have both sensitive reads (local files or credentialed tools, including tools passed in code) and web tools. It's checked at load and again at run time. Agent folders can't carry hooks or settings.
- **File access is a snapshot, not a filter.**
  - The codebase agent reads a temp copy of **one commit** (`--ref`, default `origin/HEAD`, else `HEAD`; never uncommitted edits), with secret files (`.env*`, keys, `.npmrc`, `tfstate`, …), symlinks and submodules removed. No search pattern can reach what isn't there. The answer names the commit it read.
  - The copy is streamed from `git cat-file` asynchronously, so a large repo doesn't stall the server.
  - The CLI's own `blockReadsOutsideWorkingDirectories` and `Read(...)` deny rules check every file a search touches.
  - A small hook catches `~`, `..` and absolute escapes early.
- **Evidence.**
  - Every tool result is redacted, fenced as untrusted data and stamped with a per-run id (`E-7f3a-4`).
  - Answers come only through a submit tool. Every cited piece of evidence needs an **exact quote** that the engine finds in that tool result.
  - Redaction walks structured values before anything is serialised, so JSON escaping can't hide a secret. It's a backstop; the boundary is what agents can reach.
  - The evidence hook fails closed.
- **Admission is one SQLite transaction** (`runs/engine.db`): caps per agent and global, with running runs counted at their reservation, plus one run per agent. Two processes can't both pass a cap.
  - A crashed run, whose process is gone or which is far past its deadline, is settled at its full reservation.
  - Spend counts on the day the run started.
  - Every entry point (patrol, loop, run, replay) shares the same store and STOP file.
- **Limits:** max turns, $ per run, a wall-clock deadline, loop detection (the same call 3×) and the STOP file. Every admitted run is settled, even when setup or bookkeeping throws.
- **challenge-lite.** One blind challenger in a fresh session, with the task, the context, the output and the same read tools, but not the author's system prompt.
  - A blocking objection needs a failure scenario, a settling check and a real evidence id; otherwise it becomes a note.
  - The verdict is `upheld` or `escalate` (a human decides), with no rebuttal round and no consensus-seeking.
  - A challenge that failed, ended without a result, or checked nothing itself is `error`, never `upheld`. Only the first submission counts. The challenger has its own loop detector.
- **Run folder** `runs/<agent>/<run>/`: `input.md`, `transcript.jsonl`, `evidence.jsonl`, `output.json`, `challenge.json`, `answer.md` (with any dissent). All of them are redacted.
- **Model-written text for humans** (cards): redacted per field, image syntax removed, links to unknown hosts defanged.

Review and research behind v0.2: `../agent_workspace/research/agent-engine-2026-10-14/` (09–12).

## The monitor agent

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
3. **Card first.** The rows card goes to `out/cards/` (and to Slack with `--post` and a webhook) before any AI runs. If the investigator crashes, the rows are still marked reported.
4. **Investigate.** Only if rows remain, the engine runs the `monitor` agent. It has read-only telemetry tools and no shell, files or web, and must submit schema-checked reports that cite evidence ids.
5. **Challenge.** For protected journeys or big spikes (a deterministic gate, never the model's severity), a challenger re-checks the report. Its verdict goes on the card.

The baseline is `min(1 d, 7 d)`, scaled by current traffic, so a one-day incident doesn't become its own baseline the next day. The 1 h window only labels a row "started" or "ongoing".

### The rows card

One summary line first, for example `Patrol 2026-10-29 14:00Z: 1 to look at · 10 still ongoing · 3 quiet · cc @owner`, then:

- **To look at:** fresh or worse rows, by severity: protected journeys (`never_suppress`), then outages (5xx, traffic drops, workloads), error counters and traces, error logs, then 4xx. Each line has the service, a short subject, now vs expected (and 1 h ago), the verdict and trend, since when, and the owner's mention.
- **Still ongoing:** reminders (reported before, not worse), one compact line each, no stats beyond the count.
- **Quiet:** fresh or worse HTTP, log, trace and counter rows under `PATROL_ATTENTION_FLOOR` events in the window (default 10). Listed, never mentioned. Workload rows, traffic drops and protected journeys are never quiet. The floor only changes the card: detection, state and what the investigator sees stay the same.

Rows of one service whose text differs in a single token (a locale, a status, a queue name) share a line: `MISSING_MESSAGE: more — 3 locales: sl-SI, fr-FR, hu-HU`. Log subjects show the meaningful part (for Keycloak events: type, error, client), without timestamps, thread names or placeholders.

Slack gets at most 10 lines to look at, 6 ongoing and 8 quiet, cut at whole lines well under its 3000-character section limit, then "…and N more" (which still mentions the owners of the cut lines). The full list stays on the engine in `out/patrols/<stamp>.md`, and the card's own file in `out/cards/` lists every line.

**Owners** (`config/owners.yaml`, or `SRE_OWNERS_FILE`) map a service name, a `prefix-*` or a `/regex/` to `<@U…>` (a person) or `<!subteam^S…>` (a user group). Lines to look at mention the owner and the summary line lists everyone mentioned; a service that matches nothing gets no mention. Only these two forms load (anything else, such as `<!channel>`, stops the engine), and they are the only text on the card that reaches Slack unescaped. `mentions: false` in the file turns them off. The shipped file has examples only.

## Run it

```bash
npm install
cp .env.example .env          # set LOKI/TEMPO uids after `doctor`
npm run dev -- doctor         # VPN on: checks access and shows the real metric labels
npm run dev -- patrol         # one patrol now, no LLM
npm run dev -- patrol --llm   # with the monitor agent (ANTHROPIC_API_KEY or Bedrock)
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
npm test             # engine rules (fake model session) and the patrol on a synthetic 29 Sep incident
npm run typecheck
npm run smoke:llm    # real model, fake telemetry: the monitor + challenger end to end, without VPN
```

## Layout

| Path | What |
|---|---|
| `config/sources.yaml` | What the patrol reads. Labels marked UNVERIFIED need `doctor` first. |
| `config/noise.yaml` | Known noise (reason and expiry required) and the never-suppress list. |
| `config/owners.yaml` | Service → Slack mention for the rows card. Ships with examples only. |
| `src/clients/telemetry.ts` | Grafana datasource proxy client (Prometheus, Loki, Tempo), plus record and replay. |
| `src/patrol/` | Collectors, scoring, noise, state, summary, owners, and the card digest (ranking, floor, grouping). |
| `src/engine/` | The engine: agent loader, run, session (SDK), evidence, guard, ledger, challenge, generic output. |
| `agents/` | Agent folders: `monitor`, `research`, `codebase`. |
| `src/investigate/` | Monitor: telemetry tools, task prompt, report schema. |
| `src/output/` | Card rendering (Slack Block Kit and Markdown) and the sink. |
| `src/runner.ts`, `src/cli.ts` | Patrol orchestration (card first, challenge gate) and commands. |

## Guardrails in code

- **Telemetry is read-only by construction.** The client has no write method, and Prometheus and Loki calls are concurrency-capped.
- **The model holds no credentials.** Tools run in this process. The SDK subprocess gets only model credentials, with no built-in tools, `settingSources: []`, `strictMcpConfig` and `dontAsk`.
- **PII and secrets are redacted** before anything reaches the model, a card or disk. Log text is fenced as untrusted data.
- **Reports are checked in code:** the zod schema, cited evidence ids must exist, row keys must be real, and a critical report must have measured impact.
- **Spend is capped** by the engine: `agents/monitor/agent.yaml` limits plus `ENGINE_DAILY_CAP_USD` and `ENGINE_MONTHLY_CAP_USD` (all agents). Set a spend limit on the Anthropic workspace too: the SDK checks a run's budget between turns, so one run can overshoot by a turn. The patrol keeps reporting when a cap is reached.

## Not built yet

- **Engine (see 12-v0.2-plan.md for reasons):**
  - launchd/cron scheduling, plus a process-group supervisor for hard kills (`loop` covers the monitor today);
  - a provider-side cap (an Anthropic workspace monthly limit) as the outer boundary: an owner setting, not code;
  - a credential-injecting proxy and an OS sandbox (`srt`) around the subprocess;
  - Slack or webhook task intake;
  - a cross-vendor challenger;
  - memory consolidation;
  - OTEL;
  - action runs behind approval buttons.
- **Monitor:**
  - a replay eval harness on labelled incidents (needs the 09-29 export), then hypothesis lists with code-derived confidence, the engine re-running cited queries, and pinned starter queries;
  - Paging and the "on fire" rules: these are Prometheus rules, kept separate on purpose.
  - The in-cluster deploy: `sre` namespace, Bedrock EU and three identities.
  - Slack thread Q&A.
  - Business metrics and support-ticket counts.
  - The daily Opus sweep.
  - GitHub and code tools for the investigator.

## MCP server: one engine, several developers

One process holds the engine: budgets, run history, the kill switch, and the
credentials. Each person connects from Claude Code (or any MCP client) as
themselves: hosted, through the company Keycloak sign-in; locally, with a token
from the CLI.

Hosted (an admin invites the email first):

```bash
claude mcp add --transport http agent-engine https://agent-engine.starkfuture.com/mcp --client-id agent-engine --callback-port 33419
```

Locally:

```bash
npm run dev -- user add ana --slack U0123ABCD        # prints a token once; only its hash is stored
npm run dev -- user add lead --admin                 # admins also get stop_all/resume/approve_lesson
cp config/repos.example.yaml config/repos.local.yaml # repos the codebase agent may read on this host
npm run dev -- serve --port 8787                     # http://127.0.0.1:8787/mcp
```

Each developer:

```bash
export ENGINE_TOKEN=eng_…
claude mcp add --transport http engine http://<host>:8787/mcp --header "Authorization: Bearer $ENGINE_TOKEN"
```

Tools: `list_agents`, `list_repos`, `run_agent` (background; `wait_seconds` ≤ 55
for short runs), `get_run`, `get_evidence`, `list_runs`, `cancel_run`, `spend`,
`proposed_lessons`; admins add `approve_lesson`, `stop_all`, `resume`.

- Who can read a run: the requester and admins, unless the agent has `visibility: everyone` in agent.yaml (monitor, research and codebase do). Someone else's private run answers like a missing one. Agents that read customer data keep the default.
- Requests with a browser `Origin` header are refused unless listed in `ENGINE_ALLOWED_ORIGINS`.
- The task is redacted before the model sees it. Answers keep links (research cites sources) but lose images, which load by themselves.
- Every run records the engine build (`ENGINE_BUILD`, else the git commit). With `ENGINE_MEMORY_DIR`, lessons approved over MCP and runs' proposals live there (a persistent volume), next to the git-curated `agents/<name>/memory/lessons.md`.
- Hosted: `serve --patrol --llm --metrics-port 9464` runs the MCP endpoint and the monitor's patrol in one process. Telemetry goes straight to the in-cluster backends (`PROMETHEUS_URL`, `LOKI_URL` + `LOKI_ORG_ID`, `TEMPO_URL`); locally it goes through Grafana with a token. Tempo searches are capped at 30 minutes, and regexes starting with `.*` are refused (Tempo is shared).
- `/metrics` (own port) for the heartbeat alert: `engine_up`, `engine_patrol_last_success_timestamp_seconds`, `engine_patrol_source_up{source}` (blind spots), `engine_runs_today`, `engine_spend_usd` and the caps.
- `ENGINE_AGENTS` limits which agents a deployment offers. Web-reading agents (research, later ticket triage) run in their own deployment with no access to prod telemetry or the cluster.
- Hosted, people sign in through Keycloak (`KEYCLOAK_ISSUER`): the engine is a plain OAuth resource server, so Claude Code finds Keycloak through `/.well-known/oauth-protected-resource/mcp`, signs the person in with the public `agent-engine` client (PKCE) and renews the token itself. Add it with `claude mcp add --transport http agent-engine <ENGINE_PUBLIC_URL>/mcp --client-id agent-engine --callback-port 33419`. Every token is checked against the realm's keys: RS256 only, issuer, audience and client `agent-engine`, an access token (not ID or refresh), unexpired, no impersonation, and a verified email on `ENGINE_LOGIN_DOMAIN`. Locally, `user add` issues tokens that expire after at most 90 days (`--days`).
- CI: `agent-engine-ci.yml` gates PRs; a push to `main` builds one image and deploys both apps through argo-cd. Changes go through PRs.
- Hosted repos: an entry in the repos file may be `name: { github: owner/repo, ref?: … }`. With `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` and `GITHUB_APP_PRIVATE_KEY_FILE` (a GitHub App with contents: read), `serve` clones each into `ENGINE_REPOS_DIR/<name>` and fetches every 10 min. Clones are full with no checkout, so snapshots never need the network. The installation token reaches git through `GIT_CONFIG_*` environment variables, never argv or a stored config. Freshness per repo: `engine_repo_last_fetch_timestamp_seconds` and `engine_repo_sync_ok`.
- A sign-in maps only to a user bound to the same email; it never adopts a CLI-made user. With the sign-in on, `user add` is refused and CLI tokens are not accepted, and a company account alone is not enough: only emails an admin invited (`invite_user` MCP tool or `user invite <email>`) get in. `ENGINE_ADMINS` seeds the first admins into the users file at startup, and only while it has no admin; after that the file alone decides, so removing or demoting someone sticks. Admin tools re-check the caller's current role before acting. Writers (server and CLI) take a lock and re-read the file, so they can't undo each other. `remove_user` revokes access on the next request, and `list_users` shows each user and how they sign in.
- CI deploys only when the repo variable `PROD_DEPLOY` is `true`; until then every run on `main` is build-only. Each deployment has its own public URL and MCP server name (`agent-engine`, `agent-engine-web`).
- Retention (`serve`): run folders and cards older than `ENGINE_RETENTION_DAYS` (default 30) are deleted hourly; the SQLite ledger stays. New runs are refused below 200 MB free; `engine_data_free_bytes` feeds an alert.
- `prod` agent: ask questions about production right now over MCP ("is sign-in failing?", "did the 14:00 deploy go well?"). It gets the monitor's read-only Prometheus/Loki/Tempo tools (`tool_pack: telemetry`), no web, shell or files, and its answers are visible only to the asker. An agent may declare a tool pack only with `sensitive_tools: true`, and never next to web tools.
- Tempo: regex matches (`=~`, `!~`) are refused; exact matches only.
- A source that answers with no series at all is reported blind, not healthy: each HTTP family and the workloads source (kube-state-metrics) run a `count(...)` presence check, so a stopped scrape fires the blind-spot alert instead of looking like a quiet system. Error counters are exempt: a labelled counter has no series until its first error.
- Runs are recorded with who asked. Per person: `ENGINE_USER_DAILY_CAP_USD` (default 10)
  and `ENGINE_USER_MAX_RUNNING` (default 2); per agent: `concurrency` in agent.yaml.
- `ENGINE_NOTIFY_SLACK=1` with `SLACK_WEBHOOK_URL` @-mentions the requester when a run ends. Model text in Slack is escaped, so it can't ping (`<!channel>`) or hide links.
- SIGTERM/Ctrl-C stops running runs and waits (≤ 20 s) until each is settled and its requester notified. A run whose process died stops beating and is reaped within 2 min, even if a restarted server got the same pid.
- Callers name a repo; they never pass a path. Scheduled agents (monitor) can't be started over MCP.
- Bind is loopback by default. Anywhere else, `serve` refuses to start without the Keycloak sign-in (CLI tokens are loopback-only), and TLS goes in front (tokens travel in a header).
- `mcp-stdio --as <user>` serves the same tools over stdio for one local user.
