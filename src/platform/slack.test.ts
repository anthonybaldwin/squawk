import { describe, expect, test } from "bun:test";
import type { Embed } from "../render";
import {
  fallbackText,
  parseCommandText,
  slackFormat,
  toSlackAttachment,
  tokenize,
  unwrapSlackLink,
} from "./slack";

describe("unwrapSlackLink", () => {
  test("unwraps auto-linked URLs", () => {
    expect(unwrapSlackLink("<https://status.example.com>")).toBe("https://status.example.com");
  });

  test("keeps the target of a labelled link", () => {
    expect(unwrapSlackLink("<https://status.example.com|Example>")).toBe(
      "https://status.example.com",
    );
  });

  test("unwraps channel and user mentions to their IDs", () => {
    expect(unwrapSlackLink("<#C123ABC|incidents>")).toBe("C123ABC");
    expect(unwrapSlackLink("<@U456DEF>")).toBe("U456DEF");
  });

  test("leaves bare tokens alone", () => {
    expect(unwrapSlackLink("atlassian")).toBe("atlassian");
  });
});

describe("tokenize", () => {
  test("keeps quoted values together", () => {
    expect(tokenize('monitor add https://x.dev label="Example Co"')).toEqual([
      "monitor",
      "add",
      "https://x.dev",
      "label=Example Co",
    ]);
  });
});

describe("parseCommandText", () => {
  test("maps a bare argument onto the command's first positional option", () => {
    const parsed = parseCommandText("status atlassian");
    expect(parsed.name).toBe("status");
    expect(parsed.options.get("target")).toBe("atlassian");
  });

  test("fills positional options in order", () => {
    const parsed = parseCommandText("clean atlassian 25");
    expect(parsed.options.get("target")).toBe("atlassian");
    expect(parsed.options.get("limit")).toBe("25");
  });

  test("accepts named options", () => {
    expect(parseCommandText("clean limit=25").options.get("limit")).toBe("25");
  });

  test("reads monitor subcommands", () => {
    const parsed = parseCommandText("monitor add <https://status.example.com> channel=<#C1|ops>");
    expect(parsed.name).toBe("monitor");
    expect(parsed.subcommand).toBe("add");
    expect(parsed.options.get("url")).toBe("https://status.example.com");
    expect(parsed.options.get("channel")).toBe("C1");
  });

  test("keeps quoted labels intact", () => {
    const parsed = parseCommandText('monitor add https://x.dev label="Example Co"');
    expect(parsed.options.get("label")).toBe("Example Co");
  });

  test("rejects an unknown option instead of silently consuming a positional", () => {
    expect(() => parseCommandText("status nope=1 atlassian")).toThrow(/Unknown option/);
  });

  test("treats a URL with a query string as a positional, not a named option", () => {
    const parsed = parseCommandText("monitor add https://status.example.com/page?a=b");
    expect(parsed.options.get("url")).toBe("https://status.example.com/page?a=b");
  });

  test("returns no command name for empty text so the caller can show help", () => {
    expect(parseCommandText("   ").name).toBeUndefined();
  });
});

describe("slackFormat", () => {
  test("escapes only Slack's reserved characters", () => {
    expect(slackFormat.escape("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  test("renders timestamps as client-localized dates", () => {
    const iso = "2026-01-02T03:04:05.000Z";
    const seconds = Math.floor(Date.parse(iso) / 1000);
    expect(slackFormat.timestamp(iso)).toBe(
      `<!date^${seconds}^{date_short_pretty} {time}|${iso}>`,
    );
  });

  test("returns a placeholder for a missing timestamp", () => {
    expect(slackFormat.timestamp(undefined)).toBe("unknown");
  });
});

const sampleEmbed: Embed = {
  color: 0xeb5757,
  author: { name: "Example Incident", iconUrl: "https://example.com/icon.png" },
  title: "Elevated error rates",
  url: "https://status.example.com/incidents/1",
  description: "We are investigating.",
  fields: [
    { name: "Status", value: "Investigating", inline: true },
    { name: "Impact", value: "Major", inline: true },
    { name: "Active Incidents", value: "One incident." },
  ],
  footer: { text: "https://status.example.com" },
};

describe("toSlackAttachment", () => {
  test("carries the embed color as the attachment accent", () => {
    expect(toSlackAttachment(sampleEmbed).color).toBe("#eb5757");
  });

  test("renders author, title, description, fields, and footer", () => {
    const blocks = toSlackAttachment(sampleEmbed).blocks ?? [];
    expect(blocks.map((block) => block.type)).toEqual([
      "context",
      "section",
      "section",
      "section",
      "section",
      "context",
    ]);
  });

  test("links the title when the embed has a URL", () => {
    const blocks = toSlackAttachment(sampleEmbed).blocks ?? [];
    const title = blocks[1] as { text: { text: string } };
    expect(title.text.text).toBe(
      "*<https://status.example.com/incidents/1|Elevated error rates>*",
    );
  });

  test("groups inline fields into a two-column field section", () => {
    const blocks = toSlackAttachment(sampleEmbed).blocks ?? [];
    const inlineSection = blocks[3] as { fields: { text: string }[] };
    expect(inlineSection.fields.map((field) => field.text)).toEqual([
      "*Status*\nInvestigating",
      "*Impact*\nMajor",
    ]);
  });

  test("chunks more than ten inline fields across sections", () => {
    const fields = Array.from({ length: 12 }, (_, index) => ({
      name: `F${index}`,
      value: `${index}`,
      inline: true,
    }));
    const blocks = toSlackAttachment({ color: 0, fields }).blocks ?? [];
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as { fields: unknown[] }).fields).toHaveLength(10);
    expect((blocks[1] as { fields: unknown[] }).fields).toHaveLength(2);
  });
});

describe("fallbackText", () => {
  test("joins author and title for the notification preview", () => {
    expect(fallbackText(sampleEmbed)).toBe("Example Incident — Elevated error rates");
  });

  test("falls back when the embed has neither", () => {
    expect(fallbackText({ color: 0 })).toBe("Status update");
  });
});
