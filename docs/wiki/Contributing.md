# Contributing

Thanks for your interest in contributing to squawk!

## Getting Started

1. **Open an issue** to discuss the change before starting work on anything non-trivial
2. **Fork the repo** and create a feature branch off `main`
3. **Set up your environment** — see the [Development](https://github.com/anthonybaldwin/squawk/wiki/Development) page for local setup
4. **Make your changes**, ensuring they follow the conventions below
5. **Open a pull request** against `main`

## Code Conventions

### Two Adapter Seams

Squawk has two interfaces, and everything else is written once against them:

- `src/providers/` — status page vendors, behind `Provider`. See [API Integration](https://github.com/anthonybaldwin/squawk/wiki/API-Integration) for the steps to add one.
- `src/platform/` — chat platforms (Discord, Slack), behind `ChatPlatform`. See [Architecture](https://github.com/anthonybaldwin/squawk/wiki/Architecture) for the seam's conventions.

`src/core.ts` holds the incident lifecycle and every command handler, and imports neither `discord.js` nor `@slack/*`. Functions are ordered by dependency (callees above callers). Keep new lifecycle logic in `core.ts`; only genuinely platform-specific mechanics belong in an adapter.

### Error Handling

- Clean up state only on confirmed missing platform resources. Adapters translate those errors (Discord's 10003 Unknown Channel, 10008 Unknown Message, 50001 Missing Access; Slack's `channel_not_found`, `message_not_found`) into `null` returns rather than using a catch-all; the core prunes on `null` and never inspects error codes
- Status page API calls surface non-2xx responses as errors with the status code and body; the poll loop catches them per monitor and retries on the next cycle
- Thread archive/unarchive failures are logged but non-fatal
- Each monitor is isolated inside the poll loop so one failing page can't abort the rest of the cycle

### Command Pattern

Handlers in `src/core.ts` take a neutral `CommandContext` and follow this order:

1. Check feature flag
2. Resolve monitor target
3. Assert channel access
4. Perform action
5. `context.reply()` with the result

The adapter owns the platform's response mechanics: Discord defers ephemerally before dispatch and replies via `editReply`; Slack acks within 3 seconds and replies through `response_url`. A new command must be registered in both adapters.

### TypeScript

- Strict mode is enabled
- Use Zod schemas for runtime validation of external data (env vars, API responses)
- Prefer explicit types over `any`

### Checks

Run both before opening a pull request:

```bash
bun run typecheck    # tsc --noEmit
bun test             # Unit tests
```

Provider parsing logic (feed/HTML/JSON normalization) should come with tests — see `src/providers/instatus.test.ts` for the pattern of asserting against a captured fixture. Changes to the incident lifecycle belong in `src/core.test.ts`, which drives the whole flow against an in-memory `ChatPlatform`.

## Documentation Maintenance

**Every commit that changes behavior, configuration, commands, or architecture MUST include corresponding documentation updates.**

| Change | Update |
|--------|--------|
| New/changed env variable | `Configuration.md`, `.env.example`, `README.md` |
| New/changed command | `Commands.md`, `README.md` |
| Incident lifecycle change | `Incident-Lifecycle.md`, `Architecture.md` |
| State format change | `State-Management.md` |
| New dependency | `Architecture.md` (dependencies table) |
| Deployment change | `Deployment.md`, `README.md` |
| API integration change | `API-Integration.md` |
| New file or structural change | `AGENTS.md` (project structure), `Architecture.md` |

## Git Workflow

### Branch Naming

Use one of these prefixes:

```
feat/, fix/, chore/, perf/, refactor/, docs/, ci/
```

### Commit Message Format

Use [Conventional Commits](https://conventionalcommits.org):

```
<type>(<scope>): <short summary>
```

Allowed types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `ci`

- Use imperative tense ("add feature", not "added feature")
- Keep subject line under ~72 characters
- Use scope when meaningful (e.g., `fix(polling): handle 429 rate limits`)
- Add a body for **why** / risk / validation when the subject alone isn't sufficient
- Keep commits focused — one logical change per commit
- If a commit touches code, include any required documentation updates in the same commit
- Keep only commits that should reach `main`; drop experimental/no-op commits before merge
- Squash or fixup branch commits when it improves clarity and reduces noise

### Pull Request Rules

- Use a clear, plain-language title that summarizes the overall PR scope
- Do **not** use conventional commit prefixes in PR titles (`fix:`, `feat:`, etc.)
- Include a short summary of what changed and why in the description
- Keep the title and description current as commits are added or removed

### Merge Strategy

PRs are merged with rebase:

```bash
gh pr merge --rebase --delete-branch
```

## Questions?

Open a [GitHub issue](https://github.com/anthonybaldwin/squawk/issues) or start a [discussion](https://github.com/anthonybaldwin/squawk/discussions).
