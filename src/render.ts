/**
 * Platform-neutral message rendering.
 *
 * Render functions produce an {@link Embed} — a structural description of a
 * message — plus lightweight inline markup produced through a {@link TextFormat}
 * supplied by the active platform adapter. The adapter turns an `Embed` into a
 * Discord embed or a Slack Block Kit attachment, and `TextFormat` into Discord
 * markdown or Slack mrkdwn.
 *
 * Text that originates from a status page (incident names, update bodies, page
 * descriptions) is passed through `fmt.escape()` so platforms with reserved
 * characters — Slack's `&`, `<`, `>` — render it literally. Markup we generate
 * ourselves is never escaped.
 */

import type { MonitorConfig } from "./config";
import { monitorIcons } from "./icons";
import type { Incident, IncidentUpdate, Summary } from "./providers/types";

export type EmbedField = {
  name: string;
  value: string;
  inline?: boolean;
};

export type Embed = {
  color: number;
  author?: { name: string; iconUrl?: string; url?: string };
  title?: string;
  url?: string;
  description?: string;
  fields?: EmbedField[];
  footer?: { text: string };
};

/** Inline markup primitives, implemented per platform. */
export type TextFormat = {
  /** Escape status-page text so platform markup characters render literally. */
  escape(text: string): string;
  bold(text: string): string;
  strike(text: string): string;
  inlineCode(text: string): string;
  link(url: string, text: string): string;
  /** Render an ISO timestamp as a client-localized absolute time. */
  timestamp(value?: string | null): string;
  channel(channelId: string): string;
  user(userId: string): string;
  /** De-emphasized helper text. */
  subtext(text: string): string;
};

export function statusColor(status: string) {
  switch (status.toLowerCase()) {
    case "resolved":
    case "postmortem":
    case "operational":
    case "none":
      return 0x2fb344;
    case "identified":
      return 0xf2c94c;
    case "monitoring":
      return 0x6aa9ff;
    case "investigating":
    case "update":
    case "minor":
    case "degraded_performance":
      return 0xf2994a;
    case "partial_outage":
    case "major":
    case "critical":
    case "major_outage":
      return 0xeb5757;
    case "under_maintenance":
      return 0x8e8e93;
    case "maintenance":
      return 0x7f8c8d;
    default:
      return 0x5865f2;
  }
}

export function impactColor(impact: string, status?: string) {
  if (status?.toLowerCase() === "resolved" || status?.toLowerCase() === "postmortem") {
    return 0x2fb344;
  }

  switch (impact.toLowerCase()) {
    case "none":
      return 0x6aa9ff;
    case "minor":
      return 0xf2c94c;
    case "major":
      return 0xf2994a;
    case "critical":
      return 0xeb5757;
    case "maintenance":
    case "under_maintenance":
      return 0x7f8c8d;
    default:
      return 0x5865f2;
  }
}

export const MISSING_INCIDENT_COLOR = 0x95a5a6;
export const RESOLVED_COLOR = 0x2fb344;
export const NEUTRAL_COLOR = 0x5865f2;

export function incidentStateLabel(status: string) {
  switch (status.toLowerCase()) {
    case "investigating":
      return "Investigating";
    case "identified":
      return "Identified";
    case "monitoring":
      return "Monitoring";
    case "resolved":
      return "Resolved";
    case "update":
      return "Update";
    default:
      return titleCase(status);
  }
}

export function statusLabel(indicator: string) {
  switch (indicator.toLowerCase()) {
    case "none":
      return "Operational";
    case "minor":
      return "Minor Issues";
    case "major":
      return "Major Issues";
    case "critical":
      return "Critical";
    case "maintenance":
    case "under_maintenance":
      return "Under Maintenance";
    default:
      return titleCase(indicator);
  }
}

export function titleCase(value: string) {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

export function monitorDisplayName(monitor: MonitorConfig, pageName?: string) {
  return monitor.label ?? pageName ?? monitor.id;
}

export function byNewestUpdate(a: IncidentUpdate, b: IncidentUpdate) {
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
}

export function renderUpdateEmbed(
  fmt: TextFormat,
  monitor: MonitorConfig,
  incident: Incident,
  update: IncidentUpdate,
): Embed {
  return {
    color: impactColor(incident.impact, update.status),
    author: {
      name: `${monitorDisplayName(monitor)} Incident Update`,
      iconUrl: monitorIcons.get(monitor.id),
    },
    title: fmt.escape(incident.name),
    url: incident.shortlink,
    description: fmt.escape(truncate(update.body, 4000)),
    fields: [
      { name: "Status", value: incidentStateLabel(update.status), inline: true },
      { name: "Impact", value: titleCase(incident.impact), inline: true },
      { name: "Updated", value: fmt.timestamp(update.created_at), inline: true },
      { name: "ID", value: update.id, inline: true },
    ],
  };
}

export function renderParentEmbed(
  fmt: TextFormat,
  monitor: MonitorConfig,
  incident: Incident,
): Embed {
  const latest = [...incident.incident_updates].sort(byNewestUpdate)[0];
  const threadNote = fmt.subtext(
    incident.resolved_at
      ? "This incident has been resolved. Open the thread for the full timeline."
      : "Open the thread for the full timeline and follow-up updates.",
  );
  const latestBody = latest ? fmt.escape(truncate(latest.body, 3900)) : "";
  const description = latestBody ? `${latestBody}\n\n${threadNote}` : threadNote;

  return {
    color: impactColor(incident.impact, incident.status),
    author: {
      name: `${monitorDisplayName(monitor)} Incident`,
      iconUrl: monitorIcons.get(monitor.id),
    },
    title: fmt.escape(incident.name),
    url: incident.shortlink,
    description,
    fields: [
      { name: "Status", value: titleCase(incident.status), inline: true },
      { name: "Impact", value: titleCase(incident.impact), inline: true },
      { name: "Created", value: fmt.timestamp(incident.created_at), inline: true },
      {
        name: "Latest Update",
        value: latest ? fmt.timestamp(latest.created_at) : "unknown",
        inline: true,
      },
    ],
  };
}

export function renderMissingParentEmbed(
  fmt: TextFormat,
  monitor: MonitorConfig,
  incidentName: string,
): Embed {
  return {
    color: MISSING_INCIDENT_COLOR,
    author: {
      name: `${monitorDisplayName(monitor)} Incident`,
      iconUrl: monitorIcons.get(monitor.id),
    },
    title: fmt.strike(fmt.escape(incidentName)),
    description: "This incident is no longer available on the status page.",
    fields: [{ name: "Status", value: "Removed", inline: true }],
  };
}

function summaryFields(fmt: TextFormat, summary: Summary): EmbedField[] {
  const active = summary.incidents.filter((incident) => !incident.resolved_at);

  if (active.length === 0) {
    return [
      {
        name: "Active Incidents",
        value: "No active incidents.",
      },
    ];
  }

  return active.slice(0, 10).map((incident) => {
    const latest = [...incident.incident_updates].sort(byNewestUpdate)[0];
    const parts = [
      `Status: ${titleCase(incident.status)}`,
      `Impact: ${titleCase(incident.impact)}`,
      `Created: ${fmt.timestamp(incident.created_at)}`,
    ];

    if (latest) {
      parts.push(`Latest: ${fmt.timestamp(latest.created_at)}`);
    }

    if (incident.shortlink) {
      parts.push(fmt.link(incident.shortlink, "Open incident"));
    }

    return {
      name: fmt.escape(incident.name),
      value: truncate(parts.join("\n"), 1024),
    };
  });
}

export function renderStatusEmbed(
  fmt: TextFormat,
  monitor: MonitorConfig,
  summary: Summary,
  prefix?: string,
): Embed {
  const name = monitorDisplayName(monitor, summary.page.name);

  return {
    color: statusColor(summary.status.indicator),
    author: {
      name: prefix ? `${prefix} • ${name}` : name,
      url: summary.page.url,
      iconUrl: monitorIcons.get(monitor.id),
    },
    title: fmt.escape(titleCase(summary.status.description)),
    description: `Overall status: ${fmt.bold(statusLabel(summary.status.indicator))}`,
    fields: summaryFields(fmt, summary),
    footer: { text: summary.page.url },
  };
}

export function renderMonitorAddedEmbed(
  fmt: TextFormat,
  monitor: MonitorConfig,
  summary: Summary,
): Embed {
  return {
    color: statusColor(summary.status.indicator),
    author: {
      name: "Monitor Added",
      iconUrl: monitorIcons.get(monitor.id),
    },
    title: fmt.escape(monitorDisplayName(monitor, summary.page.name)),
    fields: [
      { name: "ID", value: fmt.inlineCode(monitor.id), inline: true },
      { name: "URL", value: monitor.baseUrl, inline: true },
      { name: "Channel", value: fmt.channel(monitor.channelId), inline: true },
      { name: "Status", value: statusLabel(summary.status.indicator), inline: true },
    ],
  };
}

/** Discord caps embeds at 25 fields; Slack at 50 blocks per attachment. */
const MAX_LISTED_MONITORS = 25;

export function renderMonitorListEmbed(
  fmt: TextFormat,
  monitors: MonitorConfig[],
  isEnvMonitor: (id: string) => boolean,
  runtimeMeta: Map<string, { addedBy: string; addedAt: string }>,
): Embed {
  const listed = monitors.slice(0, MAX_LISTED_MONITORS);
  const overflow = monitors.length - listed.length;

  return {
    color: NEUTRAL_COLOR,
    title: "Configured Monitors",
    footer:
      overflow > 0
        ? { text: `+${overflow} more monitor${overflow === 1 ? "" : "s"} not shown.` }
        : undefined,
    fields: listed.map((monitor) => {
      const isEnv = isEnvMonitor(monitor.id);
      const lines = [
        `${fmt.bold("Source:")} ${fmt.inlineCode(isEnv ? "env" : "runtime")}`,
        `${fmt.bold("URL:")} ${monitor.baseUrl}`,
        `${fmt.bold("Channel:")} ${fmt.channel(monitor.channelId)}`,
      ];

      if (!isEnv) {
        const runtime = runtimeMeta.get(monitor.id);
        if (runtime) {
          lines.push(`${fmt.bold("Added by:")} ${fmt.user(runtime.addedBy)}`);
          lines.push(`${fmt.bold("Added:")} ${fmt.timestamp(runtime.addedAt)}`);
        }
      }

      return {
        name: `${fmt.escape(monitorDisplayName(monitor))} (${fmt.inlineCode(monitor.id)})`,
        value: lines.join("\n"),
      };
    }),
  };
}
