import type {
  Incident,
  IncidentUpdate,
  PageStatus,
  Provider,
  ProviderMonitor,
  Summary,
} from "./types";

/** Lowercase + strip non-alphanumerics so "In progress" and "INPROGRESS" match. */
function normKey(raw: string | undefined): string {
  return String(raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

export function canonicalIncidentStatus(raw: string | undefined): string {
  switch (normKey(raw)) {
    case "investigating":
      return "investigating";
    case "identified":
      return "identified";
    case "monitoring":
      return "monitoring";
    case "resolved":
      return "resolved";
    default:
      return "investigating";
  }
}

export function canonicalMaintenanceStatus(raw: string | undefined): string {
  switch (normKey(raw)) {
    case "notstartedyet":
    case "scheduled":
      return "scheduled";
    case "inprogress":
    case "verifying":
    case "identified":
      return "in_progress";
    case "completed":
    case "resolved":
      return "resolved";
    default:
      return "in_progress";
  }
}

export function canonicalImpact(raw: string | undefined): string {
  switch (normKey(raw)) {
    case "":
    case "operational":
    case "none":
    case "up":
      return "none";
    case "minoroutage":
    case "degradedperformance":
    case "minor":
      return "minor";
    case "partialoutage":
    case "major":
      return "major";
    case "majoroutage":
    case "critical":
      return "critical";
    default:
      return "minor";
  }
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse an Instatus feed `<small>` timestamp like "Jun  5, 01:40:38 GMT+0"
 * (no year) into an ISO-8601 UTC string. The year is taken from `anchorIso`;
 * if the resulting date lands before `anchorIso` (beyond a small grace
 * window), it belongs to the following year (entry spanning a year boundary).
 *
 * `anchorIso` MUST be a lower bound on the entry's updates — see
 * `entryAnchor()`. Anchoring on `<published>` alone is wrong for scheduled
 * maintenance, where `<published>` is the scheduled start and the announcement
 * update legitimately precedes it.
 */
export function parseUpdateTimestamp(small: string, anchorIso: string): string | null {
  const m = small.match(/([A-Za-z]{3})\s+(\d{1,2})\s*,\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(m[2]);
  const hour = Number(m[3]);
  const min = Number(m[4]);
  const sec = Number(m[5]);

  const anchor = new Date(anchorIso);
  const year = Number.isNaN(anchor.getTime()) ? new Date(0).getUTCFullYear() : anchor.getUTCFullYear();

  let date = new Date(Date.UTC(year, month, day, hour, min, sec));
  // The feed omits the year, so an update that lands before `anchor` (with a
  // ~24h grace window for rounding) must belong to the following year (Dec→Jan).
  if (!Number.isNaN(anchor.getTime()) && date.getTime() < anchor.getTime() - 24 * 3600 * 1000) {
    date = new Date(Date.UTC(year + 1, month, day, hour, min, sec));
  }
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Decode the handful of XML/HTML entities that appear in Instatus feeds. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Strip all tags and collapse whitespace; trim a single duplicate trailing period. */
function plainText(html: string): string {
  const text = decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  // Instatus appends a period to update bodies that already end in one, yielding "..".
  return text.replace(/\.\.$/, ".");
}

function firstMatch(source: string, re: RegExp): string | undefined {
  const m = source.match(re);
  return m ? m[1] : undefined;
}

/**
 * Lower bound for an entry's update timestamps, used to resolve the year the
 * feed omits. `<published>` is NOT that bound on its own: for a scheduled
 * maintenance it is the scheduled start, while the announcement update can be
 * days or weeks earlier (`<updated>` carries that announcement time). Taking
 * the earlier of the two keeps early announcements in their real year — dating
 * one a year ahead makes it sort last, so the entry's derived status comes from
 * the announcement instead of the final "Completed" and the incident never
 * looks resolved.
 */
function entryAnchor(published: string, updated: string | undefined): string {
  const publishedMs = new Date(published).getTime();
  const updatedMs = updated === undefined ? NaN : new Date(updated).getTime();
  if (Number.isNaN(updatedMs)) return published;
  if (Number.isNaN(publishedMs)) return updated as string;
  return updatedMs < publishedMs ? (updated as string) : published;
}

type ParsedUpdate = { status: string; body: string; created_at: string };

/**
 * Parse one entry's `<content>` HTML into ordered updates. Update blocks are the
 * `<p>` blocks that contain a `<small>` timestamp, a `<br>`, and a
 * `<strong>STATUS</strong> -` marker. Header blocks (`<strong>Type:</strong> …`)
 * are skipped because their `<strong>` text ends in a colon.
 */
function parseUpdateBlocks(content: string, anchorIso: string, isMaintenance: boolean): ParsedUpdate[] {
  const updates: ParsedUpdate[] = [];
  const blockRe = /<p>\s*<small>([\s\S]*?)<\/small>\s*<br\s*\/?>\s*<strong>([^<]+)<\/strong>\s*-\s*([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(content)) !== null) {
    const small = plainText(m[1]);
    const statusWord = m[2].trim();
    if (statusWord.endsWith(":")) continue; // header block, not an update
    const created = parseUpdateTimestamp(small, anchorIso) ?? anchorIso;
    const status = isMaintenance
      ? canonicalMaintenanceStatus(statusWord)
      : canonicalIncidentStatus(statusWord);
    updates.push({ status, body: plainText(m[3]) || "No message provided.", created_at: created });
  }
  updates.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return updates;
}

/** Parse a full `/history.atom` document into canonical incidents. */
export function parseInstatusAtom(xml: string): Incident[] {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  const incidents: Incident[] = [];

  for (const entry of entries) {
    const rawId = firstMatch(entry, /<id>([\s\S]*?)<\/id>/) ?? "";
    const id = (rawId.match(/\/([A-Za-z0-9]+)\s*$/)?.[1]) ?? rawId;
    const name = decodeEntities(firstMatch(entry, /<title>([\s\S]*?)<\/title>/)?.trim() ?? "Untitled incident");
    const published = firstMatch(entry, /<published>([\s\S]*?)<\/published>/)?.trim()
      ?? new Date(0).toISOString();
    const updated = firstMatch(entry, /<updated>([\s\S]*?)<\/updated>/)?.trim();
    const anchor = entryAnchor(published, updated);
    const shortlink = firstMatch(entry, /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/);

    const contentRaw = firstMatch(entry, /<content[^>]*>([\s\S]*?)<\/content>/) ?? "";
    const content = contentRaw.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");
    const typeField = firstMatch(content, /<strong>\s*Type:\s*<\/strong>\s*([A-Za-z]+)/);
    const isMaintenance = (typeField ?? "").toLowerCase() === "maintenance";

    const updates = parseUpdateBlocks(content, anchor, isMaintenance);
    const mappedUpdates: IncidentUpdate[] = updates.map((u) => ({
      id: `${id}:${u.created_at}`,
      status: u.status,
      body: u.body,
      created_at: u.created_at,
      updated_at: u.created_at,
    }));

    const latest = mappedUpdates[mappedUpdates.length - 1];
    const status = latest?.status ?? (isMaintenance ? "scheduled" : "investigating");
    const createdAt = mappedUpdates[0]?.created_at ?? published;
    const resolvedAt = status === "resolved"
      ? (latest?.created_at ?? null)
      : null;

    incidents.push({
      id,
      name,
      status,
      impact: isMaintenance ? "maintenance" : "minor",
      shortlink,
      created_at: createdAt,
      updated_at: latest?.created_at ?? createdAt,
      resolved_at: resolvedAt,
      incident_updates: mappedUpdates,
    });
  }

  return incidents;
}

export type InstatusActiveIncident = {
  id: string;
  name: string;
  started?: string;
  status?: string;
  impact?: string;
  url?: string;
  updatedAt?: string;
};

export type InstatusActiveMaintenance = {
  id: string;
  name: string;
  start?: string;
  status?: string;
  duration?: string;
  url?: string;
  updatedAt?: string;
};

export type InstatusSummaryJson = {
  page?: { name?: string; url?: string; status?: string };
  activeIncidents?: InstatusActiveIncident[];
  activeMaintenances?: InstatusActiveMaintenance[];
};

const IMPACT_RANK: Record<string, number> = { none: 0, minor: 1, major: 2, critical: 3 };

function worstImpact(impacts: string[]): string {
  let best = "none";
  for (const impact of impacts) {
    if ((IMPACT_RANK[impact] ?? 0) > (IMPACT_RANK[best] ?? 0)) best = impact;
  }
  return best;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

/** Derive the page-level PageStatus from `page.status` + the active impacts. */
export function instatusPageStatus(pageStatus: string | undefined, activeImpacts: string[]): PageStatus {
  switch (normKey(pageStatus)) {
    case "up":
      return { indicator: "none", description: "All Systems Operational" };
    case "undermaintenance":
      return { indicator: "maintenance", description: "Under Maintenance" };
    default: {
      const worst = worstImpact(activeImpacts.length ? activeImpacts : ["minor"]);
      const description =
        worst === "critical" ? "Critical Outage"
        : worst === "major" ? "Major Outage"
        : worst === "minor" ? "Minor Issues"
        : "Issues Detected";
      return { indicator: worst === "none" ? "minor" : worst, description };
    }
  }
}

function activeIncidentToCanonical(raw: InstatusActiveIncident): Incident {
  const impact = canonicalImpact(raw.impact);
  const status = canonicalIncidentStatus(raw.status);
  const createdAt = raw.started ?? raw.updatedAt ?? new Date(0).toISOString();
  return {
    id: raw.id,
    name: raw.name,
    status,
    impact,
    shortlink: raw.url,
    created_at: createdAt,
    updated_at: raw.updatedAt ?? createdAt,
    resolved_at: null,
    incident_updates: [
      {
        id: `${raw.id}:${raw.updatedAt ?? createdAt}`,
        status,
        body: raw.name,
        created_at: raw.updatedAt ?? createdAt,
        updated_at: raw.updatedAt ?? createdAt,
      },
    ],
  };
}

function activeMaintenanceToCanonical(raw: InstatusActiveMaintenance): Incident {
  const status = canonicalMaintenanceStatus(raw.status);
  const createdAt = raw.start ?? raw.updatedAt ?? new Date(0).toISOString();
  return {
    id: raw.id,
    name: raw.name,
    status,
    impact: "maintenance",
    shortlink: raw.url,
    created_at: createdAt,
    updated_at: raw.updatedAt ?? createdAt,
    resolved_at: status === "resolved" ? (raw.updatedAt ?? createdAt) : null,
    incident_updates: [
      {
        id: `${raw.id}:${raw.updatedAt ?? createdAt}`,
        status,
        body: raw.name,
        created_at: raw.updatedAt ?? createdAt,
        updated_at: raw.updatedAt ?? createdAt,
      },
    ],
  };
}

/** Map `/v3/summary.json` into a canonical Summary (active incidents + maintenances). */
export function mapInstatusSummary(json: InstatusSummaryJson, baseUrl: string): Summary {
  const incidents = (json.activeIncidents ?? []).map(activeIncidentToCanonical);
  const maintenances = (json.activeMaintenances ?? []).map(activeMaintenanceToCanonical);
  const all = [...incidents, ...maintenances];
  const activeImpacts = all.map((i) => i.impact).filter((i) => i !== "maintenance");
  return {
    page: {
      id: hostOf(baseUrl),
      name: json.page?.name ?? "Instatus status page",
      url: json.page?.url ?? baseUrl,
    },
    status: instatusPageStatus(json.page?.status, activeImpacts),
    incidents: all,
  };
}

/** Map of active incident id -> canonical impact, for enriching feed incidents. */
export function activeImpactById(json: InstatusSummaryJson): Map<string, string> {
  const map = new Map<string, string>();
  for (const inc of json.activeIncidents ?? []) {
    map.set(inc.id, canonicalImpact(inc.impact));
  }
  return map;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { Accept: "application/atom+xml, application/json" } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Instatus request failed (${response.status}): ${body}`);
  }
  return response.text();
}

async function fetchSummaryJson(baseUrl: string): Promise<InstatusSummaryJson> {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${trimmed}/v3/summary.json`, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Instatus request failed (${response.status}): ${body}`);
  }
  return (await response.json()) as InstatusSummaryJson;
}

/** True only for genuine Instatus summaries (page.status enum, no Statuspage shape). */
function isInstatusSummary(json: unknown): json is InstatusSummaryJson {
  if (!json || typeof json !== "object") return false;
  const obj = json as Record<string, unknown>;
  const page = obj.page as Record<string, unknown> | undefined;
  if (!page || typeof page.url !== "string" || typeof page.name !== "string") return false;
  if (typeof page.status !== "string") return false; // Instatus has page.status; Statuspage does not.
  if (page.id !== undefined) return false; // Statuspage page has an id; Instatus does not.
  if (obj.status && typeof obj.status === "object") return false; // Statuspage top-level status object.
  return true;
}

export const instatus: Provider = {
  id: "instatus",
  displayName: "Instatus",

  async probe(baseUrl) {
    try {
      const json = await fetchSummaryJson(baseUrl);
      if (!isInstatusSummary(json)) return null;
      const summary = mapInstatusSummary(json, baseUrl);
      return { page: summary.page, status: summary.status };
    } catch {
      return null;
    }
  },

  async fetchSummary(monitor: ProviderMonitor): Promise<Summary> {
    const json = await fetchSummaryJson(monitor.baseUrl);
    return mapInstatusSummary(json, monitor.baseUrl);
  },

  async fetchIncidents(monitor: ProviderMonitor): Promise<Incident[]> {
    const trimmed = monitor.baseUrl.replace(/\/+$/, "");
    const xml = await fetchText(`${trimmed}/history.atom`);
    const incidents = parseInstatusAtom(xml);

    // Join live impact: the Atom feed has no impact enum, so for incidents still
    // active in summary.json, stamp the real impact over the feed's default.
    try {
      const summaryJson = await fetchSummaryJson(monitor.baseUrl);
      const impacts = activeImpactById(summaryJson);
      for (const incident of incidents) {
        const live = impacts.get(incident.id);
        if (live && incident.impact !== "maintenance") incident.impact = live;
      }
    } catch {
      // Non-fatal; feed-derived impact stands.
    }
    return incidents;
  },
};
