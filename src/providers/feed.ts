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

/**
 * Build a canonical Incident from an entry's parsed parts. Resolved is terminal:
 * any resolved update marks the incident resolved, independent of feed ordering.
 */
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
    const entryId = id || shortlink || name;
    const updates = parseFeedUpdates(content, entryId, published);
    return assembleIncident(entryId, name, shortlink, published, updated, updates);
  });

  return { page, incidents };
}

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
    const entryId = id || shortlink || name;
    const updates = parseFeedUpdates(description, entryId, pubIso);
    return assembleIncident(entryId, name, shortlink, pubIso, pubIso, updates);
  });

  return { page, incidents };
}

/**
 * Synthesize a page-level status. Feeds have no operational indicator and always
 * list past (resolved) incidents, so the page is operational unless something is
 * still active. Impact is unknown, so active pages report a generic "minor".
 */
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
