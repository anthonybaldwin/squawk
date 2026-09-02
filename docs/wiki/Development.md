# Development

## Prerequisites

- [Bun](https://bun.sh) v1.3 or newer (the published image tracks the latest `oven/bun:*-alpine`)
- A Discord bot token and application ID ([Discord Developer Portal](https://discord.com/developers/applications))
- A test Discord server with a text channel

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

Set `DISCORD_GUILD_ID` in your `.env` to your test server's ID. This makes slash commands register instantly (guild-scoped) instead of waiting up to an hour for global propagation.

## Project Structure

```
src/index.ts                  # All bot logic (single file)
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

Bot logic is a single TypeScript file organized into logical sections, with provider adapters split out into `src/providers/`. See [Architecture](Architecture.md) for a detailed breakdown.

Key conventions:
- Functions are ordered by dependency (callees above callers)
- All Discord embed construction is in the `render*` functions
- State mutations happen in `postLatestUpdatesForMonitor` and command handlers
- Error handling uses specific DiscordAPIError codes rather than catch-all patterns

## Type-Checking and Tests

```bash
bun run typecheck    # tsc --noEmit
bun test             # Unit tests for the provider adapters
```

The `tsconfig.json` uses strict mode with ES2022 target and Bun module resolution.

Tests live next to the code they cover (`src/providers/*.test.ts`) and run against captured fixtures, so they need no network access or Discord token. `src/index.ts` guards its bootstrap on `import.meta.main`, so it can be imported from a test without logging into Discord or starting the poll loop.

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

1. Add a feature flag to `envSchema` (e.g., `ENABLE_MY_COMMAND`)
2. Add the `SlashCommandBuilder` in `buildCommands()`, gated by the flag
3. Write a `handleMyCommand()` function following the existing patterns:
   - Defer reply with ephemeral flag
   - Resolve monitor target
   - Assert channel access
   - Perform action
   - Edit reply with result
4. Add the command dispatch in the `interactionCreate` handler
5. Update `.env.example`, `README.md`, `docs/wiki/Commands.md`, `docs/wiki/Configuration.md` (feature flag table), and `AGENTS.md`

## Adding a New Provider

See [API Integration](API-Integration.md#adding-a-new-provider) for the full checklist. In short: add `src/providers/<name>.ts` implementing the `Provider` interface, register it in `src/providers/index.ts`, extend the `provider` enum on `monitorSchema` in `src/index.ts`, and document the endpoints in `API-Integration.md`.
