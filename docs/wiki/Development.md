# Development

## Prerequisites

- [Bun](https://bun.sh) v1.3 or newer (the published image tracks the latest `oven/bun:*-alpine`)
- Credentials for whichever platform you're developing against:
  - **Discord:** a bot token and application ID ([Discord Developer Portal](https://discord.com/developers/applications)), plus a test server with a text channel
  - **Slack:** a bot token and app-level token, plus a test workspace — see [Slack Setup](Slack-Setup.md)

## Setup

```bash
git clone https://github.com/anthonybaldwin/squawk.git
cd squawk
bun install
cp .env.example .env
# Edit .env with your bot token and channel IDs
```

## Running

```bash
bun dev    # Watch mode — auto-restarts on file changes
bun start  # Single run
```

## Fast Command Registration

**Discord:** set `DISCORD_GUILD_ID` in your `.env` to your test server's ID. This makes slash commands register instantly (guild-scoped) instead of waiting up to an hour for global propagation.

**Slack:** commands come from the app manifest, so there is nothing to register — edit the manifest at [api.slack.com/apps](https://api.slack.com/apps) and the change is live immediately.

## Project Structure

```
src/index.ts                  # Entry point: resolve platform, start poll loop
src/config.ts                 # Env + monitor schemas, platform resolution
src/state.ts                  # data/state.json read/write
src/render.ts                 # Neutral Embed builders + TextFormat interface
src/core.ts                   # Incident lifecycle + command handlers (platform-neutral)
src/platform/                 # Chat platform adapters
  types.ts                    # ChatPlatform interface + capabilities
  discord.ts                  # discord.js adapter
  slack.ts                    # Slack adapter (Socket Mode + Block Kit)
src/providers/                # Per-provider API adapters
  types.ts                    # Canonical Incident/Summary/PageStatus + Provider interface
  index.ts                    # Provider registry + detectProvider()
  statuspage.ts               # Statuspage.io adapter
  incidentio.ts               # incident.io adapter
  instatus.ts                 # Instatus adapter
  *.test.ts                   # Adapter unit tests (bun test)
data/state.json               # Runtime state (auto-created)
data/monitors.json            # Runtime monitors (auto-created)
.env                          # Local secrets (git-ignored)
.env.example                  # Configuration template
```

## Code Organization

Bot logic is split between a platform-neutral core (`src/core.ts` and friends), chat platform adapters in `src/platform/`, and status page adapters in `src/providers/`. See [Architecture](Architecture.md) for a detailed breakdown.

Key conventions:
- Functions are ordered by dependency (callees above callers)
- `src/core.ts` imports neither `discord.js` nor `@slack/*` — platform specifics live behind `ChatPlatform`
- All embed construction is in the `render*` functions, returning the neutral `Embed` type
- State mutations happen in `postLatestUpdatesForMonitor` and command handlers
- Adapters translate "resource is gone" errors into `null` returns rather than leaking error codes into the core

## Type-Checking and Tests

```bash
bun run typecheck    # tsc --noEmit
bun test             # Unit tests
```

The `tsconfig.json` uses strict mode with ES2022 target and Bun module resolution.

Tests live next to the code they cover and run against captured fixtures or stubs, so they need no network access and no bot token. `src/index.ts` guards its bootstrap on `import.meta.main`, so it can be imported from a test without connecting to a chat platform or starting the poll loop.

`src/core.test.ts` runs the whole incident lifecycle against an in-memory `ChatPlatform`, so lifecycle changes can be verified without a live workspace or server. Prefer extending it over manual testing.

## Testing Against a Live Page

1. Set `POST_EXISTING_UPDATES_ON_START=true` to see updates immediately
2. Use `/testpost` to preview status embeds without affecting state
3. Use `/replay` to re-post incident timelines after cleanup
4. Use `/clean` to wipe bot messages when iterating
5. Monitor a status page with frequent incidents (e.g., `https://status.atlassian.com`) for realistic testing

## Docker Development

```bash
docker compose build    # Rebuild image
docker compose up       # Run with logs visible
docker compose down     # Stop and remove container (volume preserved)
```

## Adding a New Command

1. Add a feature flag to `envSchema` in `src/config.ts` (e.g., `ENABLE_MY_COMMAND`)
2. Write `handleMyCommand(context: CommandContext)` in `src/core.ts` following the existing patterns:
   - Check the feature flag
   - Resolve monitor target
   - Assert channel access
   - Perform action
   - `context.reply()` with the result
3. Register it on Discord: add the `SlashCommandBuilder` in `buildCommands()` and a case in `dispatch()` (`src/platform/discord.ts`)
4. Register it on Slack: add a case in `dispatch()`, a line in `buildHelpText()`, and any positional options to `POSITIONAL_OPTIONS`/`KNOWN_OPTIONS` (`src/platform/slack.ts`)
5. Update `.env.example`, `README.md`, `docs/wiki/Commands.md`, `docs/wiki/Configuration.md` (feature flag table), and `AGENTS.md`

## Adding a New Provider

See [API Integration](API-Integration.md#adding-a-new-provider) for the full checklist. In short: add `src/providers/<name>.ts` implementing the `Provider` interface, register it in `src/providers/index.ts`, extend the `provider` enum on `monitorSchema` in `src/config.ts`, and document the endpoints in `API-Integration.md`.

## Adding a New Chat Platform

See [Architecture](Architecture.md#the-chatplatform-seam) and the checklist in `AGENTS.md`. In short: implement `ChatPlatform`, supply a `TextFormat`, set `capabilities` honestly, and translate missing-resource errors to `null`.
