# Slack app

The "Agent Engine" Slack app (app id `A0CCRGAHVGF`, workspace `starkfuture`), managed with the Slack CLI from this folder. The CLI reads `manifest.json` through `.slack/hooks.json`. The `sh -c` wrapper is there because the CLI appends `--source` to the hook command.

- **Change the app:** edit `manifest.json`, then run `slack manifest validate` and `slack install` from this folder. New bot scopes need a reinstall, and the workspace may ask an admin to approve them.
- **Bot token:** after install, the bot token (`xoxb-…`) is under OAuth & Permissions in the app settings. It goes into the engine's secret as `SLACK_BOT_TOKEN`, never into git.
- **Channel:** invite the bot to the channel it posts to (`/invite @Agent Engine`) and set `SLACK_CHANNEL_ID` (prod: `C0CBLUZLW4S`, #prod-monitor-shadow).

## Buttons: On it and Not an issue

The buttons on an issue's message come in over Socket Mode: the engine opens a WebSocket to Slack, so it needs no public URL and no signing secret. They are off until `SLACK_APP_TOKEN` is set. Without it, the engine posts exactly as before. Two fixes apply either way: a failed post waits for its backoff and Slack's `Retry-After`, and the daily reminder counts posts Slack accepted, not posts queued.

What the app needs:
- **Socket Mode and interactivity on.** Both are in `manifest.json`. Interactivity needs no request URL with Socket Mode.
- **Bot scope `chat:write` only.** It covers posting, `chat.update` (the message a button is on) and `chat.postEphemeral`. The reply only the clicker sees goes to the click's `response_url`, which needs no scope. `auth.test` (the workspace the bot is in) needs none either.
- **An app-level token with `connections:write`.** It starts `xapp-` and is not the bot token. A manifest can't create it.

Activation, in order:
0. **The bot posts in prod first:** `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` are in the secret and the bot is in the channel. Buttons need the bot. The manifest drops `incoming-webhook`, so applying it retires the webhook URL; apply it only once the bot is live.
1. **Enable Socket Mode.** From this folder: `slack manifest validate`, then `slack install`. Or turn on Socket Mode and Interactivity in the app settings.
2. **Create the app-level token.** App settings → Basic Information → App-Level Tokens → Generate, with the scope `connections:write`.
3. **Add it to the ASM secret `agent-engine-production` as `SLACK_APP_TOKEN`.** Every key in that secret becomes an env var. Go through files, so the token is never on a command line or in shell history:

   ```bash
   umask 077; d=$(mktemp -d)
   pbpaste > "$d/token"   # the xapp- token, copied from the app settings
   aws secretsmanager get-secret-value --secret-id agent-engine-production --query SecretString --output text > "$d/secret.json"
   jq --rawfile t "$d/token" '.SLACK_APP_TOKEN = ($t | rtrimstr("\n"))' "$d/secret.json" > "$d/new.json"
   aws secretsmanager put-secret-value --secret-id agent-engine-production --secret-string "file://$d/new.json"
   rm -P "$d"/*; rmdir "$d"
   ```
4. **Roll the pod** once the secret has synced into the cluster. The log says `Slack Socket Mode connected: buttons on`. Issues opened before that get their buttons with their next post.

The app id comes from the token (`xapp-1-A…-…`); set `SLACK_APP_ID` only if the token doesn't carry it. The workspace comes from the bot. Buttons run in the process that posts the patrol (`loop --post`, or `serve --patrol --post`). The namespace already allows external egress; the connected log is the check that Socket Mode gets out.

