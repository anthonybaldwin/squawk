# AGENTS.md

Instructions for AI coding agents working on this project. **All agents MUST read and follow this file.** Update it whenever project structure, patterns, or conventions change.

## Project Overview

Squawk is a Bun-based bot that polls public status pages (Statuspage.io, incident.io, and Instatus are supported) and posts incident updates as threaded conversations in **Discord or Slack**. It supports multiple monitors, runtime monitor management, and persistent state.

One deployment drives **one** chat platform, selected by `PLATFORM` (or inferred from whichever bot token is set). State stores that platform's opaque message/thread handles, so a single instance cannot serve both.

The repo was previously named `statuspage-discord`. The legacy `STATUSPAGE_MONITORS_JSON` env var is still honored as a deprecated alias for `MONITORS_JSON`.

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict mode)
- **Dependencies:** discord.js, @slack/web-api, @slack/socket-mode, zod
- **Deployment:** Docker (Alpine-based), Docker Compose, GHCR

## Project Structure

```
src/index.ts              # Entry point: resolve platform, load monitors, poll loop
src/config.ts             # Env + monitor schemas, platform resolution, monitors.json I/O
src/state.ts              # data/state.json read/write + legacy migration
src/icons.ts              # Favicon discovery and caching
src/render.ts             # Platform-neutral Embed builders + TextFormat interface
src/core.ts               # Incident lifecycle, polling, all command handlers
src/platform/             # Chat platform adapters (one file per platform)
  types.ts                # ChatPlatform interface, PlatformMessage, capabilities
  discord.ts              # discord.js adapter
  slack.ts                # Slack adapter (Socket Mode + Block Kit)
src/providers/            # Per-provider API adapters (one file per provider)
  types.ts                # Canonical Incident/Summary/PageStatus + Provider interface
  index.ts                # Provider registry + detectProvider()
  statuspage.ts           # Statuspage.io adapter
  incidentio.ts           # incident.io adapter (uses /proxy/<host> widget API)
  instatus.ts             # Instatus adapter (v3 JSON API + Atom history feed)
  *.test.ts               # Adapter unit tests (`bun test`)
data/state.json           # Runtime state (git-ignored, auto-created)
data/monitors.json        # Runtime monitors (git-ignored, auto-created)
AGENTS.md                 # Agent instructions (cross-tool)
CLAUDE.md                 # Claude-specific instructions (points here)
CONTRIBUTING.md           # Symlink → docs/wiki/Contributing.md
docs/wiki/                # Wiki source of truth (published by .github/workflows/sync-wiki.yml)
  Home.md                 # Wiki landing page
  Architecture.md         # System design and data flow
  Configuration.md        # Environment variables and setup
  Commands.md             # Slash command reference
  Contributing.md         # How to contribute and code conventions
  Incident-Lifecycle.md   # How incidents are tracked and displayed
  State-Management.md     # Persistence format and behavior
  API-Integration.md      # Status page provider APIs (Statuspage, incident.io, Instatus)
  Slack-Setup.md          # Slack app manifest, scopes, tokens, Discord/Slack differences
  Deployment.md           # Docker, CI/CD, production notes
  Development.md          # Local setup and contribution guide
```

## Build & Run

```bash
bun install               # Install dependencies
bun dev                   # Watch mode
bun start                 # Production run
bun run typecheck         # Type-check (tsc --noEmit)
bun test                  # Run unit tests
docker compose up -d      # Docker deployment
```

## Documentation Maintenance (MANDATORY)

**Every commit that changes behavior, configuration, commands, or architecture MUST include corresponding updates to:**

1. **`docs/wiki/`** — Update the relevant wiki page(s). If a new concept is introduced, add it to the appropriate page or create a new one and link it from `Home.md`. These files are the source of truth: pushing to `main` publishes them to the GitHub wiki, overwriting anything edited there directly. Mermaid blocks must parse — GitHub replaces an invalid diagram with a red parse error on the live page.
2. **`README.md`** — Keep Quick Start, Docker, and documentation links in sync.
3. **`AGENTS.md`** (this file) — Update the project structure, key patterns, or any instructions that change.

### When to update what:

| Change | Update |
|--------|--------|
| New/changed chat platform behavior | `Slack-Setup.md`, `Commands.md`, `Incident-Lifecycle.md`, `Architecture.md` |
| New/changed env variable | `README.md`, `Configuration.md`, `.env.example`, `AGENTS.md` (if structural) |
| New/changed command | `README.md`, `Commands.md`, `Development.md` (adding a command guide) |
| Incident lifecycle change | `Incident-Lifecycle.md`, `Architecture.md` |
| State format change | `State-Management.md` |
| New dependency | `Architecture.md` (dependencies table) |
| Deployment change | `Deployment.md`, `README.md` |
| API integration change | `API-Integration.md` |
| New file or structural change | `AGENTS.md` (project structure), `Architecture.md` |

## Key Patterns

### Two Adapter Seams
Squawk has two interfaces, and everything else is written once against them:

- `src/providers/` — status page vendors, behind `Provider`
- `src/platform/` — chat platforms, behind `ChatPlatform`

`src/core.ts` holds the whole incident lifecycle and every command handler, and imports neither `discord.js` nor `@slack/*`. Functions are ordered by dependency (callees above callers). Keep new lifecycle logic in `core.ts`; only genuinely platform-specific mechanics belong in an adapter.

### Adding a New Chat Platform

1. Create `src/platform/<name>.ts` exporting a class implementing `ChatPlatform` (see `src/platform/types.ts`).
2. Supply a `TextFormat` for the platform's inline markup, and map the neutral `Embed` from `src/render.ts` onto its native rich-message format.
3. Set `capabilities` honestly — the core skips optional work (thread archiving, pin-notice pruning, presence, autocomplete) rather than branching on platform identity.
4. Translate "this resource is gone" errors into `null`/`false` returns so the core prunes state without knowing any platform error codes. Everything else should throw.
5. Add the ID to `PlatformId` in `src/config.ts`, wire it into `createPlatform()` in `src/index.ts`, and document setup in `docs/wiki/`.

### Platform-Neutral Rendering
`render.ts` builds a structural `Embed` and produces inline markup through the active platform's `TextFormat`. Text that comes from a status page must be wrapped in `fmt.escape()`; markup Squawk generates itself must not be. Never hardcode `**bold**` or `~~strike~~` in a render function — Slack uses `*bold*` and `~strike~`.

### Adding a New Provider

1. Create `src/providers/<name>.ts` exporting a `Provider` object (see `src/providers/types.ts` for the interface). Implement `probe`, `fetchSummary`, and `fetchIncidents` so they return the canonical `Incident`/`Summary` shapes.
2. Register it in `src/providers/index.ts`: add to the `PROVIDERS` record, insert into `PROBE_ORDER` (more specific providers first — a provider whose probe might false-positive belongs later in the order).
3. Add its ID to the `provider` enum on `monitorSchema` in `src/config.ts`.
4. Update `docs/wiki/API-Integration.md` with the endpoints and any quirks.

No changes to polling, rendering, state, or thread lifecycle should be required — every provider normalizes into the canonical types.

### Error Handling
- Platform adapters translate "resource is gone" errors into `null`/`false` returns (Discord codes 10003, 10008, 50001, 50013, 50035; Slack `channel_not_found`, `message_not_found`, `thread_not_found`). The core prunes state on `null` and never inspects error codes itself.
- Never catch-all delete state on generic errors — only on confirmed missing platform resources
- Status page adapters throw on non-2xx with the status code and body. There is no retry helper: the poll loop catches per monitor and retries on the next cycle.
- The poll loop is wrapped in `singleFlight()` so cycles never overlap and duplicate threads
- Thread archive/unarchive failures are logged but non-fatal

### State Management
- State is saved after each monitor processes (not just at the end of the full cycle) to prevent partial loss
- `openIncidentIds` tracks what the bot considers "open" for ghost detection
- `postedUpdateIds` is capped at 500 entries per monitor
- Runtime monitors use a promise-chain lock for safe concurrent writes

### Embed Rendering
- All embeds are built by `render*()` functions in `src/render.ts`, returning the neutral `Embed` type
- Color is derived from impact/status using `impactColor()` and `statusColor()`
- Removed/ghosted incidents use `MISSING_INCIDENT_COLOR` (grey) with strikethrough text
- Favicons are cached at startup in the `monitorIcons` Map (`src/icons.ts`)
- Adapters convert `Embed` to a discord.js `EmbedBuilder` or a Slack Block Kit attachment

### Incident Lifecycle
- New incident → parent embed + thread + pin
- Update → post to thread + sync parent
- Resolved → unpin + archive thread
- Vanished from API → ghost (grey + strikethrough) + archive thread

### Command Pattern
Handlers in `core.ts` take a neutral `CommandContext` and follow:
1. Check feature flag
2. Resolve monitor target
3. Assert channel access
4. Perform action
5. `context.reply()` with the result

The adapter owns the platform's response mechanics: Discord defers ephemerally before dispatch and replies via `editReply`; Slack acks within 3 seconds and replies through `response_url`.

Discord registers typed slash commands over the API. Slack command names are unique per workspace and are manifest-declared, so all commands are subcommands of a single command (`SLACK_COMMAND_NAME`, default `squawk`) parsed by `parseCommandText()`. A new command must be added to both adapters and to `buildHelpText()`.

## Environment Variables

See `.env.example` for the full list. Blank values are treated as unset, so placeholder lines in `.env` are safe. Key ones:
- `PLATFORM` — `discord` or `slack`; inferred from the configured bot token when omitted
- `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID` (required for Discord)
- `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` (required for Slack), plus `SLACK_COMMAND_NAME` and `SLACK_ADMIN_USER_IDS`
- `MONITORS_JSON` or `DISCORD_CHANNEL_ID`/`SLACK_CHANNEL_ID` + `STATUSPAGE_BASE_URL` (legacy `STATUSPAGE_MONITORS_JSON` still honored with deprecation warning)
- `POLL_INTERVAL_MS` (default 60000)
- `ENABLE_*_COMMAND` feature flags (all default true, includes `ENABLE_CLEANUP_COMMAND`)
- `APP_VERSION` (optional, auto-set in Docker builds via build arg, falls back to `package.json` version)

## Git Workflow

### Branch Prefixes

```
feat/, fix/, chore/, perf/, refactor/, docs/, ci/
```

### PR Title Rules

- Use a clear, generic scope title that covers all commits in the PR.
- Do **not** use conventional commit prefixes in PR titles (`fix:`, `feat:`, `refactor:`, etc.).
- Use plain-language summary titles; commit messages provide release typing.
- Agents must keep the PR title current as commits are added.
- Agents must keep the PR description current as commits are added or removed.
- If the PR is no longer single-scope/single-type, update to a shared summary title.

### PR Description Rules

- Include a short summary of what changed and why.
- Keep the description current when adding/removing commits.
- Note any workflow/deploy impact when relevant.

### Commit Message Format

Use [Conventional Commits](https://conventionalcommits.org):

```
<type>(<scope>): <short summary>
```

Allowed types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `ci`

Rules:
- Use imperative tense ("add feature", not "added feature").
- Keep subject line under ~72 characters.
- Use scope when meaningful (e.g., `fix(polling): handle 429 rate limits`).
- Add a body for **why** / risk / validation when the subject alone isn't sufficient.
- Commit message bodies must use real newlines, not escaped `\n` sequences.

### Commit Hygiene

- Keep only commits that should reach `main`; drop experimental/no-op commits before merge.
- Squash or fixup branch commits when it improves clarity and reduces noise.
- Keep commit subjects meaningful — release labels are inferred from commit messages.
- Commit after every meaningful change; avoid massive "everything changed" commits.

### Git Staging

Always stage files explicitly by name. Never use `git commit -am`, `git add -A`, or `git add .`. Only stage the files you actually modified for the current task.

### Shell Notes (PR Body)

- Never use `--body @-` with a heredoc for `gh pr create` or `gh pr edit` — in bash-on-Windows the body becomes the literal string `@-`.
- Always pass PR body content directly via `--body '...'` (single-quoted string).

### Merge Strategy

```bash
gh pr merge --rebase --delete-branch
```

## CI/CD

- Docker image built on push to `main` (multi-arch: ARM64 + AMD64)
- Dependabot updates weekly for npm, Docker, and GitHub Actions
- Lockfile auto-regenerated on Dependabot PRs
