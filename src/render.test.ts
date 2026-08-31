import { describe, expect, test } from "bun:test";
import type { MonitorConfig } from "./config";
import { discordFormat } from "./platform/discord";
import { slackFormat } from "./platform/slack";
import type { Incident, IncidentUpdate } from "./providers/types";
import { renderMissingParentEmbed, renderStatusEmbed, renderUpdateEmbed } from "./render";

const monitor: MonitorConfig = {
  id: "example",
  channelId: "C123",
  baseUrl: "https://status.example.com",
  label: "Example",
};

const update: IncidentUpdate = {
  id: "u1",
  status: "investigating",
  // Deliberately contains every character Slack treats as markup.
  body: "Latency > 500ms on <api> & <web>.",
  created_at: "2026-01-02T03:04:05.000Z",
};

const incident: Incident = {
  id: "i1",
  name: "Elevated errors <api>",
  status: "investigating",
  impact: "major",
  shortlink: "https://status.example.com/incidents/i1",
  created_at: "2026-01-02T03:00:00.000Z",
  incident_updates: [update],
};

describe("renderUpdateEmbed", () => {
  test("escapes status page text for Slack", () => {
    const embed = renderUpdateEmbed(slackFormat, monitor, incident, update);
    expect(embed.description).toBe("Latency &gt; 500ms on &lt;api&gt; &amp; &lt;web&gt;.");
    expect(embed.title).toBe("Elevated errors &lt;api&gt;");
  });

  test("leaves status page text untouched for Discord", () => {
    const embed = renderUpdateEmbed(discordFormat, monitor, incident, update);
    expect(embed.description).toBe("Latency > 500ms on <api> & <web>.");
    expect(embed.title).toBe("Elevated errors <api>");
  });

  test("carries the update ID so replay can dedupe against posted messages", () => {
    const embed = renderUpdateEmbed(discordFormat, monitor, incident, update);
    expect(embed.fields?.find((field) => field.name === "ID")?.value).toBe("u1");
  });

  test("uses each platform's own timestamp markup", () => {
    const seconds = Math.floor(Date.parse(update.created_at) / 1000);
    const discord = renderUpdateEmbed(discordFormat, monitor, incident, update);
    const slack = renderUpdateEmbed(slackFormat, monitor, incident, update);
    expect(discord.fields?.find((f) => f.name === "Updated")?.value).toBe(`<t:${seconds}:f>`);
    expect(slack.fields?.find((f) => f.name === "Updated")?.value).toContain(`<!date^${seconds}^`);
  });
});

describe("renderMissingParentEmbed", () => {
  test("strikes the incident name with each platform's syntax", () => {
    expect(renderMissingParentEmbed(discordFormat, monitor, "Gone").title).toBe("~~Gone~~");
    expect(renderMissingParentEmbed(slackFormat, monitor, "Gone").title).toBe("~Gone~");
  });
});

describe("renderStatusEmbed", () => {
  const summary = {
    page: { id: "p1", name: "Example", url: "https://status.example.com" },
    status: { indicator: "major", description: "partial outage" },
    incidents: [incident],
  };

  test("bolds the overall status with each platform's syntax", () => {
    expect(renderStatusEmbed(discordFormat, monitor, summary).description).toBe(
      "Overall status: **Major Issues**",
    );
    expect(renderStatusEmbed(slackFormat, monitor, summary).description).toBe(
      "Overall status: *Major Issues*",
    );
  });

  test("links active incidents with each platform's syntax", () => {
    const discord = renderStatusEmbed(discordFormat, monitor, summary).fields?.[0].value ?? "";
    const slack = renderStatusEmbed(slackFormat, monitor, summary).fields?.[0].value ?? "";
    expect(discord).toContain("[Open incident](https://status.example.com/incidents/i1)");
    expect(slack).toContain("<https://status.example.com/incidents/i1|Open incident>");
  });
});
