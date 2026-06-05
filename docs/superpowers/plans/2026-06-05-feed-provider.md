# Generic RSS/Atom Feed Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic `feed` provider so any status page with a direct Atom or RSS feed URL can be monitored, used as the last-resort fallback after the vendor-specific providers.

**Architecture:** A new `src/providers/feed.ts` implements the existing `Provider` interface (`probe`/`fetchSummary`/`fetchIncidents`) by fetching a single feed URL and parsing it into the canonical `Summary`/`Incident` model. Each feed entry becomes one incident keyed by its stable `<id>`/`<guid>`; the timestamped update blocks inside `<content>`/`<description>` become `IncidentUpdate`s with stable ids, so the existing polling loop posts new updates over time. Shared XML-text helpers move to `src/providers/feed-text.ts`. The provider registers last in `PROBE_ORDER`; the feed URL the user supplies *is* the monitor's `baseUrl`.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun:test`), zod (monitor schema). Regex-based XML parsing matching the existing `instatus.ts` style (no XML library dependency).

**Design reference:** `docs/superpowers/specs/2026-06-05-rss-atom-feed-provider-design.md`

---

## File Structure

- **Create** `src/providers/feed-text.ts` — shared, pure XML-text utilities (`decodeEntities`, `plainText`, `parseFeedTimestamp`). One responsibility: turning raw feed text fragments into clean strings/timestamps.
- **Create** `src/providers/feed-text.test.ts` — unit tests for the above.
- **Modify** `src/providers/instatus.ts` — drop its private `decodeEntities`/`plainText`, import them from `./feed-text` (DRY; no behavior change).
- **Create** `src/providers/feed.ts` — the feed provider: format detection, update/atom/rss parsing, page-status synthesis, and the `Provider` object.
- **Create** `src/providers/feed.test.ts` — unit tests for the parser functions (no network).
- **Modify** `src/providers/types.ts` — add `"feed"` to `ProviderId`.
- **Modify** `src/providers/index.ts` — register `feed`, append to `PROBE_ORDER`.
- **Modify** `src/index.ts` — add `"feed"` to the monitor schema enum; reword the `/monitor add` failure message.

### Key types & signatures (used consistently across tasks)

```ts
// feed-text.ts
export function decodeEntities(text: string): string
export function plainText(html: string): string
export function parseFeedTimestamp(token: string, baseIso: string): { iso: string; hasDate: boolean } | null

// feed.ts
export function detectFeedKind(xml: string): "atom" | "rss" | null
export function parseFeedUpdates(rawContent: string, entryId: string, entryTimeIso: string): IncidentUpdate[]
export function parseAtomFeed(xml: string, baseUrl: string): { page: Summary["page"]; incidents: Incident[] }
export function parseRssFeed(xml: string, baseUrl: string): { page: Summary["page"]; incidents: Incident[] }
export function parseFeed(xml: string, baseUrl: string): { page: Summary["page"]; incidents: Incident[] } | null
export function feedPageStatus(incidents: Incident[]): PageStatus
export const feed: Provider
```

---

## Task 1: Shared XML-text helpers (`feed-text.ts`)

**Files:**
- Create: `src/providers/feed-text.ts`
- Create: `src/providers/feed-text.test.ts`
- Modify: `src/providers/instatus.ts` (imports only)

- [ ] **Step 1: Write the failing test**

Create `src/providers/feed-text.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { decodeEntities, plainText, parseFeedTimestamp } from "./feed-text";

describe("decodeEntities", () => {
  test("decodes the entities that appear in status feeds", () => {
    expect(decodeEntities("a &amp; b")).toBe("a & b");
    expect(decodeEntities("&lt;p&gt;hi&lt;/p&gt;")).toBe("<p>hi</p>");
    expect(decodeEntities("&quot;x&quot; &apos;y&apos;")).toBe('"x" \'y\'');
    expect(decodeEntities("it&#39;s")).toBe("it's");
  });
});

describe("plainText", () => {
  test("strips tags, decodes entities, collapses whitespace", () => {
    expect(plainText("<p>hello   <strong>world</strong></p>")).toBe("hello world");
    expect(plainText("a &amp;amp; b")).toBe("a &amp; b");
  });
  test("trims a single duplicate trailing period", () => {
    expect(plainText("Done..")).toBe("Done.");
  });
});

describe("parseFeedTimestamp", () => {
  const base = "2026-06-05T00:00:00Z";

  test("parses Statuspage 'Mon D, HH:MM TZ' form with date", () => {
    const r = parseFeedTimestamp("Jun 5, 17:25 UTC", base);
    expect(r).not.toBeNull();
    expect(r!.hasDate).toBe(true);
    expect(r!.iso).toBe("2026-06-05T17:25:00.000Z");
  });

  test("parses Statuspage form with seconds", () => {
    const r = parseFeedTimestamp("Jun 5, 01:40:38", base);
    expect(r!.iso).toBe("2026-06-05T01:40:38.000Z");
  });

  test("parses Slack time-only 'H:MMpm TZ' anchored to base date, hasDate=false", () => {
    const r = parseFeedTimestamp("3:23pm PST", base);
    expect(r).not.toBeNull();
    expect(r!.hasDate).toBe(false);
    expect(r!.iso).toBe("2026-06-05T15:23:00.000Z");
  });

  test("handles 12am/12pm correctly", () => {
    expect(parseFeedTimestamp("12:00am PST", base)!.iso).toBe("2026-06-05T00:00:00.000Z");
    expect(parseFeedTimestamp("12:30pm PST", base)!.iso).toBe("2026-06-05T12:30:00.000Z");
  });

  test("returns null when nothing parses", () => {
    expect(parseFeedTimestamp("no time here", base)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/providers/feed-text.test.ts`
Expected: FAIL — `Cannot find module './feed-text'`.

- [ ] **Step 3: Create `src/providers/feed-text.ts`**

```ts
/**
 * Pure XML-text utilities shared by feed-consuming providers (instatus, feed).
 * No network, no DOM — just string and timestamp normalization.
 */

/** Decode the handful of XML/HTML entities that appear in status feeds. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Strip all tags and collapse whitespace; trim a single duplicate trailing period. */
export function plainText(html: string): string {
  const text = decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  // Some feeds append a period to bodies that already end in one, yielding "..".
  return text.replace(/\.\.$/, ".");
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a feed update `<small>` timestamp into an ISO string, using `baseIso`
 * (the entry's published/updated time) to fill missing components.
 *
 *  - Statuspage form: "Jun 5, 17:25 UTC" / "Jun 5, 01:40:38" — month+day, no year.
 *  - Slack form:      "3:23pm PST" — time-of-day only, no date.
 *
 * Timezone abbreviations are ignored (clock time is treated as UTC); within a
 * single feed this keeps ordering and display consistent. `hasDate` is false for
 * time-only tokens so the caller can apply day-rollover across an ordered run.
 */
export function parseFeedTimestamp(token: string, baseIso: string): { iso: string; hasDate: boolean } | null {
  const base = new Date(baseIso);
  const baseValid = !Number.isNaN(base.getTime());
  const year = baseValid ? base.getUTCFullYear() : 1970;

  // Statuspage: "Mon D, HH:MM[:SS]"
  const md = token.match(/([A-Za-z]{3})\s+(\d{1,2})\s*,\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (md) {
    const month = MONTHS[md[1].toLowerCase()];
    if (month !== undefined) {
      const iso = new Date(Date.UTC(
        year, month, Number(md[2]), Number(md[3]), Number(md[4]), Number(md[5] ?? 0),
      )).toISOString();
      return { iso, hasDate: true };
    }
  }

  // Slack: "H:MM[am|pm]" time-only, anchored to the base date.
  const t = token.match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
  if (t) {
    let hour = Number(t[1]);
    const min = Number(t[2]);
    const ampm = t[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const d = baseValid ? base : new Date(Date.UTC(1970, 0, 1));
    const iso = new Date(Date.UTC(
      d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, min, 0,
    )).toISOString();
    return { iso, hasDate: false };
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/providers/feed-text.test.ts`
Expected: PASS (all `describe` blocks green).

- [ ] **Step 5: Refactor `instatus.ts` to import the shared helpers**

In `src/providers/instatus.ts`, **delete** the local `decodeEntities` function (lines beginning `/** Decode the handful of XML/HTML entities…`) and the local `plainText` function (`/** Strip all tags and collapse whitespace…`). Add an import near the top, after the existing `import type { … } from "./types";`:

```ts
import { decodeEntities, plainText } from "./feed-text";
```

(Leave `normKey`, `firstMatch`, `parseUpdateTimestamp`, and all canonical mappers in `instatus.ts` unchanged.)

- [ ] **Step 6: Verify no regression in instatus + feed-text**

Run: `bun test src/providers/instatus.test.ts src/providers/feed-text.test.ts`
Expected: PASS (instatus suite unchanged behavior; feed-text green).

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/providers/feed-text.ts src/providers/feed-text.test.ts src/providers/instatus.ts
git commit -m "refactor: extract shared feed-text helpers; add parseFeedTimestamp

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Feed format detection (`detectFeedKind`)

**Files:**
- Create: `src/providers/feed.ts`
- Create: `src/providers/feed.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/providers/feed.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { detectFeedKind } from "./feed";

describe("detectFeedKind", () => {
  test("recognizes Atom", () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>`;
    expect(detectFeedKind(xml)).toBe("atom");
  });
  test("recognizes RSS", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>`;
    expect(detectFeedKind(xml)).toBe("rss");
  });
  test("recognizes a bare channel as RSS", () => {
    expect(detectFeedKind(`<channel><title>x</title></channel>`)).toBe("rss");
  });
  test("returns null for HTML", () => {
    expect(detectFeedKind(`<!doctype html><html><head><title>Status</title></head></html>`)).toBeNull();
  });
  test("returns null for empty/garbage", () => {
    expect(detectFeedKind("")).toBeNull();
    expect(detectFeedKind("not xml at all")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/providers/feed.test.ts`
Expected: FAIL — `Cannot find module './feed'`.

- [ ] **Step 3: Create `src/providers/feed.ts` with the detector**

```ts
import { decodeEntities, plainText, parseFeedTimestamp } from "./feed-text";
import { canonicalIncidentStatus } from "./instatus";
import type {
  Incident,
  IncidentUpdate,
  PageStatus,
  Provider,
  ProviderMonitor,
  Summary,
} from "./types";

/** Identify whether a document is an Atom feed, an RSS feed, or neither. */
export function detectFeedKind(xml: string): "atom" | "rss" | null {
  const head = xml.slice(0, 4000).toLowerCase();
  if (/<feed[\s>]/.test(head)) return "atom";
  if (/<rss[\s>]/.test(head) || /<channel[\s>]/.test(head)) return "rss";
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/providers/feed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/feed.ts src/providers/feed.test.ts
git commit -m "feat(feed): detect atom vs rss feed documents

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Update-block parser (`parseFeedUpdates`)

Parses the timestamped update blocks inside an entry's `<content>`/`<description>` into ordered `IncidentUpdate`s with stable ids.

**Files:**
- Modify: `src/providers/feed.ts`
- Modify: `src/providers/feed.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/providers/feed.test.ts`:

```ts
import { parseFeedUpdates } from "./feed";

describe("parseFeedUpdates", () => {
  const base = "2026-06-05T00:00:00Z";

  test("parses Statuspage-style blocks with <strong>STATUS</strong> markers", () => {
    // Note: real atom <content> is entity-escaped; the parser decodes first.
    const content = decode(`
      <p><small>Jun 5, 17:25 UTC</small><br><strong>Update</strong> - Customers may see errors.</p>
      <p><small>Jun 5, 17:20 UTC</small><br><strong>Investigating</strong> - We are investigating.</p>
    `);
    const u = parseFeedUpdates(content, "inc1", base);
    expect(u.length).toBe(2);
    // sorted ascending by time
    expect(u[0].status).toBe("investigating");
    expect(u[0].body).toContain("investigating");
    expect(u[1].status).toBe("investigating"); // "Update" is not a lifecycle word -> default
    expect(u[1].body).toContain("errors");
    // stable, order-independent ids
    expect(u[0].id).not.toBe(u[1].id);
    expect(u[0].id.startsWith("inc1:")).toBe(true);
  });

  test("parses Slack-style marker-less blocks and rolls over past midnight", () => {
    const content = decode(`
      <p><small>3:23pm PST</small> We are aware of an issue impacting threads.</p>
      <p><small>10:55pm PST</small> Our work on this issue is still ongoing.</p>
      <p><small>8:55am PST</small> We have identified the cause and implemented a fix.</p>
      <p><small>9:34am PST</small> We have resolved the issue with threads.</p>
    `);
    const u = parseFeedUpdates(content, "inc2", base);
    expect(u.length).toBe(4);
    // document order preserved (time-only feed); times monotonic non-decreasing
    expect(u[0].body).toContain("aware");
    expect(u[3].body).toContain("resolved");
    expect(u[3].status).toBe("resolved"); // keyword sniff
    expect(new Date(u[3].created_at).getTime()).toBeGreaterThan(new Date(u[0].created_at).getTime());
    // 8:55am is the *next* day relative to 10:55pm
    expect(new Date(u[2].created_at).getTime()).toBeGreaterThan(new Date(u[1].created_at).getTime());
  });

  test("falls back to a single update when there are no <small> blocks", () => {
    const u = parseFeedUpdates(decode("<p>From 7:12 AM to 4:50 PM some users saw errors. Issue resolved.</p>"), "inc3", base);
    expect(u.length).toBe(1);
    expect(u[0].id).toBe("inc3:0");
    expect(u[0].status).toBe("resolved");
    expect(u[0].body).toContain("some users");
  });

  test("returns empty array for empty content", () => {
    expect(parseFeedUpdates("", "inc4", base)).toEqual([]);
  });
});

// Helper: real feeds escape their HTML content; mimic that so tests exercise the decode path.
function decode(realHtml: string): string {
  return realHtml
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
```

Add `decodeEntities` to the existing import at the top of the test file:

```ts
import { detectFeedKind, parseFeedUpdates } from "./feed";
import { decodeEntities } from "./feed-text";
```

(The `decode()` helper double-encodes so the content arrives escaped like a real `<content type="html">`; `parseFeedUpdates` decodes it internally.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/providers/feed.test.ts`
Expected: FAIL — `parseFeedUpdates is not a function` / not exported.

- [ ] **Step 3: Implement `parseFeedUpdates` (and helpers) in `feed.ts`**

Add to `src/providers/feed.ts`:

```ts
/** Feed bodies are double-encoded (`&amp;nbsp;`); turn what remains into spaces. */
function feedText(html: string): string {
  return plainText(html).replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

/** Normalize a <small> token into a compact, stable discriminator for update ids. */
function tokenKey(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Infer a lifecycle status from prose when no <strong>STATUS</strong> marker exists. */
function sniffStatus(text: string): string {
  const t = text.toLowerCase();
  if (/\bresolved\b/.test(t)) return "resolved";
  if (/\bmonitoring\b/.test(t)) return "monitoring";
  if (/\bidentified\b/.test(t)) return "identified";
  return "investigating";
}

type RawBlock = { token: string; statusWord?: string; body: string };

/**
 * Parse an entry's (possibly entity-escaped) content into ordered updates.
 *
 * Each update block is delimited by a `<small>TIMESTAMP</small>` followed by an
 * optional `<strong>STATUS</strong> -` marker and the body text. Update ids are
 * `${entryId}:${tokenKey}` so they are stable across polls regardless of the
 * feed's entry ordering (newest-first vs oldest-first).
 */
export function parseFeedUpdates(rawContent: string, entryId: string, entryTimeIso: string): IncidentUpdate[] {
  const html = decodeEntities(rawContent);
  const blocks: RawBlock[] = [];

  const smallRe = /<small>([\s\S]*?)<\/small>([\s\S]*?)(?=<small>|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = smallRe.exec(html)) !== null) {
    const token = plainText(m[1]);
    let rest = m[2];
    let statusWord: string | undefined;
    const marker = rest.match(/<strong>\s*([A-Za-z ]+?)\s*<\/strong>\s*-?/);
    if (marker && !marker[1].trim().endsWith(":")) {
      statusWord = marker[1].trim();
      rest = rest.replace(marker[0], " ");
    }
    blocks.push({ token, statusWord, body: feedText(rest) || "No message provided." });
  }

  if (blocks.length === 0) {
    const body = feedText(html);
    if (!body) return [];
    return [{
      id: `${entryId}:0`,
      status: sniffStatus(body),
      body,
      created_at: entryTimeIso,
      updated_at: entryTimeIso,
    }];
  }

  // Assign timestamps. If any block carries a full date (Statuspage), trust parsed
  // times and sort. Otherwise (Slack time-only) keep document order and roll the day
  // forward whenever the clock decreases, so an overnight run stays chronological.
  const parsed = blocks.map((b) => parseFeedTimestamp(b.token, entryTimeIso));
  const anyDated = parsed.some((p) => p?.hasDate);

  let times: string[];
  if (anyDated) {
    times = parsed.map((p) => p?.iso ?? entryTimeIso);
  } else {
    const base = new Date(entryTimeIso);
    const baseValid = !Number.isNaN(base.getTime());
    let dayOffset = 0;
    let prevMinutes = -1;
    times = blocks.map((b) => {
      const t = b.token.match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
      if (!t || !baseValid) return entryTimeIso;
      let hour = Number(t[1]);
      const min = Number(t[2]);
      const ampm = t[3]?.toLowerCase();
      if (ampm === "pm" && hour < 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
      const minutes = hour * 60 + min;
      if (prevMinutes >= 0 && minutes < prevMinutes) dayOffset++;
      prevMinutes = minutes;
      return new Date(Date.UTC(
        base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + dayOffset, hour, min, 0,
      )).toISOString();
    });
  }

  const updates: IncidentUpdate[] = blocks.map((b, i) => ({
    id: `${entryId}:${tokenKey(b.token) || i}`,
    status: b.statusWord ? canonicalIncidentStatus(b.statusWord) : sniffStatus(b.body),
    body: b.body,
    created_at: times[i],
    updated_at: times[i],
  }));

  if (anyDated) {
    updates.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }
  return updates;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/providers/feed.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck` (expect no errors), then:

```bash
git add src/providers/feed.ts src/providers/feed.test.ts
git commit -m "feat(feed): parse timestamped update blocks into stable-id updates

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Atom feed parser (`parseAtomFeed`)

**Files:**
- Modify: `src/providers/feed.ts`
- Modify: `src/providers/feed.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/providers/feed.test.ts`:

```ts
import { parseAtomFeed } from "./feed";

const SLACK_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <id>https://status.slack.com</id>
  <link rel="alternate" type="text/html" href="https://slack-status.com" />
  <title>Slack System Status</title>
  <updated>2025-12-18T08:44:51-08:00</updated>
  <entry>
    <id>https://slack-status.com/2025-12/a8c230d2dfa1ac93</id>
    <published>2025-12-08T15:23:58-08:00</published>
    <updated>2025-12-18T08:44:51-08:00</updated>
    <link rel="alternate" type="text/html" href="https://slack-status.com/2025-12/a8c230d2dfa1ac93" />
    <title>Incident: Issues loading or viewing threads</title>
    <content type="html">&lt;p&gt;&lt;small&gt;3:23pm PST&lt;/small&gt; We are aware of an issue impacting threads.&lt;/p&gt;&lt;p&gt;&lt;small&gt;9:34am PST&lt;/small&gt; We have resolved the issue with threads.&lt;/p&gt;</content>
  </entry>
</feed>`;

const GH_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>GitHub Status - Incident History</title>
  <link rel="alternate" type="text/html" href="https://www.githubstatus.com"/>
  <entry>
    <id>tag:www.githubstatus.com,2005:Incident/30463506</id>
    <published>2026-06-05T17:20:00Z</published>
    <updated>2026-06-05T17:25:44Z</updated>
    <link rel="alternate" type="text/html" href="https://www.githubstatus.com/incidents/2nmfnbknhlnv"/>
    <title>Disruption with some GitHub services</title>
    <content type="html">&lt;p&gt;&lt;small&gt;Jun 5, 17:25 UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - Customers may see unexpected events.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Jun 5, 17:20 UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Investigating&lt;/strong&gt; - We are investigating reports.&lt;/p&gt;</content>
  </entry>
</feed>`;

describe("parseAtomFeed", () => {
  test("reads page name and home link from the feed head", () => {
    const { page } = parseAtomFeed(SLACK_ATOM, "https://slack-status.com/feed/atom");
    expect(page.name).toBe("Slack System Status");
    expect(page.url).toBe("https://slack-status.com");
  });

  test("Slack: marker-less entry resolves via keyword sniff", () => {
    const { incidents } = parseAtomFeed(SLACK_ATOM, "https://slack-status.com/feed/atom");
    expect(incidents.length).toBe(1);
    const inc = incidents[0];
    expect(inc.id).toBe("https://slack-status.com/2025-12/a8c230d2dfa1ac93");
    expect(inc.name).toBe("Incident: Issues loading or viewing threads");
    expect(inc.status).toBe("resolved");
    expect(inc.resolved_at).not.toBeNull();
    expect(inc.impact).toBe("minor");
    expect(inc.shortlink).toBe("https://slack-status.com/2025-12/a8c230d2dfa1ac93");
    expect(inc.incident_updates.length).toBe(2);
  });

  test("GitHub: newest-first entry sorts updates ascending and stays active", () => {
    const { incidents } = parseAtomFeed(GH_ATOM, "https://www.githubstatus.com/history.atom");
    const inc = incidents[0];
    expect(inc.id).toBe("tag:www.githubstatus.com,2005:Incident/30463506");
    expect(inc.incident_updates[0].body).toContain("investigating reports");
    expect(inc.incident_updates[1].body).toContain("unexpected events");
    expect(inc.status).not.toBe("resolved");
    expect(inc.resolved_at).toBeNull();
  });
});
```

Update the top import to include `parseAtomFeed` (combine with the existing `./feed` import line).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/providers/feed.test.ts`
Expected: FAIL — `parseAtomFeed is not a function`.

- [ ] **Step 3: Implement `parseAtomFeed` and shared assembly helpers in `feed.ts`**

```ts
function firstMatch(source: string, re: RegExp): string | undefined {
  const m = source.match(re);
  return m ? m[1] : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

/** Build a canonical Incident from an entry's parsed parts. Resolved is terminal:
 *  any resolved update marks the incident resolved, independent of feed ordering. */
function assembleIncident(
  id: string,
  name: string,
  shortlink: string | undefined,
  entryCreated: string,
  entryUpdated: string,
  updates: IncidentUpdate[],
): Incident {
  const resolved = updates.find((u) => u.status === "resolved");
  const latest = [...updates].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )[0];
  const status = resolved ? "resolved" : (latest?.status ?? "investigating");
  return {
    id,
    name,
    status,
    impact: "minor", // feeds carry no impact severity
    shortlink,
    created_at: updates[0]?.created_at ?? entryCreated,
    updated_at: latest?.created_at ?? entryUpdated,
    resolved_at: resolved ? (resolved.created_at ?? entryUpdated) : null,
    incident_updates: updates,
  };
}

/** Parse a full Atom document into a page descriptor + canonical incidents. */
export function parseAtomFeed(xml: string, baseUrl: string): { page: Summary["page"]; incidents: Incident[] } {
  const head = xml.split(/<entry[\s>]/)[0];
  const name = decodeEntities(firstMatch(head, /<title[^>]*>([\s\S]*?)<\/title>/)?.trim() ?? "Status feed");
  const homeLink =
    firstMatch(head, /<link[^>]*rel=["']alternate["'][^>]*type=["']text\/html["'][^>]*href=["']([^"']+)["']/) ??
    firstMatch(head, /<link[^>]*type=["']text\/html["'][^>]*href=["']([^"']+)["']/) ??
    baseUrl;
  const page = { id: hostOf(homeLink), name, url: homeLink };

  const entries = [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  const incidents = entries.map((entry) => {
    const id = (firstMatch(entry, /<id>([\s\S]*?)<\/id>/)?.trim() ?? "").replace(/\s+/g, "");
    const name = decodeEntities(firstMatch(entry, /<title[^>]*>([\s\S]*?)<\/title>/)?.trim() ?? "Untitled incident");
    const published = firstMatch(entry, /<published>([\s\S]*?)<\/published>/)?.trim() ?? new Date(0).toISOString();
    const updated = firstMatch(entry, /<updated>([\s\S]*?)<\/updated>/)?.trim() ?? published;
    const shortlink = firstMatch(entry, /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/);
    const content =
      firstMatch(entry, /<content[^>]*>([\s\S]*?)<\/content>/) ??
      firstMatch(entry, /<summary[^>]*>([\s\S]*?)<\/summary>/) ??
      "";
    const updates = parseFeedUpdates(content, id || shortlink || name, published);
    return assembleIncident(id || shortlink || name, name, shortlink, published, updated, updates);
  });

  return { page, incidents };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/providers/feed.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck`, then:

```bash
git add src/providers/feed.ts src/providers/feed.test.ts
git commit -m "feat(feed): parse Atom feeds into canonical incidents

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: RSS feed parser (`parseRssFeed`)

**Files:**
- Modify: `src/providers/feed.ts`
- Modify: `src/providers/feed.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/providers/feed.test.ts`:

```ts
import { parseRssFeed } from "./feed";

const GH_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>GitHub Status - Incident History</title>
  <link>https://www.githubstatus.com</link>
  <item>
    <title>Disruption with some GitHub services</title>
    <description>&lt;p&gt;&lt;small&gt;Jun 5, 17:25 UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - Customers may see events.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Jun 5, 17:20 UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Investigating&lt;/strong&gt; - We are investigating.&lt;/p&gt;</description>
    <pubDate>Fri, 05 Jun 2026 17:25:44 +0000</pubDate>
    <link>https://www.githubstatus.com/incidents/2nmfnbknhlnv</link>
    <guid>https://www.githubstatus.com/incidents/2nmfnbknhlnv</guid>
  </item>
</channel></rss>`;

const SLACK_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Slack System Status</title>
  <link>https://slack-status.com</link>
  <item>
    <title>Incident: Issues loading or viewing threads</title>
    <description>From 7:12 AM to 4:50 PM PST some users encountered errors loading threads.</description>
    <pubDate>Thu, 18 Dec 2025 08:44:51 -0800</pubDate>
    <link>https://slack-status.com/2025-12/a8c230d2dfa1ac93</link>
    <guid>https://slack-status.com/2025-12/a8c230d2dfa1ac93</guid>
  </item>
</channel></rss>`;

describe("parseRssFeed", () => {
  test("reads channel title/link", () => {
    const { page } = parseRssFeed(GH_RSS, "https://www.githubstatus.com/history.rss");
    expect(page.name).toBe("GitHub Status - Incident History");
    expect(page.url).toBe("https://www.githubstatus.com");
  });

  test("GitHub RSS: parses update blocks from <description>", () => {
    const { incidents } = parseRssFeed(GH_RSS, "https://www.githubstatus.com/history.rss");
    const inc = incidents[0];
    expect(inc.id).toBe("https://www.githubstatus.com/incidents/2nmfnbknhlnv");
    expect(inc.incident_updates.length).toBe(2);
    expect(inc.shortlink).toBe("https://www.githubstatus.com/incidents/2nmfnbknhlnv");
  });

  test("Slack RSS: summary-only description yields one update", () => {
    const { incidents } = parseRssFeed(SLACK_RSS, "https://slack-status.com/feed/rss");
    const inc = incidents[0];
    expect(inc.incident_updates.length).toBe(1);
    expect(inc.incident_updates[0].body).toContain("7:12 AM");
  });
});
```

Add `parseRssFeed` to the `./feed` import line.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/providers/feed.test.ts`
Expected: FAIL — `parseRssFeed is not a function`.

- [ ] **Step 3: Implement `parseRssFeed` in `feed.ts`**

```ts
/** Parse a full RSS document into a page descriptor + canonical incidents. */
export function parseRssFeed(xml: string, baseUrl: string): { page: Summary["page"]; incidents: Incident[] } {
  const channelHead = xml.split(/<item[\s>]/)[0];
  const name = decodeEntities(firstMatch(channelHead, /<title[^>]*>([\s\S]*?)<\/title>/)?.trim() ?? "Status feed");
  const home = firstMatch(channelHead, /<link[^>]*>([\s\S]*?)<\/link>/)?.trim() ?? baseUrl;
  const page = { id: hostOf(home), name, url: home };

  const items = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const incidents = items.map((item) => {
    const id = (
      firstMatch(item, /<guid[^>]*>([\s\S]*?)<\/guid>/) ??
      firstMatch(item, /<link[^>]*>([\s\S]*?)<\/link>/) ??
      ""
    ).trim();
    const name = decodeEntities(firstMatch(item, /<title[^>]*>([\s\S]*?)<\/title>/)?.trim() ?? "Untitled incident");
    const pubRaw = firstMatch(item, /<pubDate>([\s\S]*?)<\/pubDate>/)?.trim();
    const pubDate = pubRaw ? new Date(pubRaw) : null;
    const pubIso = pubDate && !Number.isNaN(pubDate.getTime()) ? pubDate.toISOString() : new Date(0).toISOString();
    const shortlink = firstMatch(item, /<link[^>]*>([\s\S]*?)<\/link>/)?.trim();
    const description = firstMatch(item, /<description[^>]*>([\s\S]*?)<\/description>/) ?? "";
    const updates = parseFeedUpdates(description, id || shortlink || name, pubIso);
    return assembleIncident(id || shortlink || name, name, shortlink, pubIso, pubIso, updates);
  });

  return { page, incidents };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/providers/feed.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck`, then:

```bash
git add src/providers/feed.ts src/providers/feed.test.ts
git commit -m "feat(feed): parse RSS feeds into canonical incidents

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Page-status synthesis + feed dispatch (`feedPageStatus`, `parseFeed`)

**Files:**
- Modify: `src/providers/feed.ts`
- Modify: `src/providers/feed.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/providers/feed.test.ts`:

```ts
import { feedPageStatus, parseFeed } from "./feed";
import type { Incident } from "./types";

function inc(status: string): Incident {
  return {
    id: "x", name: "x", status, impact: "minor",
    created_at: "2026-06-05T00:00:00Z", updated_at: "2026-06-05T00:00:00Z",
    resolved_at: status === "resolved" ? "2026-06-05T00:00:00Z" : null,
    incident_updates: [],
  };
}

describe("feedPageStatus", () => {
  test("all resolved => operational", () => {
    expect(feedPageStatus([inc("resolved"), inc("resolved")])).toEqual({
      indicator: "none", description: "All Systems Operational",
    });
  });
  test("one active => active incident", () => {
    expect(feedPageStatus([inc("resolved"), inc("investigating")])).toEqual({
      indicator: "minor", description: "Active Incident",
    });
  });
  test("multiple active => plural", () => {
    expect(feedPageStatus([inc("investigating"), inc("monitoring")]).description).toBe("Active Incidents");
  });
});

describe("parseFeed", () => {
  test("dispatches to atom", () => {
    const r = parseFeed(SLACK_ATOM, "https://slack-status.com/feed/atom");
    expect(r).not.toBeNull();
    expect(r!.page.name).toBe("Slack System Status");
  });
  test("dispatches to rss", () => {
    const r = parseFeed(GH_RSS, "https://www.githubstatus.com/history.rss");
    expect(r!.incidents[0].incident_updates.length).toBe(2);
  });
  test("returns null for non-feed HTML", () => {
    expect(parseFeed("<!doctype html><html></html>", "https://example.com")).toBeNull();
  });
});
```

Add `feedPageStatus` and `parseFeed` to the `./feed` import line.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/providers/feed.test.ts`
Expected: FAIL — `feedPageStatus is not a function`.

- [ ] **Step 3: Implement `feedPageStatus` and `parseFeed` in `feed.ts`**

```ts
/** Synthesize a page-level status. Feeds have no operational indicator and always
 *  list past (resolved) incidents, so the page is operational unless something is
 *  still active. Impact is unknown, so active pages report a generic "minor". */
export function feedPageStatus(incidents: Incident[]): PageStatus {
  const active = incidents.filter((i) => i.status !== "resolved");
  if (active.length === 0) {
    return { indicator: "none", description: "All Systems Operational" };
  }
  return { indicator: "minor", description: active.length === 1 ? "Active Incident" : "Active Incidents" };
}

/** Detect the feed kind and parse accordingly; null when the document is not a feed. */
export function parseFeed(xml: string, baseUrl: string): { page: Summary["page"]; incidents: Incident[] } | null {
  const kind = detectFeedKind(xml);
  if (kind === "atom") return parseAtomFeed(xml, baseUrl);
  if (kind === "rss") return parseRssFeed(xml, baseUrl);
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/providers/feed.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck`, then:

```bash
git add src/providers/feed.ts src/providers/feed.test.ts
git commit -m "feat(feed): synthesize page status and add parseFeed dispatch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: The `feed` Provider object

**Files:**
- Modify: `src/providers/feed.ts`
- Modify: `src/providers/feed.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/providers/feed.test.ts`:

```ts
import { feed } from "./feed";

describe("feed provider object", () => {
  test("has the expected identity and Provider shape", () => {
    expect(feed.id).toBe("feed");
    expect(feed.displayName).toBe("RSS/Atom feed");
    expect(typeof feed.probe).toBe("function");
    expect(typeof feed.fetchSummary).toBe("function");
    expect(typeof feed.fetchIncidents).toBe("function");
  });
});
```

Add `feed` to the `./feed` import line.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/providers/feed.test.ts`
Expected: FAIL — `feed` is undefined / not exported.

- [ ] **Step 3: Implement the provider in `feed.ts`**

```ts
async function fetchFeedXml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml" },
  });
  if (!response.ok) {
    throw new Error(`Feed request failed (${response.status}) for ${url}`);
  }
  return response.text();
}

export const feed: Provider = {
  id: "feed",
  displayName: "RSS/Atom feed",

  async probe(baseUrl) {
    try {
      const xml = await fetchFeedXml(baseUrl);
      const parsed = parseFeed(xml, baseUrl);
      if (!parsed) return null;
      return { page: parsed.page, status: feedPageStatus(parsed.incidents) };
    } catch {
      return null;
    }
  },

  async fetchSummary(monitor: ProviderMonitor): Promise<Summary> {
    const xml = await fetchFeedXml(monitor.baseUrl);
    const parsed = parseFeed(xml, monitor.baseUrl);
    if (!parsed) throw new Error(`Could not parse a feed at ${monitor.baseUrl}`);
    const active = parsed.incidents.filter((i) => i.status !== "resolved");
    return { page: parsed.page, status: feedPageStatus(parsed.incidents), incidents: active };
  },

  async fetchIncidents(monitor: ProviderMonitor): Promise<Incident[]> {
    const xml = await fetchFeedXml(monitor.baseUrl);
    const parsed = parseFeed(xml, monitor.baseUrl);
    if (!parsed) throw new Error(`Could not parse a feed at ${monitor.baseUrl}`);
    return parsed.incidents;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/providers/feed.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck`, then:

```bash
git add src/providers/feed.ts src/providers/feed.test.ts
git commit -m "feat(feed): add the feed Provider (probe/fetchSummary/fetchIncidents)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Wire `feed` into the registry, schema, and add-command

**Files:**
- Modify: `src/providers/types.ts:8`
- Modify: `src/providers/index.ts`
- Modify: `src/index.ts:54` and `src/index.ts:1794-1797`
- Modify: `src/providers/index.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/providers/index.test.ts` (match its existing import/style; if it has no imports yet, add the first two lines):

```ts
import { test, expect, describe } from "bun:test";
import { SUPPORTED_PROVIDERS } from "./index";

describe("provider registry", () => {
  test("feed provider is registered and probed last", () => {
    const ids = SUPPORTED_PROVIDERS.map((p) => p.id);
    expect(ids).toContain("feed");
    expect(ids[ids.length - 1]).toBe("feed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/providers/index.test.ts`
Expected: FAIL — `feed` not in `SUPPORTED_PROVIDERS`.

- [ ] **Step 3: Add `"feed"` to the `ProviderId` union**

In `src/providers/types.ts` line 8:

```ts
export type ProviderId = "statuspage" | "incidentio" | "instatus" | "feed";
```

- [ ] **Step 4: Register the provider in `src/providers/index.ts`**

Add the import alongside the others:

```ts
import { feed } from "./feed";
```

Add it to the `PROVIDERS` map:

```ts
const PROVIDERS: Record<ProviderId, Provider> = {
  statuspage,
  incidentio,
  instatus,
  feed,
};
```

Append it to `PROBE_ORDER` (must be **last**) and extend the comment:

```ts
const PROBE_ORDER: Provider[] = [incidentio, statuspage, instatus, feed];
```

Above `PROBE_ORDER`, add to the existing doc comment:

```
 * `feed` is probed last and only matches when the supplied URL is itself a
 * parseable Atom/RSS document, so real provider pages always win first and a
 * plain HTML page matches nothing (falling through to the add-command error).
```

- [ ] **Step 5: Add `"feed"` to the monitor schema enum**

In `src/index.ts` line 54:

```ts
  provider: z.enum(["statuspage", "incidentio", "instatus", "feed"]).optional(),
```

- [ ] **Step 6: Reword the `/monitor add` failure message**

Replace the `throw new Error(...)` block at `src/index.ts:1795-1797` with:

```ts
    throw new Error(
      `Could not monitor \`${baseUrl}\`. Auto-detection supports ${supported}. For other status pages, pass a direct **Atom or RSS** feed URL — e.g. \`https://slack-status.com/feed/atom\`.`,
    );
```

(`supported` is the existing `SUPPORTED_PROVIDERS.map((p) => p.displayName).join(", ")`. Since `feed` is now in `SUPPORTED_PROVIDERS`, "RSS/Atom feed" appears in that list automatically — which reads correctly in the message.)

- [ ] **Step 7: Run the registry test + full suite + typecheck**

Run: `bun test`
Expected: PASS (all suites, including the new feed/feed-text/registry tests).

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/providers/types.ts src/providers/index.ts src/providers/index.test.ts src/index.ts
git commit -m "feat: register feed provider and guide users to feed URLs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Documentation

**Files:**
- Modify: `AGENTS.md` (provider list / conventions), `README.md` if it enumerates providers.

- [ ] **Step 1: Update provider references**

Search for where providers are listed: `grep -rin "instatus\|incident.io\|statuspage" AGENTS.md README.md`. In each place that enumerates the supported providers, add the generic feed fallback, e.g.:

> **RSS/Atom feed (`feed`)** — fallback for any status page not covered by a vendor provider. Add it by passing a direct Atom or RSS feed URL to `/monitor add` (Atom is richer; RSS works too). Impact severity is not available from feeds.

Keep wording consistent with the surrounding doc style. Do not invent sections that don't exist; only extend existing provider lists/tables.

- [ ] **Step 2: Verify build still clean**

Run: `bun test && bun run typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: document the generic RSS/Atom feed provider

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- Feed provider as last probe → Tasks 7, 8. ✅
- No scanning; feed URL = baseUrl → Tasks 7 (provider fetches `monitor.baseUrl`), 8 (no schema field added beyond enum). ✅
- Atom vs RSS auto-detect from content → Tasks 2, 6. ✅
- Entry = event with stable id; updates accumulate, dedupe by update id → Task 3 (`${entryId}:${tokenKey}`), Task 4/5 (entry id from `<id>`/`<guid>`). ✅
- Status from `<strong>` marker or keyword sniff; resolved terminal → Task 3 (`sniffStatus`, marker parse), Task 4 (`assembleIncident`). ✅
- Impact defaults; page status synthesized → Task 4 (`impact: "minor"`), Task 6 (`feedPageStatus`). ✅
- Shared helper extraction scoped to reuse → Task 1 (`decodeEntities`/`plainText` only). ✅
- Error message guides to a feed URL → Task 8 Step 6. ✅
- Tests with Slack + Statuspage fixtures, both feed kinds → Tasks 3–7. ✅
- Known limitations documented → Task 9. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✅

**Type consistency:** `parseFeed`/`parseAtomFeed`/`parseRssFeed` all return `{ page: Summary["page"]; incidents: Incident[] }`; `parseFeedUpdates` returns `IncidentUpdate[]`; `feedPageStatus` takes `Incident[]` → `PageStatus`; provider methods match the `Provider` interface in `types.ts`. Update ids use the single convention `${entryId}:${tokenKey|index}`. ✅
