# Deployment

## Docker Compose (Recommended)

The simplest production deployment. Secrets stay in your host-side `.env` and are injected at runtime.

```bash
docker compose up -d
```

The `compose.yml` configures:
- `env_file: .env` for secret injection (never baked into the image)
- `squawk_data` named volume mounted at `/app/data` for persistent state
- `restart: unless-stopped` for automatic recovery

State survives container restarts, recreations, and image updates (e.g., via [Watchtower](https://containrrr.dev/watchtower/) or [WUD](https://github.com/fmartinou/whats-up-docker)).

## Docker (Manual)

Build:

```bash
docker build -t squawk .
```

Run:

```bash
docker run --rm --env-file .env -v squawk_data:/app/data squawk
```

## Prebuilt Image

A multi-arch image (ARM64 + AMD64) is published to GitHub Container Registry on every push to `main`:

```bash
docker pull ghcr.io/anthonybaldwin/squawk:latest
```

Tags:
- `latest` — current main branch
- `1.0.<run_number>` — incremental build number
- `v*` semver tags (when git-tagged)
- `sha-<commit>` — exact commit

## CI/CD

### Docker Build (`.github/workflows/docker.yml`)

Triggers on push to `main` or `v*` tags when source files change:
- `src/**`, `Dockerfile`, `.dockerignore`, `package.json`, `bun.lock`, `tsconfig.json`

Steps:
1. Checkout
2. Setup QEMU + Buildx (multi-platform)
3. Login to GHCR
4. Generate metadata tags
5. Build and push for `linux/arm64` and `linux/amd64`, passing `APP_VERSION=1.0.<run_number>`

Concurrency: cancels previous runs on the same branch. Also runnable via `workflow_dispatch`.

### Wiki Sync (`.github/workflows/sync-wiki.yml`)

The GitHub wiki is **generated**, not edited in place. On every push to `main` that touches `docs/wiki/**`, this workflow copies `docs/wiki/*.md` into the wiki repository and commits as `github-actions[bot]`. Wiki pages whose source file no longer exists are deleted.

Edit documentation in `docs/wiki/` and let the workflow publish it — edits made directly in the GitHub wiki UI are overwritten by the next sync.

It authenticates with the `WIKI_SYNC_PAT` repository secret (a token with write access to the wiki), and can also be run via `workflow_dispatch`.

### Lockfile Sync (`.github/workflows/lockfile.yml`)

When Dependabot opens a PR that changes `package.json`, this workflow automatically regenerates `bun.lock` and commits it back.

### Dependabot (`.github/dependabot.yml`)

Weekly updates for:
- npm dependencies (grouped)
- Docker base images
- GitHub Actions (grouped)

## Dockerfile Details

```dockerfile
FROM oven/bun:<version>-alpine

ARG APP_VERSION=
ENV APP_VERSION=${APP_VERSION}

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

CMD ["bun", "src/index.ts"]
```

- Alpine base for minimal image size; the base tag is pinned in the `Dockerfile` and bumped by Dependabot
- Frozen lockfile ensures reproducible builds
- Production flag skips devDependencies
- `APP_VERSION` is passed as a build arg by the Docker workflow (`1.0.<run_number>`) and surfaces in the bot's Discord presence. Built without it, the bot falls back to the `package.json` version.
- Only `src/` is copied — no `.env`, docs, or config beyond `package.json`/`bun.lock`. The adapter unit tests live in `src/providers/*.test.ts` and are copied along with it; they are inert at runtime.

## Production Considerations

- **Secrets:** Never bake `.env` or tokens into the Docker image. Use `env_file` or environment variables at runtime.
- **State volume:** Always mount `data/` as a persistent volume. Without it, the bot will re-seed on every restart and may re-post updates.
- **Polling interval:** The default 60s is a good balance. Lower intervals increase API load; higher intervals delay notifications.
- **Multiple instances:** Do not run multiple instances against the same Discord channel. They will fight over thread ownership and duplicate posts.
- **Logging:** The bot logs to stdout. Use `docker logs` or your container orchestrator's logging to monitor health.
