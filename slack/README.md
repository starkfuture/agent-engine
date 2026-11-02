# Slack app

The "Agent Engine" Slack app (app id `A0CCRGAHVGF`, workspace `starkfuture`), managed with the Slack CLI from this folder. The CLI reads `manifest.json` through `.slack/hooks.json`. The `sh -c` wrapper is there because the CLI appends `--source` to the hook command.

- **Change the app:** edit `manifest.json`, then run `slack manifest validate` and `slack install` from this folder. New bot scopes need a reinstall, and the workspace may ask an admin to approve them.
- **Bot token:** after install, the bot token (`xoxb-…`) is under OAuth & Permissions in the app settings. It goes into the engine's secret as `SLACK_BOT_TOKEN`, never into git.
- **Channel:** invite the bot to the channel it posts to (`/invite @Agent Engine`) and set `SLACK_CHANNEL_ID` (prod: `C0CBLUZLW4S`, #prod-monitor-shadow).
