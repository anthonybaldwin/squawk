import { test, expect, describe } from "bun:test";
import {
  detectFeedKind,
  parseFeedUpdates,
  parseAtomFeed,
  parseRssFeed,
  parseFeed,
  feedPageStatus,
  feed,
} from "./feed";
import { decodeEntities } from "./feed-text";
import type { Incident } from "./types";

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

// Helper: real feeds escape their HTML content; mimic that so tests exercise the decode path.
function decode(realHtml: string): string {
  return realHtml
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

describe("parseFeedUpdates", () => {
  const base = "2026-06-05T00:00:00Z";

  test("parses Statuspage-style blocks with <strong>STATUS</strong> markers", () => {
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

describe("feed provider object", () => {
  test("has the expected identity and Provider shape", () => {
    expect(feed.id).toBe("feed");
    expect(feed.displayName).toBe("RSS/Atom feed");
    expect(typeof feed.probe).toBe("function");
    expect(typeof feed.fetchSummary).toBe("function");
    expect(typeof feed.fetchIncidents).toBe("function");
  });
});
