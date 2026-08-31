# Development

## Prerequisites

- [Bun](https://bun.sh) (v1.3.10+ recommended)
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
src/index.ts          # Entry point: resolve platform, start poll loop
src/core.ts           # Incident lifecycle + command handlers (platform-neutral)
src/render.ts         # Neutral Embed builders + TextFormat interface
src/platform/         # Chat platform adapters (discord.ts, slack.ts)
src/providers/        # Status page adapters
data/state.json       # Runtime state (auto-created)
data/monitors.json    # Runtime monitors (auto-created)
.env                  # Local secrets (git-ignored)
.env.example          # Configuration template
```

## Code Organization

See [Architecture](Architecture.md) for a detailed breakdown.

Key conventions:
- Functions are ordered by dependency (callees above callers)
- `src/core.ts` imports neither `discord.js` nor `@slack/*` — platform specifics live behind `ChatPlatform`
- All embed construction is in the `render*` functions, returning the neutral `Embed` type
- State mutations happen in `postLatestUpdatesForMonitor` and command handlers
- Adapters translate "resource is gone" errors into `null` returns rather than leaking error codes into the core

## TypeScript

```bash
bun run typecheck    # tsc --noEmit
bun test             # Unit tests
```

The `tsconfig.json` uses strict mode with ES2022 target and Bun module resolution.

`src/core.test.ts` runs the whole incident lifecycle against an in-memory `ChatPlatform`, so lifecycle changes can be verified without a live workspace or server. Prefer extending it over manual testing.

## Testing Locally

1. Set `POST_EXISTING_UPDATES_ON_START=true` to see updates immediately
2. Use `/testpost` to preview status embeds without affecting state
3. Use `/replay` to re-post incident timelines after cleanup
4. Use `/clean` to wipe bot messages when iterating
5. Monitor a Statuspage with frequent incidents (e.g., `https://status.atlassian.com`) for realistic testing

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
5. Update `.env.example`, `README.md`, and `docs/wiki/Commands.md`

## Adding a New Chat Platform

See [Architecture](Architecture.md#the-chatplatform-seam) and the checklist in `AGENTS.md`. In short: implement `ChatPlatform`, supply a `TextFormat`, set `capabilities` honestly, and translate missing-resource errors to `null`.
