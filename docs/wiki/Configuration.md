# Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and fill in the required values.

## Required Variables

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from the [Discord Developer Portal](https://discord.com/developers/applications) |
| `DISCORD_APPLICATION_ID` | Application ID from the same portal |

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
| `channelId` | Yes | Discord text channel ID for posting updates |
| `baseUrl` | Yes | Public status page URL (Statuspage.io e.g. `https://status.atlassian.com`, incident.io e.g. `https://status.openai.com`, or Instatus e.g. `https://status.perplexity.com`) |
| `label` | No | Display name shown in embeds and command output |
| `iconUrl` | No | Custom icon URL for embeds. Overrides auto-detected favicon. Useful when a page's favicon doesn't work in Discord (e.g. extensionless URLs). |
| `provider` | No | Provider ID: `statuspage` (default), `incidentio`, or `instatus`. If omitted, `statuspage` is assumed — set to `incidentio` explicitly for incident.io pages or `instatus` for Instatus pages. Runtime monitors added via `/monitor add` have this set automatically based on probe results. |

### Option B: Legacy Single-Monitor

```env
DISCORD_CHANNEL_ID=123456789
STATUSPAGE_BASE_URL=https://status.atlassian.com
```

This creates a single monitor with ID `default`. If `MONITORS_JSON` is set, these two variables are ignored.

If neither approach is configured, the bot exits at startup with `Configure either MONITORS_JSON or both DISCORD_CHANNEL_ID and STATUSPAGE_BASE_URL.`

### Deprecated: `STATUSPAGE_MONITORS_JSON`

The project was formerly named `statuspage-discord`, and its multi-monitor variable was `STATUSPAGE_MONITORS_JSON`. That name is still honored as an alias for `MONITORS_JSON`, but logs a deprecation warning at startup and will be removed in a future release. If both are set, `MONITORS_JSON` wins and no warning is emitted. Rename it when convenient — the value format is identical.

### Runtime Monitors

Monitors can also be added at runtime via `/monitor add`. These are persisted in `data/monitors.json` and survive restarts. Environment-configured monitors take precedence over runtime monitors with the same ID.

## Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_GUILD_ID` | — | Guild ID for faster command registration during development. When set, commands are guild-scoped instead of global. |
| `POLL_INTERVAL_MS` | `60000` | How often (in ms) to poll each status page |
| `POST_EXISTING_UPDATES_ON_START` | `false` | When `true`, posts all visible incident updates on first startup instead of silently seeding them |
| `APP_VERSION` | `package.json` version | Version string displayed in the bot's rotating Discord presence. Auto-set during Docker builds via build arg. |

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

## Discord Bot Permissions

The bot requires these permissions in each monitor channel:

| Permission | Purpose | Checked by `/monitor add` |
|------------|---------|---------------------------|
| Send Messages | Post incident embeds | Yes |
| Embed Links | Render rich embeds | Yes |
| Create Public Threads | Create incident threads | Yes |
| Send Messages in Threads | Post incident updates inside those threads | No |
| Manage Messages | Pin/unpin incident parent messages, prune pin notices | No |
| Read Message History | Scan threads for deduplication during replay | No |

`/monitor add` validates only the first three before accepting a new monitor — it will happily add a monitor that later can't pin or post into threads. Pin and unpin calls are best-effort and their failures are swallowed, so a bot without Manage Messages still posts incidents, just unpinned. Grant all six for full behavior.

Administrative commands (`/testpost`, `/replay`, `/clean`, `/cleanup`, `/monitor`) require the **Manage Server** permission.

## Gateway Intents

The bot only needs the `Guilds` intent. No message content or presence intents are required.
