import { test, expect, describe } from "bun:test";
import {
  canonicalIncidentStatus,
  canonicalMaintenanceStatus,
  canonicalImpact,
} from "./instatus";

describe("canonical mappers", () => {
  test("incident status maps Instatus + feed words to canonical set", () => {
    expect(canonicalIncidentStatus("INVESTIGATING")).toBe("investigating");
    expect(canonicalIncidentStatus("Investigating")).toBe("investigating");
    expect(canonicalIncidentStatus("IDENTIFIED")).toBe("identified");
    expect(canonicalIncidentStatus("MONITORING")).toBe("monitoring");
    expect(canonicalIncidentStatus("RESOLVED")).toBe("resolved");
    expect(canonicalIncidentStatus("something-odd")).toBe("investigating");
  });

  test("maintenance status maps lifecycle; completed => resolved", () => {
    expect(canonicalMaintenanceStatus("NOTSTARTEDYET")).toBe("scheduled");
    expect(canonicalMaintenanceStatus("Scheduled")).toBe("scheduled");
    expect(canonicalMaintenanceStatus("INPROGRESS")).toBe("in_progress");
    expect(canonicalMaintenanceStatus("In progress")).toBe("in_progress");
    expect(canonicalMaintenanceStatus("VERIFYING")).toBe("in_progress");
    expect(canonicalMaintenanceStatus("COMPLETED")).toBe("resolved");
    expect(canonicalMaintenanceStatus("Completed")).toBe("resolved");
  });

  test("impact maps Instatus enums to canonical set", () => {
    expect(canonicalImpact("OPERATIONAL")).toBe("none");
    expect(canonicalImpact("MINOROUTAGE")).toBe("minor");
    expect(canonicalImpact("DEGRADEDPERFORMANCE")).toBe("minor");
    expect(canonicalImpact("PARTIALOUTAGE")).toBe("major");
    expect(canonicalImpact("MAJOROUTAGE")).toBe("critical");
    expect(canonicalImpact(undefined)).toBe("none");
    expect(canonicalImpact("weird")).toBe("minor");
  });
});

import { parseUpdateTimestamp } from "./instatus";

describe("parseUpdateTimestamp", () => {
  const published = "2026-06-04T21:10:00.000+00:00";

  test("parses 'Mon D, HH:MM:SS GMT+0' using the published year", () => {
    const iso = parseUpdateTimestamp("Jun  5, 01:40:38 GMT+0", published);
    expect(iso).toBe("2026-06-05T01:40:38.000Z");
  });

  test("rolls the year forward when the month is far below the published month", () => {
    const decPublished = "2025-12-31T23:50:00.000+00:00";
    const iso = parseUpdateTimestamp("Jan  1, 00:30:00 GMT+0", decPublished);
    expect(iso).toBe("2026-01-01T00:30:00.000Z");
  });

  test("rolls year forward for any update that lands before the published date", () => {
    const decPublished = "2025-12-15T12:00:00.000+00:00";
    expect(parseUpdateTimestamp("Mar  2, 01:00:00 GMT+0", decPublished)).toBe("2026-03-02T01:00:00.000Z");
  });

  test("returns null for unparseable input", () => {
    expect(parseUpdateTimestamp("not a date", published)).toBeNull();
  });
});

import { parseInstatusAtom } from "./instatus";

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <title>Perplexity Status - Incident history</title>
  <entry>
    <id>tag:status.perplexity.com,2005:Incident/cmq08wkuw02waqmn6yt1kdgej</id>
    <published>2026-06-04T21:10:00.000+00:00</published>
    <updated>2026-06-05T01:40:38.000+00:00</updated>
    <link rel="alternate" type="text/html" href="https://status.perplexity.com/incident/cmq08wkuw02waqmn6yt1kdgej"/>
    <title>Connector connectivity issues</title>
    <content type="html"><![CDATA[
      <p><strong>Type:</strong> Incident</p>
      <p><strong>Duration:</strong> 4 hours and 31 minutes</p>
      <p><strong>Affected Components:</strong> Website</p>
      <p><small>Jun <var data-var='date'> 5</var>, <var data-var='time'>01:40:38</var> GMT+0</small><br /><strong>Resolved</strong> -
    This incident has been resolved..</p>
      <p><small>Jun <var data-var='date'> 5</var>, <var data-var='time'>01:00:00</var> GMT+0</small><br /><strong>Monitoring</strong> -
    Connectors are recovering and getting back to normal for all users..</p>
      <p><small>Jun <var data-var='date'> 4</var>, <var data-var='time'>21:10:00</var> GMT+0</small><br /><strong>Investigating</strong> -
    We have identified connector issues that are currently impacting users..</p>
    ]]></content>
  </entry>
  <entry>
    <id>tag:status.kagi.com,2005:Incident/cmaintenance123</id>
    <published>2026-02-23T09:00:00.000+00:00</published>
    <updated>2026-02-23T09:18:00.000+00:00</updated>
    <link rel="alternate" type="text/html" href="https://status.kagi.com/incident/cmaintenance123"/>
    <title>Features update for feedback sites</title>
    <content type="html"><![CDATA[
      <p><strong>Type:</strong> Maintenance</p>
      <p><strong>Duration:</strong> 18 minutes</p>
      <p><strong>Affected Components:</strong> feedback</p>
      <p><small>Feb <var data-var='date'> 23</var>, <var data-var='time'>09:18:00</var> GMT+0</small><br /><strong>Completed</strong> -
    The scheduled maintenance has been completed..</p>
      <p><small>Feb <var data-var='date'> 23</var>, <var data-var='time'>09:00:00</var> GMT+0</small><br /><strong>Identified</strong> -
    We will be deploying new features at this time..</p>
    ]]></content>
  </entry>
</feed>`;

describe("parseInstatusAtom", () => {
  const incidents = parseInstatusAtom(ATOM_FIXTURE);

  test("returns one Incident per entry", () => {
    expect(incidents).toHaveLength(2);
  });

  test("extracts id, name, and shortlink", () => {
    const inc = incidents[0];
    expect(inc.id).toBe("cmq08wkuw02waqmn6yt1kdgej");
    expect(inc.name).toBe("Connector connectivity issues");
    expect(inc.shortlink).toBe("https://status.perplexity.com/incident/cmq08wkuw02waqmn6yt1kdgej");
  });

  test("parses updates sorted chronologically with prose bodies", () => {
    const inc = incidents[0];
    expect(inc.incident_updates).toHaveLength(3);
    expect(inc.incident_updates.map((u) => u.status)).toEqual([
      "investigating",
      "monitoring",
      "resolved",
    ]);
    expect(inc.incident_updates[0].body).toBe(
      "We have identified connector issues that are currently impacting users.",
    );
    // Stable, dedupe-friendly update ids keyed on incident id + timestamp.
    expect(inc.incident_updates[0].id).toBe("cmq08wkuw02waqmn6yt1kdgej:2026-06-04T21:10:00.000Z");
  });

  test("top-level status/resolved_at reflect the latest update", () => {
    const inc = incidents[0];
    expect(inc.status).toBe("resolved");
    expect(inc.resolved_at).toBe("2026-06-05T01:40:38.000Z");
    expect(inc.created_at).toBe("2026-06-04T21:10:00.000Z");
  });

  test("maintenance entries get impact=maintenance and maintenance statuses", () => {
    const maint = incidents[1];
    expect(maint.impact).toBe("maintenance");
    // 'Identified' on a maintenance => in_progress; 'Completed' => resolved.
    expect(maint.incident_updates.map((u) => u.status)).toEqual(["in_progress", "resolved"]);
    expect(maint.status).toBe("resolved");
    expect(maint.resolved_at).toBe("2026-02-23T09:18:00.000Z");
  });

  test("incident impact defaults to minor when no summary join is available", () => {
    // Atom carries no impact enum; resolved/historical incidents default to minor.
    expect(incidents[0].impact).toBe("minor");
  });
});

// A scheduled maintenance announced well before it runs: <published> is the
// scheduled START (Jul 19) while <updated> is the announcement (Jul 8), so the
// first update legitimately predates <published>. Anchoring the year-rollover
// heuristic on <published> alone pushed that update into the NEXT year, which
// made it sort last and left the entry looking permanently in_progress.
const ATOM_MAINTENANCE_ANNOUNCED_EARLY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:status.kagi.com,2005:Maintenance/cmrbr5ynx05vc0kp9eoawdsbu</id>
    <published>2026-07-19T06:00:00.000+00:00</published>
    <updated>2026-07-08T07:24:48.978+00:00</updated>
    <link rel="alternate" type="text/html" href="https://status.kagi.com/maintenance/cmrbr5ynx05vc0kp9eoawdsbu"/>
    <title>Database maintenance for Kagi Search</title>
    <content type="html"><![CDATA[
      <p><strong>Type:</strong> Maintenance</p>
      <p><strong>Duration:</strong> 8 minutes</p>
      <p><small>Jul <var data-var='date'> 8</var>, <var data-var='time'>07:24:48</var> GMT+0</small><br /><strong>Identified</strong> -
    We plan to perform a minor upgrade at this time..</p>
      <p><small>Jul <var data-var='date'> 19</var>, <var data-var='time'>06:00:01</var> GMT+0</small><br /><strong>Identified</strong> -
    Maintenance is now in progress.</p>
      <p><small>Jul <var data-var='date'> 19</var>, <var data-var='time'>06:07:55</var> GMT+0</small><br /><strong>Completed</strong> -
    Maintenance has completed successfully..</p>
    ]]></content>
  </entry>
</feed>`;

describe("parseInstatusAtom — maintenance announced before its scheduled start", () => {
  const [maint] = parseInstatusAtom(ATOM_MAINTENANCE_ANNOUNCED_EARLY);

  test("keeps the announcement in the published year instead of rolling it forward", () => {
    expect(maint.incident_updates.map((u) => u.created_at)).toEqual([
      "2026-07-08T07:24:48.000Z",
      "2026-07-19T06:00:01.000Z",
      "2026-07-19T06:07:55.000Z",
    ]);
  });

  test("resolves on the Completed update rather than staying in_progress forever", () => {
    expect(maint.status).toBe("resolved");
    expect(maint.resolved_at).toBe("2026-07-19T06:07:55.000Z");
    expect(maint.created_at).toBe("2026-07-08T07:24:48.000Z");
  });
});

import { mapInstatusSummary, instatusPageStatus, type InstatusSummaryJson } from "./instatus";

const SUMMARY_ACTIVE: InstatusSummaryJson = {
  page: { name: "Perplexity", url: "https://status.perplexity.com", status: "HASISSUES" },
  activeIncidents: [
    {
      id: "cmq08wkuw02waqmn6yt1kdgej",
      name: "Connector connectivity issues",
      started: "2026-06-04T21:10:00.000Z",
      status: "INVESTIGATING",
      impact: "MAJOROUTAGE",
      url: "https://status.perplexity.com/cmq08wkuw02waqmn6yt1kdgej",
      updatedAt: "2026-06-04T21:10:00.000Z",
    },
  ],
  activeMaintenances: [
    {
      id: "cm123",
      name: "DB maintenance",
      start: "2026-06-10T00:00:00.000Z",
      status: "NOTSTARTEDYET",
      duration: "60",
      url: "https://status.perplexity.com/maintenance/cm123",
      updatedAt: "2026-06-09T00:00:00.000Z",
    },
  ],
};

describe("mapInstatusSummary", () => {
  const summary = mapInstatusSummary(SUMMARY_ACTIVE, "https://status.perplexity.com");

  test("synthesizes page.id from the host and keeps name/url", () => {
    expect(summary.page.id).toBe("status.perplexity.com");
    expect(summary.page.name).toBe("Perplexity");
    expect(summary.page.url).toBe("https://status.perplexity.com");
  });

  test("maps active incidents with impact from the summary enum", () => {
    const inc = summary.incidents.find((i) => i.id === "cmq08wkuw02waqmn6yt1kdgej");
    expect(inc?.impact).toBe("critical");
    expect(inc?.status).toBe("investigating");
  });

  test("maps active maintenances as impact=maintenance incidents", () => {
    const maint = summary.incidents.find((i) => i.id === "cm123");
    expect(maint?.impact).toBe("maintenance");
    expect(maint?.status).toBe("scheduled");
  });
});

describe("instatusPageStatus", () => {
  test("UP => operational", () => {
    expect(instatusPageStatus("UP", [])).toEqual({
      indicator: "none",
      description: "All Systems Operational",
    });
  });

  test("UNDERMAINTENANCE => maintenance", () => {
    expect(instatusPageStatus("UNDERMAINTENANCE", []).indicator).toBe("maintenance");
  });

  test("HASISSUES => worst active impact", () => {
    expect(instatusPageStatus("HASISSUES", ["minor", "critical"]).indicator).toBe("critical");
  });
});

import { afterEach } from "bun:test";
import { instatus } from "./instatus";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(routes: Record<string, { status?: number; body: unknown; json?: boolean }>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = Object.keys(routes).find((path) => url.endsWith(path));
    if (!match) return new Response("not found", { status: 404 });
    const route = routes[match];
    const isJson = route.json ?? true;
    const body = isJson ? JSON.stringify(route.body) : String(route.body);
    return new Response(body, {
      status: route.status ?? 200,
      headers: { "content-type": isJson ? "application/json" : "application/atom+xml" },
    });
  }) as typeof fetch;
}

describe("instatus provider", () => {
  test("probe returns normalized page/status for an Instatus summary", async () => {
    stubFetch({
      "/v3/summary.json": { body: { page: { name: "Perplexity", url: "https://status.perplexity.com", status: "UP" } } },
    });
    const probed = await instatus.probe("https://status.perplexity.com");
    expect(probed).not.toBeNull();
    expect(probed?.page.id).toBe("status.perplexity.com");
    expect(probed?.status.indicator).toBe("none");
  });

  test("probe returns null for a Statuspage-shaped summary (no page.status)", async () => {
    stubFetch({
      "/v3/summary.json": { body: { page: { id: "abc", name: "X", url: "https://x" }, status: { indicator: "none", description: "OK" } } },
    });
    expect(await instatus.probe("https://x")).toBeNull();
  });

  test("probe returns null on 404", async () => {
    stubFetch({});
    expect(await instatus.probe("https://not-instatus.example")).toBeNull();
  });

  test("fetchIncidents joins live impact from summary onto feed incidents", async () => {
    stubFetch({
      "/history.atom": { json: false, body: ATOM_FIXTURE },
      "/v3/summary.json": {
        body: {
          page: { name: "Perplexity", url: "https://status.perplexity.com", status: "HASISSUES" },
          activeIncidents: [{ id: "cmq08wkuw02waqmn6yt1kdgej", name: "Connector connectivity issues", status: "INVESTIGATING", impact: "MAJOROUTAGE" }],
        },
      },
    });
    const incidents = await instatus.fetchIncidents({ baseUrl: "https://status.perplexity.com", provider: "instatus" });
    const active = incidents.find((i) => i.id === "cmq08wkuw02waqmn6yt1kdgej");
    // Still active in summary => impact upgraded from feed default "minor" to "critical".
    expect(active?.impact).toBe("critical");
    expect(active?.incident_updates).toHaveLength(3);
  });
});
