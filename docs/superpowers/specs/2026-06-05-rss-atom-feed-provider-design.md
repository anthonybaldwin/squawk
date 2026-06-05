# Generic RSS/Atom Feed Provider — Design

**Date:** 2026-06-05
**Status:** Approved (design), pending implementation plan

## Problem

Squawk supports three status-page platforms via dedicated providers (Statuspage,
incident.io, Instatus), each probing a known vendor API shape. Status pages built
on anything else — e.g. Slack's bespoke `slack-status.com` (a custom Laravel app)
— can't be monitored, even though almost all of them publish an Atom or RSS feed.

Rather than add a one-off provider per bespoke page, add a single generic **feed**
provider that consumes any Atom or RSS feed. This turns "we don't support that
page" into "give us its feed link" for the long tail of status pages.

## Research findings (why feeds, why this shape)

Verified against live data from Slack (bespoke) and GitHub (Statuspage vendor),
including each one's JSON API, Atom feed, and RSS feed.

| Surface | Stable id | Per-update history | Status enum | Impact | Discoverable on an unknown site? |
|---|---|---|---|---|---|
| **JSON API** (Slack `/api/v2.0.0`, Statuspage `/api/v2`) | yes | yes (`notes[]`, own timestamps) | yes | yes | **No — vendor-specific shape** |
| **Atom** `<content>` | yes (`<id>`) | yes — `<small>`-delimited blocks, always present | sometimes (Statuspage emits `<strong>Investigating/Resolved</strong>`; Slack is prose only) | no | yes (the link the user supplies) |
| **RSS** `<description>` | yes (`<guid>`) | vendor-dependent (Statuspage duplicates blocks; Slack gives only a summary) | same as Atom when present | no | yes |

Conclusions that drive the design:

1. **JSON APIs are richer but useless as a generic fallback** — they only help when
   the vendor is already known, which is exactly what the existing providers are for.
   For an unknown site there is nothing to discover. The supplied feed is the only
   self-describing structured source.
2. **An incident is one event, updated in place.** A feed entry has a stable id and
   accumulates timestamped updates inside its `<content>`/`<description>` while its
   `<updated>`/`<pubDate>` advances. Example: a Slack entry `published` 2025-12-08,
   `updated` 2025-12-18, with four `<small>3:23pm PST</small> …` update blocks in one
   entry. This maps directly onto Squawk's existing model: the polling loop already
   dedupes incidents by `id` and updates by update-`id`, so once we emit each update
   block as an `IncidentUpdate` with a stable id, "watch the same event for new
   updates" is automatic.
3. **Impact (minor/major/critical) is the one field feeds never carry.** Feed
   monitors will show a generic severity; everything else (status, update stream,
   resolved state) is recoverable from content.

## Goals

- Monitor any status page that publishes a valid Atom or RSS feed, by supplying the
  feed URL directly to `/monitor add`.
- Reuse the existing canonical `Summary`/`Incident` model and polling/render path
  unchanged — the feed provider is just another `Provider`.
- Treat each feed entry as one incident-event and surface its accumulating updates
  so the existing dedupe loop posts new updates over time.

## Non-goals

- **No HTML scanning or path-guessing.** We do not crawl a page's `<head>` for
  `<link rel="alternate">`, nor probe well-known paths. The user supplies the exact
  feed link. (Explicit decision — avoids false positives and fragility.)
- No attempt to recover an impact severity feeds don't provide.
- No new `/monitor` command surface or schema field beyond the provider enum.

## Approach

Add a `feed` provider as the **last** entry in `PROBE_ORDER`. Its `probe()` succeeds
only when the supplied URL *is itself* a parseable Atom or RSS document. Known
status-page URLs continue to match their real provider earlier in the order; a plain
HTML page matches nothing and falls through to a friendly error. A direct feed link
matches `feed`.

The feed URL becomes the monitor's `baseUrl` (`provider: "feed"`). No separate
feed-URL field is needed. The human-facing page URL and page name are read from
inside the feed itself (both Slack and GitHub Atom carry
`<link rel="alternate" type="text/html">` and a feed `<title>`).

### Registration / UX flow

```
/monitor add <url>
  → probe statuspage, incidentio, instatus   (unchanged)
  → probe feed: fetch <url>, is it Atom or RSS?  yes → feed monitor
  → none match → error
```

Updated error message (replacing `src/index.ts:1794–1797`):

> Auto-detection only supports **Statuspage, incident.io, and Instatus**. For other
> status pages, pass a direct **Atom or RSS** feed URL — e.g.
> `https://slack-status.com/feed/atom`.

Example success: `/monitor add https://slack-status.com/feed/atom`.

## Components

A new `src/providers/feed.ts` plus small wiring changes. The module is organized into
pure, independently testable functions (mirroring `instatus.ts`):

### 1. Format detection — `detectFeedKind(xml): "atom" | "rss" | null`
Inspect the document: a root/early `<feed` with the Atom namespace → `atom`; an
`<rss`/`<channel>` → `rss`; neither → `null` (probe returns null). No reliance on
content-type headers or file extension; detection is by document content.

### 2. Atom parsing — `parseAtomFeed(xml, baseUrl): { page, incidents }`
- `page.name` ← feed `<title>`; `page.url` ← feed-level
  `<link rel="alternate" type="text/html">` (fallback: `baseUrl`); `page.id` ← host of
  that URL.
- Each `<entry>` → one `Incident`:
  - `id` ← `<id>` (trimmed; reuse the Instatus tail-extraction approach for a clean id).
  - `name` ← `<title>` (entity-decoded).
  - `shortlink` ← entry `<link rel="alternate" type="text/html">`.
  - `incident_updates` ← parsed from `<content type="html">` (see §4).
  - `created_at` ← first update or `<published>`; `updated_at` ← last update or `<updated>`.
  - `status` ← last update's status; `resolved_at` ← last update time when resolved.
  - `impact` ← `"minor"` default (feeds carry no impact).

### 3. RSS parsing — `parseRssFeed(xml, baseUrl): { page, incidents }`
- `page.name` ← `<channel><title>`; `page.url` ← `<channel><link>`.
- Each `<item>` → one `Incident`: `id` ← `<guid>` (fallback `<link>`), `name` ←
  `<title>`, `shortlink` ← `<link>`, `updated_at` ← `<pubDate>`. Updates parsed from
  `<description>` via the same block parser (§4); when no update blocks are present
  (e.g. Slack RSS), fall back to a single update whose body is the description text.

### 4. Update-block parsing — `parseFeedUpdates(html, entryTimeIso): IncidentUpdate[]`
Shared by Atom and RSS. The HTML content holds zero or more update blocks of the form
`<p><small>TIMESTAMP</small><br>[<strong>STATUS</strong> -] BODY</p>`:
- Split into `<p>` blocks containing a `<small>` timestamp.
- **Timestamp** ← parse `<small>` text to ISO (reuse/extend `parseUpdateTimestamp`;
  must also accept absolute forms like Slack's `3:23pm PST` and Statuspage's
  `Jun 5, 17:25 UTC`). Fallback to the entry-level time when unparseable.
- **Status** ← `<strong>WORD</strong>` marker via `canonicalIncidentStatus` when
  present (Statuspage family); otherwise keyword-sniff the body
  (`resolved`/`monitoring`/`identified`/`investigating`), defaulting to
  `investigating`.
- **Body** ← tag-stripped, entity-decoded text (reuse `plainText`/`decodeEntities`).
- **Update id** ← `${entryId}:${update.created_at}` (the Instatus convention) so the
  polling loop dedupes updates stably and posts only newly-appeared blocks.
- Sort ascending by time. If no blocks parse, emit a single update from the whole
  content/summary so every incident has at least one update.

Shared helpers (`decodeEntities`, `plainText`, `parseUpdateTimestamp`,
`canonicalIncidentStatus`, `canonicalImpact`) are currently private to `instatus.ts`.
The plan should extract the genuinely shared ones into a small `feed-text.ts` (or
exported from a shared module) and have both providers import them, rather than
duplicating. Scope this extraction to only what `feed.ts` reuses.

### 5. Page status synthesis — `feedPageStatus(activeIncidents): PageStatus`
Feeds have no "all systems operational" indicator and always list past (resolved)
incidents. An incident is **active** when its latest update status is not `resolved`.
- No active incidents → `{ indicator: "none", description: "All Systems Operational" }`.
- Otherwise → a generic non-operational status (e.g. `{ indicator: "minor",
  description: "Active Incidents" }`), since impact is unknown.

### 6. Provider object
```ts
export const feed: Provider = {
  id: "feed",
  displayName: "RSS/Atom feed",
  probe(baseUrl),        // fetch, detectFeedKind, parse; return {page, status} or null
  fetchSummary(monitor), // parse feed, filter to active incidents, synthesize status
  fetchIncidents(monitor)// parse feed → full incident list (incl. resolved)
}
```
All three fetch the single feed URL (`monitor.baseUrl`) once and parse it. `probe` and
the fetchers swallow network/parse errors and return `null`/throw per the existing
provider contract (probe returns `null` on any failure so the chain falls through to
the error message).

### 7. Wiring (small, mechanical)
- `src/providers/types.ts`: add `"feed"` to `ProviderId`.
- `src/providers/index.ts`: import `feed`; add to `PROVIDERS`; append to `PROBE_ORDER`
  (last, so real providers win first). Comment why it is last.
- `src/index.ts`: add `"feed"` to the `monitorSchema` provider enum; update the
  `/monitor add` failure message (above).

## Data flow

`/monitor add <feed-url>` → `detectProvider` → providers miss → `feed.probe` fetches
and parses the feed → returns page+status → monitor persisted with `provider: "feed"`,
`baseUrl: <feed-url>`. Polling loop calls `feed.fetchIncidents` each interval → parses
entries → existing dedupe posts any incident/update whose id is newly seen. `/status`
and `/testpost` call `feed.fetchSummary` (active-only).

## Error handling

- Unreachable/non-feed URL during probe → `probe` returns `null` → standard add error.
- Malformed feed at poll time → `fetchIncidents` throws; the polling loop's existing
  per-monitor error handling applies (no special-casing).
- Unparseable individual timestamps/blocks degrade gracefully to entry-level time and
  a single update, never throwing.

## Testing

Following the existing `*.test.ts` pattern with fixture XML (no network in unit tests):
- `detectFeedKind`: atom vs rss vs garbage.
- `parseAtomFeed`: Slack fixture (prose updates, no status markers, multiple `<small>`
  blocks, retrospective summary) and GitHub/Statuspage fixture (`<strong>STATUS</strong>`
  markers). Assert stable ids, ordered updates, resolved detection, impact default.
- `parseRssFeed`: GitHub RSS (blocks in `<description>`) and Slack RSS (summary only →
  single update) fixtures.
- `parseFeedUpdates`: both `<small>` timestamp formats; missing-marker keyword sniff;
  empty/garbage content → single fallback update.
- `feedPageStatus`: all-resolved → operational; one active → non-operational.
- Provider-level `probe` returning `null` for an HTML page (fixture) so the probe order
  is correct.

## Known limitations (documented, accepted)

- **No impact severity** from feeds → generic indicator.
- **Resolved detection for marker-less feeds (Slack) is heuristic** (keyword sniff); a
  resolved incident that never says "resolved" in prose would stay shown as active.
- **RSS without update blocks** (Slack RSS) yields a single coarse update per incident;
  Atom is strictly better for those pages, which is why we accept either and let the
  user pick the link.
