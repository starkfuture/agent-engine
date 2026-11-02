# Slack app

The "Agent Engine" Slack app (app id `A0CCRGAHVGF`, workspace `starkfuture`), managed with the Slack CLI from this folder. The CLI reads `manifest.json` through `.slack/hooks.json`. The `sh -c` wrapper is there because the CLI appends `--source` to the hook command.

- **Change the app:** edit `manifest.json`, then run `slack manifest validate` and `slack install` from this folder. New bot scopes need a reinstall, and the workspace may ask an admin to approve them.
- **Bot token:** after install, the bot token (`xoxb-…`) is under OAuth & Permissions in the app settings. It goes into the engine's secret as `SLACK_BOT_TOKEN`, never into git.
- **Channel:** invite the bot to the channel it posts to (`/invite @Agent Engine`) and set `SLACK_CHANNEL_ID` (prod: `C0CBLUZLW4S`, #prod-monitor-shadow).

## Interactive mode (optional)

The manifest now declares Socket Mode, interactivity, and `app_mention` with the `app_mentions:read` bot scope. It does not request channel history, DMs, email lookup, admin access or Monday access. Incoming webhooks remain available. Editing this file does not apply app settings remotely.

Activation after reviewing/building the engine change:

1. Apply/validate the manifest and reinstall the app for the new scope. An admin may need to approve it. Existing app/workspace: `A0CCRGAHVGF` / `T02E68USQHW`.
2. In Slack app settings, Basic Information → App-Level Tokens, create a separate app-level token with `connections:write`. It starts `xapp-`; it is different from the `xoxb-` bot token. Store both through the existing secret mechanism. Never put credentials in git, chat or screenshots.
3. Configure `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID`, `SLACK_APP_ID`, and `SLACK_CHANNEL_ID` together. The server refuses incomplete Socket Mode configuration. The normal production `serve --patrol --llm --post` command starts the receiver; `loop`, replays and runs without `--post` do not enable controls.
4. An engine admin binds each invited engine user to their Slack member ID using MCP `bind_slack_user {user: "<engine-name>", slack_id: "U…"}`. Omitting `slack_id` unbinds them. Alternatively the existing operator CLI supports `engine user slack <name> --slack U…`. Binding does not invite someone, issue a token or change roles. Workspace membership alone grants no engine access.
5. Confirm the Socket Mode connected log and `notification_status` counts. Do not send a live test message without approving its specific text first.

Socket Mode uses an outbound WebSocket instead of a public callback URL. The inspected production namespace policy allows external egress; no new public ingress is proposed. That policy was inspected in argo-cd source, not probed against a live connection. See [Slack's Socket Mode guide](https://docs.slack.dev/apis/events-api/using-socket-mode/) and [manifest reference](https://docs.slack.dev/reference/app-manifest/).

## Using it after activation

New incident roots get **On it** and **Not an issue** buttons. On it records an owner and updates the original message. Not an issue records a noise-review proposal. Both leave alerting active; neither resolves a signal or changes a noise rule.

Mention `@Agent Engine` in a known incident's thread with a question such as “Is this still happening?”, “Why?”, or “What changed?”. The engine reads its own saved incident context and current read-only telemetry; it does not read arbitrary channel history. Answers are posted into that shared channel/thread, so do not ask for information that should not be visible there. Full answers/evidence are available with `get_run` to the requester and engine admins, as before.

Only bound, still-authorized users in the configured workspace/channel are accepted. The engine checks authorization on receipt, before work and before publishing an answer. Questions use the existing `prod` agent, global/user spending and concurrency caps, deadlines and STOP. One question worker and a separate button worker keep clicks responsive during a long answer. Events persist before acknowledgement; replayed events deduplicate model work and queued replies. Queued requests expire after a day. Network ambiguity at Slack itself still permits at-least-once delivery; local deduplication is not a promise of exactly-once remote delivery.

Unknown threads, top-level mentions, unbound identities, bot/edit events, malformed input and wrong workspace/channel payloads are ignored. Bindings may be removed immediately. `notification_status` exposes queue counts; admins also see failed/expired interaction references for follow-up.

## Notification policy

The current owner preference is **24/7 delivery**. No quiet hours or health notices are enabled by default, and this PR does not change production environment values.

Optional settings for a later explicit configuration:

| Variable | Meaning |
| --- | --- |
| `SLACK_QUIET_HOURS=20:00-08:00` | Hold nonurgent updates during this local interval; requires `SLACK_TIMEZONE` |
| `SLACK_TIMEZONE=Europe/Madrid` | IANA timezone; no timezone is inferred for quiet hours |
| `SLACK_QUIET_WEEKENDS=1` | Also hold nonurgent updates on local Saturday/Sunday |
| `SLACK_DAILY_HEALTH=1` | One status line per local day after the configured time; defaults off |
| `SLACK_DAILY_HEALTH_TIME=09:00` | Local daily-status time; timezone defaults to UTC when quiet hours are off |
| `SLACK_HEALTH_NOTICES=1` | Coverage degraded after two distinct bad patrols, restored after a good observation; defaults off |

Deterministic urgent cards, critical/protected-issue reports and user-requested interaction replies bypass quiet hours. Nonurgent updates persist into one digest at the next open delivery window, including across weekends/restarts. Digest originals are `digested`, not individually `sent`; membership is recorded, and full investigations stay available through run history. Digests summarize up to 500 updates, displaying the first 25; additional retained updates use a later digest. The model investigation schedule is unchanged: this feature changes delivery, not spend timing.

Daily status distinguishes observation coverage, active signals, queue failures and held updates. It cannot report its own complete outage while the engine is down; an independent Prometheus heartbeat alert remains a separate infrastructure follow-up.

## Migration, destinations and rollback

New tables/columns are additive. Existing unknown-scope pending entries, or entries queued for another workspace/channel, are held as `destination_review`, not forwarded into the current destination. Old unscoped thread roots are not accepted as question context. Inspect `notification_status` and review any held entries during activation; do not copy old destination history blindly.

Interaction operations use `pending_interaction`, which older images ignore rather than mistakenly posting an update as a new channel message. On rollback, stop Socket Mode and leave these operations/deferred digests preserved until a compatible worker resumes. Normal monitoring continues through the previous image. Do not delete the ledger or incident exports to roll back.
