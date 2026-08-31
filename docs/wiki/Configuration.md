# Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and fill in the required values. Blank values are treated as unset, so placeholder lines like `DISCORD_GUILD_ID=` can be left in place.

## Chat Platform

Squawk drives **one** chat platform per deployment — its state file stores that platform's message and thread IDs, so a single instance cannot serve both.

| Variable | Default | Description |
|----------|---------|-------------|
| `PLATFORM` | inferred | `discord` or `slack`. When unset, inferred from whichever bot token is present. Setting both tokens without `PLATFORM` is an error rather than a silent guess. |

### Discord

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Bot token from the [Discord Developer Portal](https://discord.com/developers/applications) |
| `DISCORD_APPLICATION_ID` | Yes | Application ID from the same portal |
| `DISCORD_GUILD_ID` | No | Guild ID for faster command registration during development. When set, commands are guild-scoped instead of global. |

### Slack

Full walkthrough, app manifest, and scopes: [Slack Setup](Slack-Setup.md).

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot token (`xoxb-…`) from **OAuth & Permissions** |
| `SLACK_APP_TOKEN` | Yes | App-level token (`xapp-…`) with `connections:write`, used for Socket Mode |
| `SLACK_COMMAND_NAME` | No (`squawk`) | Slash command name without the leading slash. Slack command names are unique per workspace — change this if `/squawk` is taken, and match it in the app manifest. |
| `SLACK_ADMIN_USER_IDS` | No | Comma-separated user IDs allowed to run the destructive subcommands. Unset means every workspace member can. |

## Monitor Configuration

You must configure monitors using **one** of these two approaches:

### Option A: Multi-Monitor (Recommended)

```env
MONITORS_JSON=[{"id":"atlassian","channelId":"123456789","baseUrl":"https://status.atlassian.com","label":"Atlassian"},{"id":"openai","channelId":"987654321","baseUrl":"https://status.openai.com","label":"OpenAI","provider":"incidentio"}]
```

Each monitor object requires:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier used in commands and state |
| `channelId` | Yes | Channel to post updates in, on whichever platform is active: a Discord text channel snowflake, or a Slack channel ID like `C0123ABCDEF` |
| `baseUrl` | Yes | Public status page URL (Statuspage.io e.g. `https://status.atlassian.com`, incident.io e.g. `https://status.openai.com`, or Instatus e.g. `https://status.perplexity.com`) |
| `label` | No | Display name shown in embeds and command output |
| `iconUrl` | No | Custom icon URL for embeds. Overrides auto-detected favicon. Useful when a page's favicon doesn't render in the chat client (e.g. extensionless or SVG URLs). |
| `provider` | No | Provider ID: `statuspage` (default), `incidentio`, or `instatus`. If omitted, `statuspage` is assumed — set to `incidentio` explicitly for incident.io pages or `instatus` for Instatus pages. Runtime monitors added via `/monitor add` have this set automatically based on probe results. |

### Option B: Legacy Single-Monitor

```env
DISCORD_CHANNEL_ID=123456789          # or SLACK_CHANNEL_ID=C0123ABCDEF
STATUSPAGE_BASE_URL=https://status.atlassian.com
```

This creates a single monitor with ID `default`. Squawk reads `DISCORD_CHANNEL_ID` or `SLACK_CHANNEL_ID` depending on the active platform. If `MONITORS_JSON` is set, these variables are ignored.

### Runtime Monitors

Monitors can also be added at runtime via `/monitor add`. These are persisted in `data/monitors.json` and survive restarts. Environment-configured monitors take precedence over runtime monitors with the same ID.

## Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_INTERVAL_MS` | `60000` | How often (in ms) to poll each status page |
| `POST_EXISTING_UPDATES_ON_START` | `false` | When `true`, posts all visible incident updates on first startup instead of silently seeding them |
| `APP_VERSION` | `package.json` version | Version string displayed in the bot's rotating Discord presence. Auto-set during Docker builds via build arg. Slack has no bot presence, so it is only logged at startup there. |

## Feature Flags

All default to `true`. Set to `false` to disable the corresponding command.

| Variable | Command |
|----------|---------|
| `ENABLE_STATUS_COMMAND` | `/status` |
| `ENABLE_TEST_COMMAND` | `/testpost` |
| `ENABLE_REPLAY_COMMAND` | `/replay` |
| `ENABLE_CLEAN_COMMAND` | `/clean` |
| `ENABLE_MONITOR_COMMAND` | `/monitor` |
| `ENABLE_CLEANUP_COMMAND` | `/cleanup` |

Boolean values accept: `true`, `1`, `yes`, `on` (truthy) or `false`, `0`, `no`, `off` (falsy).

## Permissions

### Discord

The bot requires these permissions in each monitor channel:

| Permission | Purpose |
|------------|---------|
| Send Messages | Post incident embeds |
| Embed Links | Render rich embeds |
| Create Public Threads | Create incident threads |
| Manage Messages | Pin/unpin incident parent messages |
| Read Message History | Scan threads for deduplication during replay |

The `/monitor add` command validates these permissions before adding a new monitor.

Administrative commands (`/testpost`, `/replay`, `/clean`, `/cleanup`, `/monitor`) require the **Manage Server** permission.

#### Gateway Intents

The bot only needs the `Guilds` intent. No message content or presence intents are required.

### Slack

Slack grants scopes app-wide rather than per channel; the required set is listed in [Slack Setup](Slack-Setup.md#scopes). Squawk joins public monitor channels itself and needs `/invite @Squawk` for private ones.

Slack has no per-command permission model equivalent to **Manage Server**, so the destructive subcommands are open to every workspace member unless `SLACK_ADMIN_USER_IDS` is set.
