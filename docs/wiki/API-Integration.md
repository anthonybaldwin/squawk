# API Integration

The bot supports multiple status page providers. Each provider lives in its own adapter under `src/providers/` and normalizes its API responses into the same canonical shapes (`Incident`, `IncidentUpdate`, `Summary`, `PageStatus`) so the polling loop, rendering, and state management are completely provider-agnostic.

## Supported Providers

| Provider | ID | Example URL | API Type |
|----------|----|-----------| ---------|
| Statuspage.io (Atlassian) | `statuspage` | `https://status.atlassian.com` | Public v2 API, no key required |
| incident.io | `incidentio` | `https://status.openai.com` | Public widget proxy, no key required |
| Instatus | `instatus` | `https://status.perplexity.com` | Public v3 JSON API + Atom history feed, no key required |

No API key is required for any supported provider — all endpoints are public.

## Provider Detection

When a user runs `/monitor add <url>`, the bot probes each provider in order (see `PROBE_ORDER` in `src/providers/index.ts`). The first provider whose `probe()` returns a non-null result wins and is saved to the monitor's `provider` field in `data/monitors.json`.

Current probe order:

1. **incident.io** — probed first because many incident.io pages also expose a Statuspage-compatible `/api/v2/` shim, but the shim returns empty update bodies and a truncated history. Probing incident.io first ensures we use the richer native widget API when available.
2. **Statuspage.io** — fallback for pages that are not on incident.io.
3. **Instatus** — probed last. Its `/v3/summary.json` path does not collide with the earlier providers, and its probe rejects Statuspage-shaped summaries (see below).

Monitors loaded from `data/monitors.json` or `MONITORS_JSON` that pre-date multi-provider support default to `statuspage` for backwards compatibility.

## Statuspage.io Adapter

File: `src/providers/statuspage.ts`

| Endpoint | Used By | Purpose |
|----------|---------|---------|
| `<baseUrl>/api/v2/summary.json` | `probe()`, `fetchSummary()` | Overall page status + active incidents |
| `<baseUrl>/api/v2/incidents.json` | `fetchIncidents()` | Full incident list with all updates (for polling, `/replay`) |

Both endpoints return responses that already match the canonical shapes — the adapter is a thin pass-through.

### Canonical types

```typescript
type Summary = {
  page: { id: string; name: string; url: string; updated_at?: string };
  status: { indicator: string; description: string };
  incidents: Incident[];   // active only in /summary.json
};

type Incident = {
  id: string;
  name: string;
  status: string;          // "investigating" | "identified" | "monitoring" | "resolved"
  impact: string;          // "none" | "minor" | "major" | "critical"
  shortlink?: string;
  created_at: string;
  updated_at?: string;
  resolved_at?: string | null;
  incident_updates: IncidentUpdate[];
};

type IncidentUpdate = {
  id: string;
  status: string;
  body: string;
  created_at: string;
  updated_at?: string;
};
```

## incident.io Adapter

File: `src/providers/incidentio.ts`

incident.io exposes its public status page data through a proxy at `<baseUrl>/proxy/<host>`, where `<host>` is the hostname of the base URL. For example:

```
https://status.openai.com/proxy/status.openai.com            # summary
https://status.openai.com/proxy/status.openai.com/incidents  # full history
```

| Endpoint | Used By | Purpose |
|----------|---------|---------|
| `<baseUrl>/proxy/<host>` | `probe()`, `fetchSummary()` | `summary` object with ongoing incidents, affected components, page metadata |
| `<baseUrl>/proxy/<host>/incidents` | `fetchIncidents()` | `{ incidents: [...] }` with resolved incidents and full update messages |

### Normalization details

- **Page status** (`PageStatus.indicator`) is derived from the highest severity across `ongoing_incidents` + `affected_components`. An empty list with no in-progress maintenance maps to `none` / "All Systems Operational".
- **Incident status** is lowercased and mapped onto the canonical set: `investigating`, `identified` (incident.io's `fixing` also maps here), `monitoring`, `resolved`.
- **Incident impact** comes from `incident.impact` when present, otherwise derived from the max severity across `component_impacts[]` and `status_summaries[]`. incident.io's raw impact strings (`degraded`, `partial_outage`, `full_outage`, etc.) are collapsed onto the canonical `none` / `minor` / `major` / `critical` set.
- **Update message bodies** use a nested rich-doc structure (`{ type: "doc", content: [{ type: "paragraph", content: [...] }] }`). The adapter's `flattenMessage()` walks this recursively and returns plain text with paragraph breaks.
- **Shortlinks** come from `incident.url` when present, otherwise constructed as `<public_url>/incident/<id>`.

## Instatus Adapter

File: `src/providers/instatus.ts`

Instatus exposes a documented keyless JSON API plus a standard Atom history feed. The adapter joins them on the incident `id`: the JSON API gives live state and the impact enum, while the Atom feed gives the full update history including the operator's written prose.

| Endpoint | Used By | Purpose |
|----------|---------|---------|
| `<baseUrl>/v3/summary.json` | `probe()`, `fetchSummary()` | Page status + `activeIncidents[]` + `activeMaintenances[]` (current state, impact enum) |
| `<baseUrl>/history.atom` | `fetchIncidents()` | Atom feed of recent incidents and maintenances with full update prose (for polling, `/replay`) |

### Normalization details

- **Page status** comes from `page.status`: `UP` → operational, `UNDERMAINTENANCE` → maintenance, anything else (`HASISSUES`, other `HAS*`) → derived from the worst active impact.
- **Incident status** maps `INVESTIGATING`/`IDENTIFIED`/`MONITORING`/`RESOLVED` (and the title-case feed equivalents) onto the canonical set. Unknown words default to `investigating`.
- **Maintenance status** maps `NOTSTARTEDYET`/`Scheduled` → `scheduled`, `INPROGRESS`/`VERIFYING`/`Identified` → `in_progress`, `COMPLETED`/`Resolved` → `resolved`. Maintenances carry `impact: "maintenance"` (rendered grey).
- **Impact** maps `OPERATIONAL` → `none`, `MINOROUTAGE`/`DEGRADEDPERFORMANCE` → `minor`, `PARTIALOUTAGE` → `major`, `MAJOROUTAGE` → `critical`. The Atom feed carries no impact enum, so resolved/historical incidents default to `minor`; incidents still active in `summary.json` are stamped with their real impact by joining on `id`.
- **Update bodies** come from the Atom `<content>` HTML. Each `<p>` update block (`<small>timestamp</small><br><strong>Status</strong> - body`) is parsed into an `IncidentUpdate`; header `<p>` blocks (`<strong>Type:</strong> …`) are skipped. Update ids are `<incidentId>:<updateTimestampIso>` for dedup. Update blocks are sorted chronologically (the feed does not emit them in order).
- **Update timestamps** in the feed carry no year. The year is taken from an anchor computed by `entryAnchor()` — the earlier of the entry's `<published>` and `<updated>` — with a rollover guard: if the resulting date lands before the anchor (beyond a ~24h grace window), it is rolled to the following year (incident spanning Dec→Jan). Anchoring on `<published>` alone is wrong for scheduled maintenance, where `<published>` is the scheduled start and the announcement update legitimately precedes it.
- **`page.id`** is synthesized from the base URL host (Instatus summaries omit it).

### Probe order

Instatus is probed last (`PROBE_ORDER` is `[incidentio, statuspage, instatus]`). Its `/v3/summary.json` path does not collide with incident.io's `/proxy/<host>` or Statuspage's `/api/v2/summary.json`, and the probe additionally rejects Statuspage-shaped summaries (which carry `page.id` and a top-level `status` object).

## Favicon Fetching

Provider-agnostic. On startup and when adding a runtime monitor, the bot resolves an icon for embed author fields:

1. If `iconUrl` is set on the monitor config, use it directly (skips all fetching).
2. Otherwise, `GET <baseUrl>` (HTML page).
3. Scan every `<link>` tag whose `rel` contains `icon` (matches `rel="icon"`, `rel="shortcut icon"`, and `rel="apple-touch-icon"` in any attribute order).
4. Rank candidates: non-SVG first (Discord embed author icons don't render SVG), then largest `sizes="WxH"` wins.
5. Decode common HTML entities (`&amp;`, `&#38;`, `&quot;`) and resolve relative/protocol-relative hrefs against the base URL.
6. Cached in memory (`monitorIcons` Map) for embed author icons.

Use `iconUrl` to override auto-detection when a page's icon is injected by JavaScript, hosted on a CDN that rejects hotlinking, or otherwise unreachable for Discord's image fetcher.

## Error Handling

- **Non-200 responses:** Adapters throw with status code and response body for debugging.
- **Network errors:** Caught at the poll level; logged and retried on next cycle.
- **Invalid status page URL:** `/monitor add` runs every provider's `probe()` and only accepts URLs where at least one returns success.
- **API rate limits:** Not explicitly handled; public APIs are generous and the 60s default poll interval keeps request volume low.
- **Probe failures:** A provider's `probe()` should return `null` rather than throwing when the URL is not its own. `detectProvider()` swallows thrown probe errors and moves on to the next provider.

## Color Mapping

The bot has two separate color maps in `src/index.ts`, and they do **not** agree — the same word means different things in each. Both handle the union of values across all providers (after canonicalization).

### `statusColor(status)`

Used for update embeds (colored by the update's own status) and for the `/status` page indicator.

| Status / indicator | Color | Hex |
|--------------------|-------|-----|
| `resolved`, `postmortem`, `operational`, `none` | Green | `#2fb344` |
| `identified` | Yellow | `#f2c94c` |
| `monitoring` | Blue | `#6aa9ff` |
| `investigating`, `update`, `minor`, `degraded_performance` | Orange | `#f2994a` |
| `partial_outage`, `major`, `critical`, `major_outage` | Red | `#eb5757` |
| `under_maintenance` | Grey | `#8e8e93` |
| `maintenance` | Dark Grey | `#7f8c8d` |
| anything else | Discord Blurple | `#5865f2` |

### `impactColor(impact, status?)`

Used for incident parent embeds, which are colored by impact rather than status. A `status` of `resolved` or `postmortem` short-circuits to green regardless of impact.

| Impact | Color | Hex |
|--------|-------|-----|
| (status `resolved` / `postmortem`) | Green | `#2fb344` |
| `none` | Blue | `#6aa9ff` |
| `minor` | Yellow | `#f2c94c` |
| `major` | Orange | `#f2994a` |
| `critical` | Red | `#eb5757` |
| `maintenance`, `under_maintenance` | Dark Grey | `#7f8c8d` |
| anything else | Discord Blurple | `#5865f2` |

Ghosted incidents bypass both maps and use `MISSING_INCIDENT_COLOR`, light grey `#95a5a6`.

## Adding a New Provider

Every provider normalizes into the canonical types, so polling, rendering, state, and thread lifecycle need no changes.

1. **Create `src/providers/<name>.ts`** exporting a `Provider` object (see `src/providers/types.ts` for the interface). Implement:
   - `probe(baseUrl)` — return `{ page, status }` if the URL belongs to this provider, or `null` if it does not. Return `null` rather than throwing when the URL simply isn't yours; `detectProvider()` swallows thrown errors, but a clean `null` is the contract.
   - `fetchSummary(monitor)` — current page status plus active incidents.
   - `fetchIncidents(monitor)` — full incident list with all updates.
2. **Register it in `src/providers/index.ts`**: add it to the `PROVIDERS` record and insert it into `PROBE_ORDER`. Order matters — a provider whose probe can false-positive on another provider's pages belongs later, and one that must win over a compatibility shim belongs earlier (this is why incident.io precedes Statuspage).
3. **Add its ID to the `provider` enum** on `monitorSchema` in `src/index.ts`, so `MONITORS_JSON` and `data/monitors.json` accept it.
4. **Add tests** for any parsing logic in `src/providers/<name>.test.ts`, asserting against a captured fixture rather than the live API.
5. **Update the docs**: this page (endpoints, normalization quirks, probe order), plus `Configuration.md` and `.env.example` where provider IDs are listed.
